import { Router } from "express";
import { getHoldings, getTransactions, runOrderTx, findUserById } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getQuotes, getQuote, getProfile, getSparkline } from "../services/market.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const holdings = getHoldings.all(req.userId);
  const user = findUserById.get(req.userId);
  const symbols = holdings.map(h => h.symbol);
  const quotes = symbols.length ? await getQuotes(symbols) : {};

  const positions = holdings.map(h => {
    const q = quotes[h.symbol];
    const price = q?.price ?? h.avg_cost;
    return {
      ...h, price,
      changePct: q?.changePct ?? 0,
      value: +(price * h.shares).toFixed(2),
      pnl: +((price - h.avg_cost) * h.shares).toFixed(2),
      sparkline: getSparkline(h.symbol),
    };
  });
  const invested = positions.reduce((s, p) => s + p.value, 0);
  res.json({
    positions,
    cash: user.cash,
    invested: +invested.toFixed(2),
    total: +(invested + user.cash).toFixed(2),
    transactions: getTransactions.all(req.userId),
  });
});

/**
 * Order execution. The client shows a confirmation modal first; the price
 * used is ALWAYS the server-side live quote at execution time, never a
 * price sent by the client.
 */
router.post("/order", async (req, res) => {
  const { symbol, side, qty } = req.body || {};
  if (typeof symbol !== "string" || !/^[A-Z0-9.\-]{1,12}$/i.test(symbol)) return res.status(400).json({ error: "INVALID_SYMBOL" });
  if (!["buy", "sell"].includes(side)) return res.status(400).json({ error: "INVALID_SIDE" });
  if (typeof qty !== "number" || !isFinite(qty) || qty <= 0 || qty > 100000) return res.status(400).json({ error: "INVALID_QTY" });
  // fractions d'actions : quantité normalisée à 6 décimales
  const normQty = Math.round(qty * 1e6) / 1e6;
  if (normQty < 0.000001) return res.status(400).json({ error: "INVALID_QTY" });

  const sym = symbol.toUpperCase();
  let quote, profile;
  try {
    quote = await getQuote(sym);
    profile = await getProfile(sym);
  } catch {
    return res.status(404).json({ error: "SYMBOL_NOT_FOUND" });
  }

  try {
    runOrderTx(req.userId, sym, side, normQty, quote.price, {
      name: profile.name, sector: profile.sector, country: profile.country,
      assetClass: profile.assetClass,
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_CASH") return res.status(422).json({ error: "INSUFFICIENT_CASH" });
    if (e.message === "INSUFFICIENT_SHARES") return res.status(422).json({ error: "INSUFFICIENT_SHARES" });
    throw e;
  }
  const user = findUserById.get(req.userId);
  res.json({ ok: true, executedPrice: quote.price, total: +(quote.price * normQty).toFixed(2), qty: normQty, cash: user.cash });
});

export default router;
