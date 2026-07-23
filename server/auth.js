import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

export const COOKIE_NAME = "rt";

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

export async function exchangeRefreshToken(
  refreshToken,
  { clientId, clientSecret },
) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

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
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`AUTH_CODE_EXCHANGE_FAILED:${response.status}`);
  }

  const data = await response.json();
  if (!data.refresh_token) {
    throw new Error("AUTH_CODE_EXCHANGE_FAILED:no_refresh_token");
  }
  return { refreshToken: data.refresh_token };
}
