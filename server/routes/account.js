import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import {
  findUserById, findUserAuthById, findUserByEmail,
  updateUserProfile, updatePasswordHash, deleteUserById,
} from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Modifier prénom / e-mail. */
router.put("/profile", (req, res) => {
  const { name, email } = req.body || {};
  if (!name || name.trim().length < 1 || name.length > 60) return res.status(400).json({ error: "INVALID_NAME" });
  if (!EMAIL_RE.test(email || "")) return res.status(400).json({ error: "INVALID_EMAIL" });
  const lower = email.toLowerCase();
  const existing = findUserByEmail.get(lower);
  if (existing && existing.id !== req.userId) return res.status(409).json({ error: "EMAIL_TAKEN" });
  updateUserProfile.run(name.trim(), lower, req.userId);
  res.json({ user: findUserById.get(req.userId) });
});

/** Changer le mot de passe — l'ancien est exigé. */
router.put("/password", sensitiveLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "PASSWORD_TOO_SHORT" });
  const user = findUserAuthById.get(req.userId);
  if (!user || !(await bcrypt.compare(currentPassword || "", user.password_hash))) {
    return res.status(401).json({ error: "WRONG_PASSWORD" });
  }
  updatePasswordHash.run(await bcrypt.hash(newPassword, 12), req.userId);
  res.json({ ok: true });
});

/** Supprimer son compte — mot de passe exigé, cascade sur toutes les données. */
router.delete("/", sensitiveLimiter, async (req, res) => {
  const { password } = req.body || {};
  const user = findUserAuthById.get(req.userId);
  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "WRONG_PASSWORD" });
  }
  deleteUserById.run(req.userId); // budgets, plans, deposits, holdings, transactions : ON DELETE CASCADE
  res.clearCookie("token", { path: "/" });
  res.json({ ok: true });
});

export default router;
