import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const OAUTH_SCOPE =
  "user-read-currently-playing user-modify-playback-state user-follow-read";

export const COOKIE_NAME = "rt";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

// One-time CSRF state for the OAuth flow: minted by /api/login, verified and
// cleared by /api/callback. Short-lived — it only needs to survive the round
// trip through Spotify's consent screen.
export const STATE_COOKIE_NAME = "oauth_state";
const STATE_COOKIE_MAX_AGE = 10 * 60; // 10 minutes, in seconds

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const b64 = process.env.COOKIE_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error("COOKIE_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return key;
}

export function sealToken(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

export function openToken(sealed) {
  const key = getKey();
  const data = Buffer.from(sealed, "base64url");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// The sealed payload carries its own issue time so the 30-day session
// lifetime is enforced server-side; the cookie's Max-Age alone is
// client-enforced and a captured sealed value would otherwise replay forever.
const SESSION_MAX_AGE_MS = COOKIE_MAX_AGE * 1000;

export function sealSession(refreshToken, now = Date.now()) {
  return sealToken(JSON.stringify({ rt: refreshToken, iat: now }));
}

export function openSession(sealed, now = Date.now()) {
  const payload = JSON.parse(openToken(sealed));
  if (typeof payload?.rt !== "string" || typeof payload?.iat !== "number") {
    throw new Error("SESSION_INVALID");
  }
  if (now - payload.iat > SESSION_MAX_AGE_MS) {
    throw new Error("SESSION_EXPIRED");
  }
  return payload.rt;
}

function cookieAttrs(nameValue, maxAge, secure) {
  const attrs = [
    nameValue,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildSessionCookie(sealed, { secure }) {
  return cookieAttrs(`${COOKIE_NAME}=${sealed}`, COOKIE_MAX_AGE, secure);
}

export function clearSessionCookie({ secure }) {
  return cookieAttrs(`${COOKIE_NAME}=`, 0, secure);
}

export function buildStateCookie(state, { secure }) {
  return cookieAttrs(
    `${STATE_COOKIE_NAME}=${state}`,
    STATE_COOKIE_MAX_AGE,
    secure,
  );
}

export function clearStateCookie({ secure }) {
  return cookieAttrs(`${STATE_COOKIE_NAME}=`, 0, secure);
}

export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    state,
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params}`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

async function postTokenRequest(params, { clientId, clientSecret }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  return fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
}

export async function exchangeRefreshToken(
  refreshToken,
  { clientId, clientSecret },
) {
  const response = await postTokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { clientId, clientSecret },
  );

  if (!response.ok) {
    throw new Error(`REFRESH_FAILED:${response.status}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token ?? refreshToken,
  };
}

export async function exchangeAuthCode(
  code,
  { clientId, clientSecret, redirectUri },
) {
  const response = await postTokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    { clientId, clientSecret },
  );

  if (!response.ok) {
    throw new Error(`AUTH_CODE_EXCHANGE_FAILED:${response.status}`);
  }

  const data = await response.json();
  if (!data.refresh_token) {
    throw new Error("AUTH_CODE_EXCHANGE_FAILED:no_refresh_token");
  }
  return { refreshToken: data.refresh_token };
}

export async function createSession(
  code,
  { clientId, clientSecret, redirectUri, secure },
) {
  const { refreshToken } = await exchangeAuthCode(code, {
    clientId,
    clientSecret,
    redirectUri,
  });
  return { cookie: buildSessionCookie(sealSession(refreshToken), { secure }) };
}

export async function refreshSession(
  sealed,
  { clientId, clientSecret, secure },
) {
  const refreshToken = openSession(sealed); // throws on tamper/invalid/expired
  const result = await exchangeRefreshToken(refreshToken, {
    clientId,
    clientSecret,
  });
  const rotated = result.refreshToken !== refreshToken;
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    cookie: rotated
      ? buildSessionCookie(sealSession(result.refreshToken), { secure })
      : null,
  };
}
