import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { getHoldings, findUserById } from "../db.js";
import { getMarketNews, NEWS_CATEGORIES } from "../services/news.js";
import { getQuotes } from "../services/market.js";
import { analyzePortfolio, agentReply } from "../services/agent.js";

const router = Router();
router.use(requireAuth);

/* ---------- NEWS: multi-catégorie (actions, ETF, crypto, obligations,
   matières premières, devises, entreprises) + flux personnalisé ---------- */
const NEWS_CATEGORY_IDS = new Set(NEWS_CATEGORIES.map(c => c.id));
const newsLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

router.get("/news", newsLimiter, async (req, res) => {
  const holdings = getHoldings.all(req.userId);
  const heldSymbols = holdings.map(h => h.symbol);
  const category = NEWS_CATEGORY_IDS.has(req.query.category) ? req.query.category : "all";
  if (category === "portfolio" && !heldSymbols.length) {
    return res.json({ items: [], heldSymbols: [], category });
  }
  const items = await getMarketNews({ category, heldSymbols });
  res.json({ items, heldSymbols, category });
});

router.get("/news/categories", (req, res) => res.json(NEWS_CATEGORIES));

/* ---------- AGENT ---------- */
async function buildAnalysis(userId) {
  const holdings = getHoldings.all(userId);
  const user = findUserById.get(userId);
  const quotes = holdings.length ? await getQuotes(holdings.map(h => h.symbol)) : {};
  return analyzePortfolio(holdings, quotes, user.cash);
}

router.get("/agent/insights", async (req, res) => {
  const a = await buildAnalysis(req.userId);
  res.json({
    alerts: a.alerts,
    sectorBreakdown: a.sectorBreakdown,
    countryBreakdown: a.countryBreakdown,
    underRepresented: a.underRepresented,
    invested: a.invested,
    threshold: a.threshold,
  });
});

const chatLimiter = rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false });

router.post("/agent/chat", chatLimiter, async (req, res) => {
  const { message, history } = req.body || {};
  if (typeof message !== "string" || !message.trim() || message.length > 2000) {
    return res.status(400).json({ error: "INVALID_MESSAGE" });
  }
  const safeHistory = Array.isArray(history)
    ? history.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-8)
    : [];
  const analysis = await buildAnalysis(req.userId);
  const { reply, engine } = await agentReply(message.trim(), analysis, safeHistory);
  res.json({ reply, engine });
});

export default router;