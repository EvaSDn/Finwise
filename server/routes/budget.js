import { Router } from "express";
import {
  getBudget, upsertBudget, getPlan, upsertPlan, deactivatePlan, markPlanExecuted,
  insertDeposit, getDeposits, updateCash, findUserById,
} from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const THRESHOLD_PCT = 10;

router.get("/", (req, res) => {
  res.json({
    budget: getBudget.get(req.userId) || null,
    plan: getPlan.get(req.userId) || null,
    deposits: getDeposits.all(req.userId),
    user: findUserById.get(req.userId),
    thresholdPct: THRESHOLD_PCT,
  });
});

router.put("/profile", (req, res) => {
  const { monthlyIncome, housing, dailyLife, subscriptions, investPct, dcaMode, confirmedOverThreshold } = req.body || {};
  const num = v => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  const income = num(monthlyIncome);
  const pct = num(investPct);
  if (income === null || income === 0 || pct === null || pct > 100) return res.status(400).json({ error: "INVALID_INPUT" });
  if (!["dca", "once"].includes(dcaMode)) return res.status(400).json({ error: "INVALID_MODE" });

  if (pct > THRESHOLD_PCT && !confirmedOverThreshold) {
    return res.status(422).json({ error: "CONFIRMATION_REQUIRED", threshold: THRESHOLD_PCT });
  }

  upsertBudget.run({
    user_id: req.userId, monthly_income: income,
    housing: num(housing) || 0, daily_life: num(dailyLife) || 0, subscriptions: num(subscriptions) || 0,
    invest_pct: pct, dca_mode: dcaMode,
  });
  const monthlyAmount = +(income * pct / 100).toFixed(2);
  if (dcaMode === "dca" && monthlyAmount > 0) upsertPlan.run(req.userId, monthlyAmount);
  else deactivatePlan.run(req.userId);

  res.json({ budget: getBudget.get(req.userId), plan: getPlan.get(req.userId), monthlyAmount });
});

/**
 * One-off deposit — the user can add money along the way, on top of the
 * plan. If the amount pushes this month's contribution above 10% of
 * income, the server demands explicit confirmation (422) before applying.
 * The user always decides; we only make the risk visible and confirmed.
 */
router.post("/deposit", (req, res) => {
  const { amount, confirmedOverThreshold } = req.body || {};
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return res.status(400).json({ error: "INVALID_AMOUNT" });
  }
  const budget = getBudget.get(req.userId);
  const income = budget?.monthly_income || 0;
  const pctOfIncome = income > 0 ? (amount / income) * 100 : null;
  const overThreshold = pctOfIncome !== null && pctOfIncome > THRESHOLD_PCT;

  if (overThreshold && !confirmedOverThreshold) {
    return res.status(422).json({
      error: "CONFIRMATION_REQUIRED",
      threshold: THRESHOLD_PCT,
      pctOfIncome: +pctOfIncome.toFixed(1),
      message: `This deposit represents ${pctOfIncome.toFixed(1)}% of your monthly income, above the ${THRESHOLD_PCT}% caution threshold.`,
    });
  }

  updateCash.run(amount, req.userId);
  insertDeposit.run(req.userId, amount, "oneoff", pctOfIncome, overThreshold ? 1 : 0);
  res.json({ user: findUserById.get(req.userId), deposit: { amount, pctOfIncome, overThreshold } });
});

/** Executes this month's recurring contribution (simulates the monthly
    DCA transfer — in production this would be a cron job). */
router.post("/plan/execute", (req, res) => {
  const plan = getPlan.get(req.userId);
  if (!plan || !plan.active) return res.status(400).json({ error: "NO_ACTIVE_PLAN" });
  const budget = getBudget.get(req.userId);
  const pct = budget ? (plan.monthly_amount / budget.monthly_income) * 100 : null;
  updateCash.run(plan.monthly_amount, req.userId);
  insertDeposit.run(req.userId, plan.monthly_amount, "monthly", pct, pct > THRESHOLD_PCT ? 1 : 0);
  markPlanExecuted.run(req.userId);
  res.json({ user: findUserById.get(req.userId), executed: plan.monthly_amount });
});

export default router;
