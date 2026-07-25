import { clearSessionCookie } from "../server/auth.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  res.setHeader("Set-Cookie", clearSessionCookie({ secure: true }));
  return res.status(200).json({ ok: true });
}
