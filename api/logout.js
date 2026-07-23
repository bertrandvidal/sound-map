import { clearSessionCookie } from "../server/auth.js";

export default function handler(_req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie({ secure: true }));
  return res.status(200).json({ ok: true });
}
