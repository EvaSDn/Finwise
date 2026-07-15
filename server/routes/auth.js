import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import {
  insertUser, findUserByEmail, findUserById,
  upsertBudget, getBudget, setOnboarded, upsertPlan, insertDeposit, updateCash,
} from "../db.js";
import { signToken, authCookieOptions, requireAuth } from "../middleware/auth.js";
import { setUserRole, countUsers } from "../db.js";

const router = Router();

// Brute-force protection on credential endpoints only.
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/register", authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!EMAIL_RE.test(email || "")) return res.status(400).json({ error: "INVALID_EMAIL" });
  if (!password || password.length < 8) return res.status(400).json({ error: "PASSWORD_TOO_SHORT", message: "Password must be at least 8 characters." });
  if (!name || name.trim().length < 1 || name.length > 60) return res.status(400).json({ error: "INVALID_NAME" });

  if (findUserByEmail.get(email.toLowerCase())) return res.status(409).json({ error: "EMAIL_TAKEN" });

  const hash = await bcrypt.hash(password, 12);
  const isFirstUser = countUsers.get().n === 0;
  const info = insertUser.run(email.toLowerCase(), hash, name.trim());
  const user = { id: info.lastInsertRowid, email: email.toLowerCase() };
  // Bootstrap admin : premier compte créé, ou e-mail désigné via ADMIN_EMAIL
  if (isFirstUser || (process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase())) {
    setUserRole.run("admin", user.id);
  }
  res.cookie("token", signToken(user), authCookieOptions());
  res.status(201).json({ user: findUserById.get(user.id) });
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = findUserByEmail.get((email || "").toLowerCase());
  // constant-shape response whether the email exists or not
  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  res.cookie("token", signToken(user), authCookieOptions());
  res.json({ user: findUserById.get(user.id) });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const user = findUserById.get(req.userId);
  if (!user) return res.status(401).json({ error: "UNKNOWN_USER" });
  res.json({ user, budget: getBudget.get(req.userId) || null });
});

/**
 * Onboarding — the budget questions asked right after signup.
 * Sets up the budget profile, the recurring plan, and (optionally)
 * executes the first deposit immediately so the user can trade.
 */
router.post("/onboarding", requireAuth, (req, res) => {
  const { monthlyIncome, housing, dailyLife, subscriptions, investPct, dcaMode, firstDepositNow, confirmedOverThreshold } = req.body || {};

  const num = v => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  const income = num(monthlyIncome);
  if (income === null || income === 0) return res.status(400).json({ error: "INVALID_INCOME" });
  const pct = num(investPct);
  if (pct === null || pct > 100) return res.status(400).json({ error: "INVALID_PCT" });
  if (!["dca", "once"].includes(dcaMode)) return res.status(400).json({ error: "INVALID_MODE" });

  const overThreshold = pct > 10;
  // The 10% rule is a WARNING, not a ban: the user decides, but must
  // explicitly confirm when they go above it.
  if (overThreshold && !confirmedOverThreshold) {
    return res.status(422).json({ error: "CONFIRMATION_REQUIRED", threshold: 10, investPct: pct });
  }

  const fixed = (num(housing) || 0) + (num(dailyLife) || 0) + (num(subscriptions) || 0);
  if (fixed > income) return res.status(400).json({ error: "COSTS_EXCEED_INCOME" });

  upsertBudget.run({
    user_id: req.userId, monthly_income: income,
    housing: num(housing) || 0, daily_life: num(dailyLife) || 0, subscriptions: num(subscriptions) || 0,
    invest_pct: pct, dca_mode: dcaMode,
  });

  const monthlyAmount = +(income * pct / 100).toFixed(2);
  if (dcaMode === "dca" && monthlyAmount > 0) upsertPlan.run(req.userId, monthlyAmount);

  if (firstDepositNow && monthlyAmount > 0) {
    updateCash.run(monthlyAmount, req.userId);
    insertDeposit.run(req.userId, monthlyAmount, "monthly", pct, overThreshold ? 1 : 0);
  }

  setOnboarded.run(req.userId);
  res.json({ user: findUserById.get(req.userId), budget: getBudget.get(req.userId), monthlyAmount });
});

export default router;
