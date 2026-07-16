import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getQuotes, getQuote, searchSymbols, getProfile, getSparkline, DEMO_MODE } from "../services/market.js";

const router = Router();
router.use(requireAuth);

router.get("/status", (req, res) => res.json({ demoMode: DEMO_MODE }));

/** Polled by the client every ~15s — this is the realtime feed. */
router.get("/quotes", async (req, res) => {
  const raw = String(req.query.symbols || "");
  const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9.\-]{1,12}$/.test(s)).slice(0, 30);
  if (!symbols.length) return res.json({});
  res.json(await getQuotes(symbols));
});

router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 1 || q.length > 40) return res.json([]);
  try {
    res.json(await searchSymbols(q));
  } catch {
    res.json([]);
  }
});

router.get("/stock/:symbol", async (req, res) => {
  const sym = String(req.params.symbol || "").toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return res.status(400).json({ error: "INVALID_SYMBOL" });
  try {
    const [quote, profile] = await Promise.all([getQuote(sym), getProfile(sym)]);
    res.json({ ...profile, ...quote, sparkline: getSparkline(sym) });
  } catch {
    res.status(404).json({ error: "SYMBOL_NOT_FOUND" });
  }
});

export default router;