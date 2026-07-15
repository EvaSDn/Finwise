import jwt from "jsonwebtoken";
import crypto from "crypto";

// In production JWT_SECRET must be set; in dev we generate one per boot
// (sessions simply expire on restart — safe default, never a hardcoded secret).
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("⚠ No JWT_SECRET set — using an ephemeral secret (sessions reset on restart).");
}

const TOKEN_TTL = "7d";

export function signToken(user) {
  return jwt.sign({ sub: user.id }, SECRET, { expiresIn: TOKEN_TTL });
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "AUTH_REQUIRED" });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.clearCookie("token", { path: "/" });
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }
}
