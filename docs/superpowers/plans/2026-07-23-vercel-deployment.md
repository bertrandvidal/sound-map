# Vercel Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy sound-map to Vercel as a static SPA + two serverless `/api` functions, storing the Spotify refresh token in an AES-256-GCM–sealed httpOnly cookie, while keeping the local `npm start` dev loop working unchanged.

**Architecture:** One framework-agnostic core (`server/auth.js`) holds all auth + crypto logic. Two thin transport adapters delegate to it: Express (`server/app.js`, local) and Vercel functions (`api/callback.js`, `api/refresh.js`, prod). The in-memory `sessions` Map is deleted; both adapters now store the same sealed refresh token in a cookie.

**Tech Stack:** Node built-in `crypto` (AES-256-GCM, no new dependency), Express (local only), Vercel serverless functions (prod), Vite build output (`dist/`), Vitest + supertest for tests.

## Design clarifications (locked during review — read before starting)

Two points the spec left implicit are now explicit and MUST be implemented as written:

1. **The cookie is NOT byte-identical across environments — only its non-security attributes are.**
   Local dev runs over **http** on `127.0.0.1`, where a browser drops `Secure` cookies. Production runs over **https**. Therefore `buildSessionCookie(sealed, { secure })` takes a **`secure` flag**: the local adapter passes `secure: false`, the prod adapters pass `secure: true`. Every other attribute (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`) is identical and centralized in the core.

2. **The cookie name is unified to `rt`; the old `sid` name and the session Map are retired together.**
   Today the local cookie is `sid` — an opaque key into an in-memory `sessions` Map. That Map cannot survive serverless, so the spec deletes it. Once deleted, `sid` (a *session id*) is meaningless; there is no store to look up. Both adapters now put the **sealed refresh token itself** into a cookie named **`rt`**. One name, one mechanism, both environments. `COOKIE_NAME = "rt"` is exported from the core so no adapter hardcodes the string.

## Global Constraints

- **No new runtime dependencies.** Crypto uses Node's built-in `node:crypto`. (`supertest` is already a devDependency.)
- **`COOKIE_ENCRYPTION_KEY`** is a base64 string that decodes to **exactly 32 bytes** (`openssl rand -base64 32`). A missing/wrong-length key must throw a clear error.
- **Cookie attributes:** `rt=<sealed>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` and `Secure` **only** when `secure: true`. Clearing cookie uses `Max-Age=0`.
- **Sealed-token encoding:** `base64url` of `Buffer.concat([iv(12), authTag(16), ciphertext])`. `base64url` avoids `+ / =` so the value is cookie-safe without extra encoding.
- **`server/auth.js` is held to the strict per-file coverage bar** in `vite.config.js` (statements 90, branches 75, functions 100). Every branch you add needs a test.
- **Local defaults unchanged:** `REDIRECT_URI` default `http://127.0.0.1:3000/callback`, `FRONTEND_URL` default `http://127.0.0.1:5173`. Env vars override.
- **Commits:** follow `~/.git-template.txt` — Why / How / Tests sections. Branch `vercel-deployment` already exists and is rebased on `main`; commit onto it.
- **Biome must pass** (`npx biome check .`). Run `npx biome check --write <files>` before committing if the pre-commit hook complains.

---

### Task 1: Core crypto — seal/open the refresh token

**Files:**
- Modify: `server/auth.js` (add key helper, `sealToken`, `openToken`, `COOKIE_NAME`)
- Test: `server/__tests__/auth.test.js` (add a `describe` block)

**Interfaces:**
- Consumes: nothing new (uses `node:crypto`).
- Produces:
  - `COOKIE_NAME: "rt"` (exported const)
  - `sealToken(plaintext: string): string` — base64url sealed blob
  - `openToken(sealed: string): string` — plaintext; **throws** on tamper, wrong key, or malformed input

- [ ] **Step 1: Write failing tests**

Add to `server/__tests__/auth.test.js`:

```javascript
import { COOKIE_NAME, openToken, sealToken } from "../auth.js";

describe("sealToken / openToken", () => {
  beforeEach(() => {
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a plaintext token", () => {
    const sealed = sealToken("refresh-abc");
    expect(sealed).not.toContain("refresh-abc");
    expect(openToken(sealed)).toBe("refresh-abc");
  });

  it("produces a different sealed blob each call (random IV)", () => {
    expect(sealToken("same")).not.toBe(sealToken("same"));
  });

  it("throws when the ciphertext is tampered with", () => {
    const sealed = sealToken("refresh-abc");
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] ^= 0xff; // flip last byte of ciphertext
    const tampered = bytes.toString("base64url");
    expect(() => openToken(tampered)).toThrow();
  });

  it("throws when opened with a different key", () => {
    const sealed = sealToken("refresh-abc");
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => openToken(sealed)).toThrow();
  });

  it("throws when the key is missing", () => {
    process.env.COOKIE_ENCRYPTION_KEY = "";
    expect(() => sealToken("x")).toThrow(/COOKIE_ENCRYPTION_KEY/);
  });

  it("throws when the key does not decode to 32 bytes", () => {
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => sealToken("x")).toThrow(/32 bytes/);
  });

  it("exposes the unified cookie name", () => {
    expect(COOKIE_NAME).toBe("rt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: FAIL — `sealToken`/`openToken`/`COOKIE_NAME` are not exported.

- [ ] **Step 3: Implement in `server/auth.js`**

Add the crypto import at the top (keep the existing `SPOTIFY_TOKEN_URL` line):

```javascript
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: PASS (all sealToken/openToken tests green).

- [ ] **Step 5: Commit**

```bash
npx biome check --write server/auth.js server/__tests__/auth.test.js
git add server/auth.js server/__tests__/auth.test.js
git commit
```
Commit message — Why: refresh tokens must be stored client-side (no serverless-safe store) without exposing them; How: AES-256-GCM seal/open via Node crypto keyed by COOKIE_ENCRYPTION_KEY, base64url blob = iv+authTag+ciphertext; Tests: round-trip, random-IV, tamper→throw, wrong-key→throw, missing/short-key→throw.

---

### Task 2: Core — lift `exchangeAuthCode` out of the adapter

**Files:**
- Modify: `server/auth.js` (add `exchangeAuthCode`)
- Test: `server/__tests__/auth.test.js` (add a `describe` block)

**Interfaces:**
- Consumes: existing `SPOTIFY_TOKEN_URL`.
- Produces: `exchangeAuthCode(code: string, { clientId, clientSecret, redirectUri }): Promise<{ refreshToken: string }>` — throws `AUTH_CODE_EXCHANGE_FAILED:<reason>` on non-200 or missing refresh token.

- [ ] **Step 1: Write failing tests**

Add to `server/__tests__/auth.test.js`:

```javascript
import { exchangeAuthCode } from "../auth.js";

describe("exchangeAuthCode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const CREDS = {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1:3000/callback",
  };

  it("returns the refresh token on a Spotify 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const result = await exchangeAuthCode("auth-code", CREDS);
    expect(result).toEqual({ refreshToken: "refresh-abc" });
  });

  it("throws when Spotify returns a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    await expect(exchangeAuthCode("bad", CREDS)).rejects.toThrow(
      "AUTH_CODE_EXCHANGE_FAILED:400",
    );
  });

  it("throws when the response has no refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "only-access" }),
      }),
    );
    await expect(exchangeAuthCode("code", CREDS)).rejects.toThrow(
      "AUTH_CODE_EXCHANGE_FAILED:no_refresh_token",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: FAIL — `exchangeAuthCode` is not exported.

- [ ] **Step 3: Implement in `server/auth.js`**

Add below `exchangeRefreshToken`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write server/auth.js server/__tests__/auth.test.js
git add server/auth.js server/__tests__/auth.test.js
git commit
```
Why: the auth-code→token exchange was inline in the Express adapter and untestable/unportable; How: lift it into the core keyed by an injected redirectUri; Tests: 200 returns refreshToken, non-200 throws, missing refresh_token throws.

---

### Task 3: Core — cookie builders

**Files:**
- Modify: `server/auth.js` (add `buildSessionCookie`, `clearSessionCookie`, `COOKIE_MAX_AGE`)
- Test: `server/__tests__/auth.test.js` (add a `describe` block)

**Interfaces:**
- Consumes: `COOKIE_NAME`.
- Produces:
  - `buildSessionCookie(sealed: string, { secure: boolean }): string` — full `Set-Cookie` value
  - `clearSessionCookie({ secure: boolean }): string` — expiring `Set-Cookie` value (`Max-Age=0`)

- [ ] **Step 1: Write failing tests**

Add to `server/__tests__/auth.test.js`:

```javascript
import { buildSessionCookie, clearSessionCookie } from "../auth.js";

describe("buildSessionCookie", () => {
  it("emits the sealed value with the shared attributes", () => {
    const cookie = buildSessionCookie("SEALED", { secure: true });
    expect(cookie).toMatch(/^rt=SEALED/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/Secure/);
  });

  it("omits Secure when secure is false (local http)", () => {
    const cookie = buildSessionCookie("SEALED", { secure: false });
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie with Max-Age=0", () => {
    const cookie = clearSessionCookie({ secure: true });
    expect(cookie).toMatch(/^rt=;/);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Secure/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: FAIL — builders not exported.

- [ ] **Step 3: Implement in `server/auth.js`**

Add near `COOKIE_NAME`:

```javascript
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

export function buildSessionCookie(sealed, { secure }) {
  const attrs = [
    `${COOKIE_NAME}=${sealed}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie({ secure }) {
  const attrs = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write server/auth.js server/__tests__/auth.test.js
git add server/auth.js server/__tests__/auth.test.js
git commit
```
Why: both adapters must emit identical cookie attributes, differing only in Secure per environment; How: centralize the Set-Cookie string in the core with a secure flag; Tests: Secure present/absent by flag, clear uses Max-Age=0.

---

### Task 4: Core — session orchestrators (`createSession`, `refreshSession`)

**Files:**
- Modify: `server/auth.js` (add `createSession`, `refreshSession`)
- Test: `server/__tests__/auth.test.js` (add a `describe` block)

**Interfaces:**
- Consumes: `exchangeAuthCode`, `exchangeRefreshToken`, `sealToken`, `openToken`, `buildSessionCookie`.
- Produces:
  - `createSession(code, { clientId, clientSecret, redirectUri, secure }): Promise<{ cookie: string }>`
  - `refreshSession(sealed, { clientId, clientSecret, secure }): Promise<{ accessToken, expiresIn, cookie: string | null }>` — `cookie` is non-null only when Spotify rotated the refresh token; **throws** if `sealed` is tampered/invalid or Spotify rejects the refresh.

These two functions are why the adapters can be ~5 lines: all "open → exchange → re-seal if rotated" logic lives here and is unit-tested against the 90% bar.

- [ ] **Step 1: Write failing tests**

Add to `server/__tests__/auth.test.js`:

```javascript
import { createSession, refreshSession } from "../auth.js";

describe("createSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("exchanges the code and returns a sealed session cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { cookie } = await createSession("auth-code", {
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:3000/callback",
      secure: true,
    });
    expect(cookie).toMatch(/^rt=/);
    expect(cookie).toMatch(/Secure/);
    // the sealed value must not leak the plaintext refresh token
    expect(cookie).not.toContain("refresh-abc");
  });
});

describe("refreshSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("returns an access token and no cookie when the token did not rotate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh", expires_in: 3600 }),
      }),
    );
    const sealed = sealToken("refresh-abc");
    const result = await refreshSession(sealed, {
      clientId: "id",
      clientSecret: "secret",
      secure: false,
    });
    expect(result.accessToken).toBe("fresh");
    expect(result.expiresIn).toBe(3600);
    expect(result.cookie).toBeNull();
  });

  it("re-issues a cookie when Spotify rotates the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fresh",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
      }),
    );
    const sealed = sealToken("refresh-abc");
    const result = await refreshSession(sealed, {
      clientId: "id",
      clientSecret: "secret",
      secure: true,
    });
    expect(result.cookie).toMatch(/^rt=/);
    expect(result.cookie).toMatch(/Secure/);
  });

  it("throws when the sealed cookie is invalid", async () => {
    await expect(
      refreshSession("not-a-valid-sealed-blob", {
        clientId: "id",
        clientSecret: "secret",
        secure: false,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: FAIL — `createSession`/`refreshSession` not exported.

- [ ] **Step 3: Implement in `server/auth.js`**

Add at the end of the file:

```javascript
export async function createSession(
  code,
  { clientId, clientSecret, redirectUri, secure },
) {
  const { refreshToken } = await exchangeAuthCode(code, {
    clientId,
    clientSecret,
    redirectUri,
  });
  return { cookie: buildSessionCookie(sealToken(refreshToken), { secure }) };
}

export async function refreshSession(
  sealed,
  { clientId, clientSecret, secure },
) {
  const refreshToken = openToken(sealed); // throws on tamper/invalid
  const result = await exchangeRefreshToken(refreshToken, {
    clientId,
    clientSecret,
  });
  const rotated = result.refreshToken !== refreshToken;
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    cookie: rotated
      ? buildSessionCookie(sealToken(result.refreshToken), { secure })
      : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the strict coverage bar for `server/auth.js`**

Run: `npx vitest run --coverage server/__tests__/auth.test.js`
Expected: `server/auth.js` meets statements ≥90, branches ≥75, functions 100. If a branch is uncovered, add a test before committing.

- [ ] **Step 6: Commit**

```bash
npx biome check --write server/auth.js server/__tests__/auth.test.js
git add server/auth.js server/__tests__/auth.test.js
git commit
```
Why: keep both adapters logic-free by putting create/refresh orchestration in the core; How: createSession(code)→cookie, refreshSession(sealed)→{token, cookie|null} re-sealing only on rotation; Tests: create seals+doesn't leak plaintext, refresh no-rotation→null cookie, rotation→new cookie, invalid sealed→throw.

---

### Task 5: Local adapter — rewrite `server/app.js` over the core

**Files:**
- Modify: `server/app.js` (delete `sessions` Map + `randomUUID`; delegate to core; env-driven config)
- Modify: `server/index.js` (pass env vars; require `COOKIE_ENCRYPTION_KEY`)
- Rewrite: `server/__tests__/app.test.js` (cookie is now `rt`; no Map)
- Create: `.env.example` (document all env vars)

**Interfaces:**
- Consumes: `createSession`, `refreshSession`, `parseCookies`, `COOKIE_NAME` from the core.
- Produces: `createApp({ clientId, clientSecret, redirectUri?, frontendUrl?, secure? }): { app }` — **note the return no longer includes `sessions`.**

- [ ] **Step 1: Rewrite the tests first**

Replace the entire contents of `server/__tests__/app.test.js` with:

```javascript
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealToken } from "../auth.js";
import { createApp } from "../app.js";

const CREDS = { clientId: "test-id", clientSecret: "test-secret" };

describe("createApp routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("redirects to the frontend with access_denied when the callback errors", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=access_denied",
    );
  });

  it("seals the refresh token into an httpOnly rt cookie and redirects with no token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?code=auth-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://127.0.0.1:5173");
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^rt=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i); // local is http
    expect(setCookie).not.toContain("refresh-abc");
  });

  it("redirects with token_exchange_failed when Spotify rejects the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?code=bad");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=token_exchange_failed",
    );
  });

  it("returns 401 from /api/refresh when there is no cookie", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/refresh");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns a fresh access token from /api/refresh for a valid cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-access", expires_in: 3600 }),
      }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access_token: "fresh-access", expires_in: 3600 });
  });

  it("re-issues the rt cookie when Spotify rotates the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fresh-access",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
      }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toMatch(/^rt=/);
  });

  it("returns 401 refresh_failed when Spotify rejects the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
  });

  it("clears the rt cookie and returns ok from /api/logout", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^rt=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/app.test.js`
Expected: FAIL — app.js still sets a `sid` cookie / references `sessions`.

- [ ] **Step 3: Rewrite `server/app.js`**

Replace the entire contents with:

```javascript
import express from "express";
import {
  clearSessionCookie,
  COOKIE_NAME,
  createSession,
  parseCookies,
  refreshSession,
} from "./auth.js";

export function createApp({
  clientId,
  clientSecret,
  redirectUri = "http://127.0.0.1:3000/callback",
  frontendUrl = "http://127.0.0.1:5173",
  secure = false,
}) {
  const app = express();

  app.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    console.info("[server] OAuth callback received");

    if (error || !code) {
      return res.redirect(`${frontendUrl}?error=access_denied`);
    }

    try {
      const { cookie } = await createSession(code, {
        clientId,
        clientSecret,
        redirectUri,
        secure,
      });
      res.setHeader("Set-Cookie", cookie);
      // No token in the URL — the SPA fetches one via POST /api/refresh.
      return res.redirect(frontendUrl);
    } catch (err) {
      console.error("[server] token exchange failed:", err.message);
      return res.redirect(`${frontendUrl}?error=token_exchange_failed`);
    }
  });

  app.post("/api/refresh", async (req, res) => {
    const sealed = parseCookies(req.headers.cookie)[COOKIE_NAME];
    console.info("[server] token refresh requested");
    if (!sealed) {
      return res.status(401).json({ error: "no_session" });
    }

    try {
      const { accessToken, expiresIn, cookie } = await refreshSession(sealed, {
        clientId,
        clientSecret,
        secure,
      });
      if (cookie) res.setHeader("Set-Cookie", cookie); // persist rotation
      console.info("[server] token refresh succeeded");
      res.json({ access_token: accessToken, expires_in: expiresIn });
    } catch (err) {
      console.error("[server] token refresh failed:", err.message);
      res.status(401).json({ error: "refresh_failed" });
    }
  });

  app.post("/api/logout", (_req, res) => {
    console.info("[server] logout requested");
    res.setHeader("Set-Cookie", clearSessionCookie({ secure }));
    res.status(200).json({ ok: true });
  });

  return { app };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/app.test.js`
Expected: PASS.

- [ ] **Step 5: Update `server/index.js`**

Replace its contents with (adds `COOKIE_ENCRYPTION_KEY` to the required check and passes env-driven config; local `secure` stays false):

```javascript
import "dotenv/config";
import { createApp } from "./app.js";

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const COOKIE_ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY;

if (!CLIENT_ID || !CLIENT_SECRET || !COOKIE_ENCRYPTION_KEY) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or COOKIE_ENCRYPTION_KEY in .env",
  );
  process.exit(1);
}

const { app } = createApp({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  frontendUrl: process.env.FRONTEND_URL,
  secure: false, // local dev is http on 127.0.0.1
});

app.listen(3000, "127.0.0.1", () => {
  console.log("[server] OAuth server listening on http://127.0.0.1:3000");
});
```

Note: `createApp` uses default params, so `redirectUri`/`frontendUrl` being `undefined` (env var unset) correctly falls back to the localhost defaults.

- [ ] **Step 6: Create `.env.example`**

```
# Spotify app credentials (Spotify Developer Dashboard)
VITE_SPOTIFY_CLIENT_ID=your-client-id       # exposed to the browser
SPOTIFY_CLIENT_SECRET=your-client-secret     # server-only, never in client code

# 32-byte key for sealing the refresh-token cookie: openssl rand -base64 32
COOKIE_ENCRYPTION_KEY=your-base64-32-byte-key

# Optional overrides (defaults shown are for local dev)
# REDIRECT_URI=http://127.0.0.1:3000/callback
# FRONTEND_URL=http://127.0.0.1:5173
```

- [ ] **Step 7: Run the full suite + coverage**

Run: `npm test`
Expected: PASS with global coverage floor met (`server/app.js` under the 80/70/85 global bar, `server/auth.js` under strict 90). If `server/index.js` shows as uncovered, confirm it is still in the coverage `exclude` list in `vite.config.js` (it is).

- [ ] **Step 8: Commit**

```bash
npx biome check --write server/app.js server/index.js server/__tests__/app.test.js .env.example
git add server/app.js server/index.js server/__tests__/app.test.js .env.example
git commit
```
Why: the in-memory Map cannot survive serverless and the adapter owned business logic; How: delete the Map, delegate callback/refresh to the core, add a /api/logout route that clears the cookie, drive redirect/frontend URLs from env, unify the cookie to rt; Tests: rewrote app.test.js for the rt cookie, rotation re-issue, logout clear, and 401 paths.

---

### Task 6: Production adapters + `vercel.json`

**Files:**
- Create: `api/callback.js`
- Create: `api/refresh.js`
- Create: `api/logout.js`
- Create: `vercel.json`
- Test: `api/__tests__/handlers.test.js`

**Interfaces:**
- Consumes: `createSession`, `refreshSession`, `clearSessionCookie`, `parseCookies`, `COOKIE_NAME` from `../server/auth.js`.
- Produces: three default-export Vercel handlers `handler(req, res)`. `secure: true` (prod is https). Env from `process.env` (`VITE_SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `REDIRECT_URI`, `FRONTEND_URL`, `COOKIE_ENCRYPTION_KEY`).

Note on coverage: `api/**` is **not** in the `include` globs of `vite.config.js`, so these files carry no coverage requirement. We still add focused handler tests because the risky seal/rotation paths run through them — no new infra, just a small mock `res`.

- [ ] **Step 1: Write failing tests**

Create `api/__tests__/handlers.test.js`:

```javascript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealToken } from "../../server/auth.js";
import callback from "../callback.js";
import logout from "../logout.js";
import refresh from "../refresh.js";

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirected: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    redirect(url) {
      this.redirected = url;
      return this;
    },
  };
}

describe("api/callback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.VITE_SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
    process.env.REDIRECT_URI = "https://app.vercel.app/api/callback";
    process.env.FRONTEND_URL = "https://app.vercel.app";
  });

  it("seals the refresh token into a Secure cookie and redirects home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const res = mockRes();
    await callback({ query: { code: "auth-code" } }, res);
    expect(res.headers["Set-Cookie"]).toMatch(/^rt=/);
    expect(res.headers["Set-Cookie"]).toMatch(/Secure/);
    expect(res.redirected).toBe("https://app.vercel.app");
  });

  it("redirects with access_denied when the code is missing", async () => {
    const res = mockRes();
    await callback({ query: { error: "access_denied" } }, res);
    expect(res.redirected).toBe("https://app.vercel.app?error=access_denied");
  });
});

describe("api/refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.VITE_SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
  });

  it("returns 401 no_session without a cookie", async () => {
    const res = mockRes();
    await refresh({ headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns an access token for a valid cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh", expires_in: 3600 }),
      }),
    );
    const sealed = sealToken("refresh-abc");
    const res = mockRes();
    await refresh({ headers: { cookie: `rt=${sealed}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ access_token: "fresh", expires_in: 3600 });
  });

  it("returns 401 refresh_failed for a tampered cookie", async () => {
    const res = mockRes();
    await refresh({ headers: { cookie: "rt=garbage" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
  });
});

describe("api/logout", () => {
  it("clears the rt cookie with a Secure attribute and returns ok", async () => {
    const res = mockRes();
    await logout({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["Set-Cookie"]).toMatch(/^rt=;/);
    expect(res.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect(res.headers["Set-Cookie"]).toMatch(/Secure/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/__tests__/handlers.test.js`
Expected: FAIL — `api/callback.js` / `api/refresh.js` / `api/logout.js` do not exist.

- [ ] **Step 3: Create `api/callback.js`**

```javascript
import { createSession } from "../server/auth.js";

export default async function handler(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL;

  if (error || !code) {
    return res.redirect(`${frontendUrl}?error=access_denied`);
  }

  try {
    const { cookie } = await createSession(code, {
      clientId: process.env.VITE_SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.REDIRECT_URI,
      secure: true,
    });
    res.setHeader("Set-Cookie", cookie);
    return res.redirect(frontendUrl);
  } catch (err) {
    console.error("[api/callback] token exchange failed:", err.message);
    return res.redirect(`${frontendUrl}?error=token_exchange_failed`);
  }
}
```

- [ ] **Step 4: Create `api/refresh.js` and `api/logout.js`**

`api/refresh.js`:

```javascript
import { COOKIE_NAME, parseCookies, refreshSession } from "../server/auth.js";

export default async function handler(req, res) {
  const sealed = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sealed) {
    return res.status(401).json({ error: "no_session" });
  }

  try {
    const { accessToken, expiresIn, cookie } = await refreshSession(sealed, {
      clientId: process.env.VITE_SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      secure: true,
    });
    if (cookie) res.setHeader("Set-Cookie", cookie); // persist rotation
    return res.status(200).json({
      access_token: accessToken,
      expires_in: expiresIn,
    });
  } catch (err) {
    console.error("[api/refresh] refresh failed:", err.message);
    return res.status(401).json({ error: "refresh_failed" });
  }
}
```

`api/logout.js` (clears the sealed cookie; no body needed):

```javascript
import { clearSessionCookie } from "../server/auth.js";

export default function handler(_req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie({ secure: true }));
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 5: Create `vercel.json`**

```json
{
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

Why this is safe for assets: top-level `rewrites` in `vercel.json` run in Vercel's **afterFiles** phase — i.e. *after* the filesystem check. Real built files in `dist/` (e.g. `/assets/index-*.js`) are served directly; only paths that match no file fall through to the SPA fallback. The `(?!api/)` negative lookahead additionally leaves the serverless functions untouched. Vercel auto-detects the Vite preset (build → `dist/`) and the `api/` directory as serverless functions; no extra build config is needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run api/__tests__/handlers.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Coverage unaffected (`api/**` not in `include`).

- [ ] **Step 8: Commit**

```bash
npx biome check --write api/callback.js api/refresh.js api/logout.js api/__tests__/handlers.test.js vercel.json
git add api/callback.js api/refresh.js api/logout.js api/__tests__/handlers.test.js vercel.json
git commit
```
Why: production needs serverless OAuth callback + refresh + logout endpoints and an SPA fallback; How: three ~10-line Vercel handlers delegating to the core with secure:true, plus a vercel.json afterFiles SPA rewrite; Tests: handler-level seal cookie, no-cookie 401, valid refresh, tampered-cookie 401, logout clears the cookie.

---

### Task 7: Coverage gate — strict universal per-file bar (disallow-list model)

**Files:**
- Modify: `vite.config.js` (replace the per-file threshold allow-list with one global `perFile` bar; make `exclude` the disallow-list; add `api/**` to `include`)
- Modify: `src/__tests__/App.test.jsx` (cover the OAuth `?error=` branch — `App.jsx:15-17`)
- Modify: `src/components/__tests__/MapView.test.jsx` (cover the `TOKEN_EXPIRED` control path — `MapView.jsx:113-114`)
- Modify: `api/__tests__/handlers.test.js` (cover the `api/callback.js` exchange-failure catch)

**Why this task exists / decision recorded:** The coverage config currently *allow-lists* specific files for the strict bar (`src/geo.js`, `src/spotify.js`, …). That means a **new** logic file is silently held only to the weak global floor. We invert it: one strict per-file bar applies to **every** included file, and the `exclude` list becomes a **disallow-list** of genuinely untestable files (entry points, canvas/DOM/Leaflet wrappers). A new logic file is then gated automatically — if it can't be tested, CI fails until it is.

**Author-set rule (MUST follow during execution):** The strict bar is **statements 90 / branches 75 / functions 100, `perFile`**. **Do not add any file to the `exclude` disallow-list to make it green.** The only pre-agreed additions are the ones already listed below (entry points + `LeafletMap.jsx` + `AlbumBubble.jsx`). If any file — especially any **new** file — cannot meet the bar with reasonable tests, **stop and ask the author** what to do; do not weaken the threshold and do not exclude it unilaterally.

**Interfaces:**
- Consumes: nothing (config + tests).
- Produces: a coverage config where any future `src/**`, `server/**`, or `api/**` logic file is held to 90/75/100 unless explicitly, deliberately excluded.

- [ ] **Step 1: Add the failing branch tests first**

Add to `src/__tests__/App.test.jsx` (inside the `describe("App", …)` block):

```javascript
it("surfaces an OAuth error from the callback and cleans the URL", async () => {
  window.history.replaceState({}, "", "/?error=access_denied");
  const replaceSpy = vi.spyOn(window.history, "replaceState");
  refreshAccessToken.mockRejectedValue(new Error("SESSION_EXPIRED"));
  render(<App />);
  expect(await screen.findByTestId("login")).toHaveTextContent("access_denied");
  expect(replaceSpy).toHaveBeenCalledWith({}, "", "/");
});
```

Add to `src/components/__tests__/MapView.test.jsx` (inside the `describe("MapView poll loop", …)` block):

```javascript
it("refreshes the token when a control action returns TOKEN_EXPIRED", async () => {
  fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
  pause.mockRejectedValueOnce(new Error("TOKEN_EXPIRED"));
  const onTokenExpired = vi.fn().mockResolvedValue(undefined);
  render(<MapView token="t" onTokenExpired={onTokenExpired} />);
  await waitFor(() =>
    expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByText("play-pause"));
  await waitFor(() => expect(onTokenExpired).toHaveBeenCalled());
});
```

Add to `api/__tests__/handlers.test.js` (inside `describe("api/callback", …)`):

```javascript
it("redirects with token_exchange_failed when the code exchange throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 400 }),
  );
  const res = mockRes();
  await callback({ query: { code: "bad" } }, res);
  expect(res.redirected).toBe(
    "https://app.vercel.app?error=token_exchange_failed",
  );
});
```

- [ ] **Step 2: Run the new tests to verify they pass (behavior already exists)**

Run: `npx vitest run src/__tests__/App.test.jsx src/components/__tests__/MapView.test.jsx api/__tests__/handlers.test.js`
Expected: PASS. (These cover existing-but-untested branches, so they pass immediately; their job is to lift coverage, not drive new code.)

- [ ] **Step 3: Rewrite the coverage block in `vite.config.js`**

Replace the entire `coverage: { … }` object with:

```javascript
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.{js,jsx}", "server/**/*.js", "api/**/*.js"],
      // Disallow-list: the ONLY files exempt from the strict per-file bar below.
      // Everything else — including any NEW file — must meet the bar. Do not add
      // a file here to make coverage pass; if a file can't be tested, ask first.
      exclude: [
        "**/__tests__/**",
        "**/*.test.{js,jsx}",
        "src/test/setup.js",
        "src/main.jsx", // React DOM entry point (createRoot+render); no logic
        "server/index.js", // process entry point (env check + listen)
        "src/components/LeafletMap.jsx", // react-leaflet wrapper; needs real canvas/map sizing jsdom lacks
        "src/components/AlbumBubble.jsx", // builds a Leaflet divIcon + Popup; same canvas/DOM constraint
      ],
      thresholds: {
        // One strict bar, applied to every included file individually. New
        // logic files are gated automatically — no per-file allow-list to keep
        // in sync.
        perFile: true,
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
```

- [ ] **Step 4: Run full coverage and confirm the gate is green**

Run: `npx vitest run --coverage`
Expected: PASS with **no threshold errors**. Every included file meets 90/75/100.
- If a file you did not expect is under the bar, add targeted tests for its uncovered lines (shown in the report).
- **If a file genuinely cannot be tested, STOP and ask the author** (per the author-set rule above). Do not add it to `exclude` on your own and do not lower the numbers.

- [ ] **Step 5: Commit**

```bash
npx biome check --write vite.config.js src/__tests__/App.test.jsx src/components/__tests__/MapView.test.jsx api/__tests__/handlers.test.js
git add vite.config.js src/__tests__/App.test.jsx src/components/__tests__/MapView.test.jsx api/__tests__/handlers.test.js
git commit
```
Why: an allow-list of strictly-covered files let new logic slip through on the weak global floor; How: one universal per-file 90/75/100 bar + a disallow-list of untestable files, `api/**` now included; Tests: added App `?error=` branch, MapView TOKEN_EXPIRED control branch, and api/callback catch-path tests to bring every file to the bar.

---

### Task 8: Album-bubble popup styled like the now-playing overlay

**Files:**
- Create: `src/components/AlbumPopupCard.jsx` (styled popup content — the testable piece)
- Create: `src/components/albumPopup.css` (dark-theme overrides for Leaflet's default white popup chrome)
- Create: `src/components/__tests__/AlbumPopupCard.test.jsx`
- Modify: `src/components/AlbumBubble.jsx` (render `AlbumPopupCard` inside `<Popup>`, import the css)

**Design:** Leaflet's default popup is a white rounded bubble — visually foreign to the app's Spotify-dark `NowPlayingCard`. We (a) extract a presentational `AlbumPopupCard` that reuses the exact header layout of `NowPlayingCard` (album thumbnail + bold artist + muted track + `📍 place`, same sizes/fonts from `theme.js`), and (b) override Leaflet's `.leaflet-popup-*` chrome to the dark surface. `AlbumPopupCard` is pure JSX-from-props, so it meets the strict bar from Task 7; `AlbumBubble` stays a Leaflet wrapper on the disallow-list.

**Interfaces:**
- Consumes: `TEXT`, `MUTED` from `../theme.js`.
- Produces: `AlbumPopupCard({ imageUrl, trackName, artistName, placeName })` — default export.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/AlbumPopupCard.test.jsx`:

```javascript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlbumPopupCard from "../AlbumPopupCard.jsx";

describe("AlbumPopupCard", () => {
  it("renders the artist, track, place, and album art", () => {
    render(
      <AlbumPopupCard
        imageUrl="https://example.com/a.jpg"
        trackName="Idioteque"
        artistName="Radiohead"
        placeName="Oxford, England"
      />,
    );
    expect(screen.getByText("Radiohead")).toBeInTheDocument();
    expect(screen.getByText("Idioteque")).toBeInTheDocument();
    expect(screen.getByText(/Oxford, England/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/a.jpg",
    );
  });

  it("falls back to Unknown location and omits the image when data is missing", () => {
    render(<AlbumPopupCard trackName="X" artistName="Y" />);
    expect(screen.getByText(/Unknown location/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/__tests__/AlbumPopupCard.test.jsx`
Expected: FAIL — `AlbumPopupCard.jsx` does not exist.

- [ ] **Step 3: Create `src/components/AlbumPopupCard.jsx`**

Mirrors the `NowPlayingCard` header block (same 56px art, `fontWeight:700`/`fontSize:15` title, muted subtitle, `📍` place, shared `ellipsis`):

```javascript
import { MUTED, TEXT } from "../theme.js";

const ellipsis = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export default function AlbumPopupCard({
  imageUrl,
  trackName,
  artistName,
  placeName,
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        width: 240,
        padding: 12,
        boxSizing: "border-box",
        color: TEXT,
        fontFamily: "sans-serif",
      }}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, ...ellipsis }}>
          {artistName}
        </div>
        <div style={{ color: MUTED, fontSize: 13, ...ellipsis }}>
          {trackName}
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 2, ...ellipsis }}>
          📍 {placeName ?? "Unknown location"}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/__tests__/AlbumPopupCard.test.jsx`
Expected: PASS (both branches — image present/absent, place present/absent — covered, so this file meets the Task 7 bar).

- [ ] **Step 5: Create `src/components/albumPopup.css`**

Dark-theme overrides for Leaflet's popup chrome. Values mirror `theme.js` (`SURFACE #181818`, `TEXT #fff`, `MUTED #b3b3b3`); CSS can't import the JS constants, so keep them in sync by comment:

```css
/* Match the Spotify-dark NowPlayingCard (see src/theme.js). */
.leaflet-popup-content-wrapper {
  background: #181818; /* SURFACE */
  color: #fff; /* TEXT */
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
}

.leaflet-popup-content {
  margin: 0; /* AlbumPopupCard owns its own padding */
}

.leaflet-popup-tip {
  background: #181818; /* SURFACE — match the wrapper */
}

.leaflet-popup-close-button {
  color: #b3b3b3; /* MUTED */
}
```

- [ ] **Step 6: Wire `AlbumPopupCard` into `AlbumBubble.jsx`**

Replace the raw `<Popup>` markup and add the two imports. The full file becomes:

```javascript
import L from "leaflet";
import { useMemo } from "react";
import { Marker, Popup } from "react-leaflet";
import "./albumPopup.css";
import AlbumPopupCard from "./AlbumPopupCard.jsx";

export default function AlbumBubble({
  location,
  imageUrl,
  trackName,
  artistName,
}) {
  const icon = useMemo(() => {
    const img = document.createElement("img");
    img.src = imageUrl ?? "";
    img.alt = artistName;
    img.style.cssText =
      "width:64px;height:64px;border-radius:50%;border:3px solid white;box-shadow:0 2px 12px rgba(0,0,0,0.5);display:block;";
    return L.divIcon({
      html: img,
      className: "",
      iconSize: [64, 64],
      iconAnchor: [32, 32],
      popupAnchor: [0, -36],
    });
  }, [imageUrl, artistName]);

  // Use == null (not truthiness) so a valid 0 coordinate — e.g. the Pacific
  // "Unknown location" fallback at lat 0 — still renders the bubble.
  if (location?.lat == null || location?.lng == null) return null;

  return (
    <Marker position={[location.lat, location.lng]} icon={icon}>
      <Popup>
        <AlbumPopupCard
          imageUrl={imageUrl}
          trackName={trackName}
          artistName={artistName}
          placeName={location.placeName}
        />
      </Popup>
    </Marker>
  );
}
```

- [ ] **Step 7: Run the suite + coverage**

Run: `npx vitest run --coverage`
Expected: PASS, gate green. `AlbumPopupCard.jsx` meets 90/75/100; `AlbumBubble.jsx` stays excluded (Leaflet/DOM wrapper).

- [ ] **Step 8: Manual visual check (Leaflet popup can't render in jsdom)**

Run `npm start`, log in, wait for a bubble, and click it. Confirm the popup is a dark card matching the top-right now-playing overlay (dark surface, album thumbnail, bold artist, muted track + `📍 place`), not the default white bubble. If the tip/arrow or close button is still white, adjust `albumPopup.css`.

- [ ] **Step 9: Commit**

```bash
npx biome check --write src/components/AlbumPopupCard.jsx src/components/albumPopup.css src/components/AlbumBubble.jsx src/components/__tests__/AlbumPopupCard.test.jsx
git add src/components/AlbumPopupCard.jsx src/components/albumPopup.css src/components/AlbumBubble.jsx src/components/__tests__/AlbumPopupCard.test.jsx
git commit
```
Why: the album-bubble popup used Leaflet's default white styling, clashing with the Spotify-dark now-playing overlay; How: extract a tested AlbumPopupCard reusing the NowPlayingCard header layout + override Leaflet popup chrome to the dark surface; Tests: AlbumPopupCard renders artist/track/place/art and handles missing image + place.

---

### Task 9: Logout UI — "Log out" button styled like the now-playing overlay

**Files:**
- Modify: `src/auth.js` (add `logout()`)
- Create: `src/components/LogoutButton.jsx`
- Create: `src/components/__tests__/LogoutButton.test.jsx`
- Modify: `src/App.jsx` (add `handleLogout`; render `LogoutButton` beside `MapView` when logged in)
- Modify: `src/__tests__/auth.test.js` (test `logout()`)
- Modify: `src/__tests__/App.test.jsx` (mock `logout`; test the logout flow)

**Design:** The `/api/logout` endpoints exist (Tasks 5–6); this task adds the client half. `src/auth.js` gets a `logout()` that POSTs to clear the cookie. A `LogoutButton` — fixed **bottom-right**, dark surface matching `NowPlayingCard` (`SURFACE` bg, `TEXT`, rounded 12, same shadow/sans-serif), label **"Log out"** — is rendered by `App` alongside `MapView` whenever a token is present, so it's available in every logged-in state (playing/idle/error). Clicking it calls `logout()` then clears client auth state, returning the user to the landing page. All three touched `.js/.jsx` files are held to the Task 7 strict bar; their tests below keep them there.

**Interfaces:**
- Consumes: `SURFACE`, `TEXT` from `../theme.js`; `refreshAccessToken` (existing) + new `logout` from `./auth.js`.
- Produces:
  - `logout(): Promise<void>` — `POST /api/logout` with `credentials: "include"`.
  - `LogoutButton({ onLogout })` — default export; renders a `<button>Log out</button>`.

- [ ] **Step 1: Write the failing test for `logout()`**

Add to `src/__tests__/auth.test.js`:

```javascript
import { logout } from "../auth.js";

describe("logout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/logout including credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await logout();
    expect(fetchMock).toHaveBeenCalledWith("/api/logout", {
      method: "POST",
      credentials: "include",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/auth.test.js`
Expected: FAIL — `logout` is not exported.

- [ ] **Step 3: Implement `logout()` in `src/auth.js`**

Append to `src/auth.js`:

```javascript
export async function logout() {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `LogoutButton`**

Create `src/components/__tests__/LogoutButton.test.jsx`:

```javascript
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LogoutButton from "../LogoutButton.jsx";

describe("LogoutButton", () => {
  it("renders a Log out button and calls onLogout when clicked", () => {
    const onLogout = vi.fn();
    render(<LogoutButton onLogout={onLogout} />);
    const button = screen.getByRole("button", { name: "Log out" });
    fireEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/components/__tests__/LogoutButton.test.jsx`
Expected: FAIL — `LogoutButton.jsx` does not exist.

- [ ] **Step 7: Create `src/components/LogoutButton.jsx`**

```javascript
import { SURFACE, TEXT } from "../theme.js";

export default function LogoutButton({ onLogout }) {
  return (
    <button
      type="button"
      onClick={onLogout}
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 1000,
        background: SURFACE,
        color: TEXT,
        border: "none",
        borderRadius: 12,
        padding: "10px 16px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        fontFamily: "sans-serif",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      Log out
    </button>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/components/__tests__/LogoutButton.test.jsx`
Expected: PASS.

- [ ] **Step 9: Wire logout into `App.jsx`**

Update the imports (add `logout` and `LogoutButton`):

```javascript
import { useCallback, useEffect, useState } from "react";
import { logout, refreshAccessToken } from "./auth.js";
import LandingPage from "./components/LandingPage.jsx";
import LogoutButton from "./components/LogoutButton.jsx";
import MapView from "./components/MapView.jsx";
```

Add a `handleLogout` callback next to `handleTokenExpired` (inside the component, before the `if (booting)` return):

```javascript
  const handleLogout = useCallback(async () => {
    if (import.meta.env.DEV) console.info("[app] logging out");
    await logout();
    setToken(null);
    setError(null);
  }, []);
```

Replace the logged-in return so the button renders alongside the map:

```javascript
  if (token) {
    return (
      <>
        <MapView token={token} onTokenExpired={handleTokenExpired} />
        <LogoutButton onLogout={handleLogout} />
      </>
    );
  }
```

- [ ] **Step 10: Write the failing App logout-flow test**

In `src/__tests__/App.test.jsx`, update the `auth.js` mock to include `logout`:

```javascript
vi.mock("../auth.js", () => ({ refreshAccessToken: vi.fn(), logout: vi.fn() }));
```

Add the import alongside the existing `refreshAccessToken` import:

```javascript
import { logout, refreshAccessToken } from "../auth.js";
```

Add this test inside the `describe("App", …)` block:

```javascript
it("logs out: clears the session and returns to the landing page", async () => {
  refreshAccessToken.mockResolvedValueOnce("token-1"); // bootstrap
  logout.mockResolvedValue(undefined);
  render(<App />);
  await screen.findByTestId("map");
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  expect(await screen.findByTestId("login")).toBeInTheDocument();
});
```

- [ ] **Step 11: Run the full suite + coverage**

Run: `npx vitest run --coverage`
Expected: PASS, gate green. `src/auth.js`, `src/components/LogoutButton.jsx`, and `src/App.jsx` (now including `handleLogout`) all meet 90/75/100.

- [ ] **Step 12: Commit**

```bash
npx biome check --write src/auth.js src/components/LogoutButton.jsx src/components/__tests__/LogoutButton.test.jsx src/App.jsx src/__tests__/auth.test.js src/__tests__/App.test.jsx
git add src/auth.js src/components/LogoutButton.jsx src/components/__tests__/LogoutButton.test.jsx src/App.jsx src/__tests__/auth.test.js src/__tests__/App.test.jsx
git commit
```
Why: users need a way to end their session now that a real logout endpoint exists; How: add auth.logout() POSTing /api/logout, a bottom-right "Log out" button styled like the now-playing overlay, wired through App to clear token/error state; Tests: logout() posts with credentials, button calls onLogout, App logout flow returns to the landing page.

---

### Task 10: Guided operator setup (human runbook — not agent code)

This task is the spec's mandated **interactive, pause-and-confirm walkthrough**. It is **not** a code change and must not be automated: it is a checklist the author works through, confirming each gate before moving on. An agent executing this plan should **stop here and hand control to the author**, reading each step aloud and waiting for confirmation.

**Files:**
- Create: `docs/superpowers/plans/2026-07-23-vercel-operator-setup.md` (persist this runbook so it survives the session)

- [ ] **Step 1: Write the runbook file** with the checklist below, then walk the author through it interactively.

**Prerequisites confirm**
- [ ] All of Tasks 1–6 are merged to `main` (Vercel deploys from `main`).
- [ ] `git remote -v` shows a GitHub remote for this repo.

**A. Vercel account & project**
- [ ] Create a Vercel account (hobby tier) and log in.
- [ ] "Add New… → Project" → import the `sound-map` GitHub repo.
- [ ] Confirm the detected framework is **Vite**, build command `vite build`, output `dist`. Do **not** deploy yet — set env vars first (step D).

**B. Vercel CLI + `vercel dev`**
- [ ] Install: `npm i -g vercel` (or `npx vercel`).
- [ ] `vercel login`, then `vercel link` inside the repo to connect this folder to the project.
- [ ] `vercel dev` runs the **production shape locally** (static SPA + `api/` functions on one origin) — useful because it exercises the Vercel adapters that `npm start` does not. Confirm `http://localhost:3000` serves the SPA and `/api/refresh` responds 401 without a cookie.

**C. Vercel MCP / agent integration (decision point)**
- [ ] Discuss with the author: Vercel offers an MCP server that lets an agent read deployments, logs, and env from within the agent workflow. Decide together whether to set it up now. It is **optional** for this deploy — pure convenience for driving Vercel from chat. If yes, add it per Vercel's MCP docs; if no, skip.

**D. Environment variables (Vercel → Project → Settings → Environment Variables)**
- [ ] Generate the cookie key: `openssl rand -base64 32` → set as `COOKIE_ENCRYPTION_KEY`.
- [ ] Set `VITE_SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.
- [ ] Set `REDIRECT_URI=https://<app>.vercel.app/api/callback` (fill in the real app subdomain after first deploy if unknown; you can redeploy).
- [ ] Set `FRONTEND_URL=https://<app>.vercel.app`.
- [ ] Apply to the **Production** environment (Preview OAuth won't work — see F).

**E. Spotify dashboard**
- [ ] Add redirect URI `https://<app>.vercel.app/api/callback` **alongside** the existing `http://127.0.0.1:3000/callback` (keep both).
- [ ] Under *Users and Access*, add up to **5** allowlisted users (name + email) — Development Mode cap.

**F. Deploy & verify**
- [ ] Trigger a production deploy (push to `main` or "Redeploy" in Vercel).
- [ ] Visit `https://<app>.vercel.app`, log in with an allowlisted Spotify account, confirm the map loads and a track shows.
- [ ] Confirm in devtools that the `rt` cookie is `HttpOnly; Secure; SameSite=Lax`.
- [ ] Understand preview behavior: PRs get random preview URLs; Spotify only honors exactly-registered redirect URIs, so **OAuth completes only on production + local** (decision 6). Preview URLs are for inspecting UI, not full login.

- [ ] **Step 2: Commit the runbook**

```bash
git add docs/superpowers/plans/2026-07-23-vercel-operator-setup.md
git commit
```
Why: the human-in-the-loop Vercel/Spotify setup can't be expressed as repo code and must be captured; How: a pause-and-confirm checklist covering account, CLI, MCP decision, env vars, Spotify allowlist, and preview-OAuth caveat; Tests: n/a (documentation).

---

## Self-Review

**Spec coverage:**
- Encrypted httpOnly cookie, AES-256-GCM, no datastore → Tasks 1, 3, 4. ✅
- `exchangeAuthCode` lifted into core → Task 2. ✅
- `buildSessionCookie` / cookie-clearing helper → Task 3 (`clearSessionCookie` added even though logout is client-driven today — it's the spec's named helper and costs one small tested function). ✅
- Delete in-memory `sessions` Map; env-driven `REDIRECT_URI`/`FRONTEND_URL` → Task 5. ✅
- `api/callback.js`, `api/refresh.js` (~5–10 lines, rotation re-issues cookie) → Task 6. ✅
- `vercel.json` SPA-fallback rewrite → Task 6. ✅
- `src/` unchanged; `src/auth.js` already calls `/api/refresh` → confirmed during review, no task needed. ✅
- Config & secrets (5 env vars, both redirect URIs, ≤5 users) → Tasks 5 (`.env.example`) + 10 (operator runbook). ✅
- Guided operator setup as a distinct deliverable → Task 10. ✅
- Testing: seal/open round-trip, tamper-detection, `exchangeAuthCode`, per-file 90% bar → Tasks 1, 2, 4 (coverage gate in Task 4 Step 5). ✅
- Both explicit review clarifications (env-aware `secure` flag; unified `rt` cookie) → Design clarifications section + implemented in Tasks 3, 5, 6. ✅
- Logout: spec's `clearSessionCookie` + auth-flow "Logout → cookie cleared" → `clearSessionCookie` (Task 3), `/api/logout` in both adapters (Tasks 5–6), and the client half (Task 9). ✅

**Author-added tasks:**
- Coverage gate becomes a disallow-list, not a per-file allow-list; any new logic file is gated to 90/75/100 automatically → Task 7. Author-set rule captured: no file is excluded to pass coverage without asking the author first. ✅
- Album-bubble popup restyled to match the now-playing overlay → Task 8. ✅
- Logout endpoint (author chose to implement it rather than drop the unused helper) **plus** a bottom-right "Log out" button styled like the now-playing overlay → `/api/logout` folded into Tasks 5–6, UI in Task 9. ✅
- Note: the operator runbook renumbered to **Task 10**.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows real assertions. ✅

**Type consistency:** `COOKIE_NAME` ("rt"), `buildSessionCookie(sealed, { secure })`, `clearSessionCookie({ secure })`, `createSession(code, { clientId, clientSecret, redirectUri, secure }) → { cookie }`, `refreshSession(sealed, { clientId, clientSecret, secure }) → { accessToken, expiresIn, cookie }`, `exchangeAuthCode(code, { clientId, clientSecret, redirectUri }) → { refreshToken }`, `createApp({...}) → { app }` — names/shapes match across Tasks 1–6. ✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-vercel-deployment.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
