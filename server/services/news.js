/**
 * News service — real headlines from Finnhub company-news, filtered to the
 * symbols the user actually holds. Falls back to a demo feed without a key.
 */
import { DEMO_MODE, KNOWN_ASSETS } from "./market.js";

const NON_COMPANY = new Set(KNOWN_ASSETS.filter(a => a.class === "crypto" || a.class === "bond").map(a => a.symbol));

const API_KEY = process.env.FINNHUB_API_KEY || "";
const cache = new Map(); // symbol -> { at, items }
const TTL = 10 * 60_000;

function isoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

async function companyNews(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < TTL) return cached.items;
  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("from", isoDay(-7));
  url.searchParams.set("to", isoDay(0));
  url.searchParams.set("token", API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const raw = await res.json();
  const items = (raw || []).slice(0, 6).map(n => ({
    id: n.id, symbol,
    source: n.source, headline: n.headline, summary: n.summary,
    url: n.url, datetime: n.datetime * 1000, image: n.image || null,
  }));
  cache.set(symbol, { at: Date.now(), items });
  return items;
}

const DEMO_NEWS = {
  crypto: sym => [
    { headline: `${sym} : la volatilité reste élevée sur les marchés crypto`, summary: "Les analystes rappellent que les variations de plus de 10% en une semaine restent la norme sur cette classe d'actifs.", source: "Demo Crypto Wire" },
  ],
  bond: sym => [
    { headline: `${sym} : les rendements obligataires se stabilisent`, summary: "Le marché des taux intègre les dernières annonces des banques centrales ; les obligations d'État restent l'actif refuge de référence.", source: "Demo Rates Wire" },
  ],
  default: sym => [
    { headline: `${sym}: quarterly results ahead of consensus`, summary: "Revenue and margins came in slightly above analyst expectations; guidance was maintained for the rest of the year.", source: "Demo Wire" },
    { headline: `${sym} announces a strategic partnership`, summary: "The company signed a multi-year agreement expected to open a new distribution channel in Europe.", source: "Demo Wire" },
  ],
};

export async function getNewsForSymbols(symbols) {
  const list = symbols.slice(0, 10);
  const demoFor = sym => {
    const meta = KNOWN_ASSETS.find(a => a.symbol === sym);
    if (meta && meta.class === "crypto") return DEMO_NEWS.crypto(sym);
    if (meta && meta.class === "bond") return DEMO_NEWS.bond(sym);
    return DEMO_NEWS.default(sym);
  };
  if (DEMO_MODE) {
    const now = Date.now();
    return list.flatMap((sym, i) =>
      demoFor(sym).map((n, j) => ({
        id: `${sym}-${j}`, symbol: sym, url: null, image: null,
        datetime: now - (i * 3 + j) * 3600_000, ...n,
      }))
    ).sort((a, b) => b.datetime - a.datetime);
  }
  const now = Date.now();
  const all = await Promise.all(list.map(async (sym, i) => {
    // crypto & obligations : pas de company-news chez Finnhub → items pédagogiques
    if (NON_COMPANY.has(sym)) {
      return demoFor(sym).map((n, j) => ({
        id: `${sym}-${j}`, symbol: sym, url: null, image: null,
        datetime: now - (i * 2 + j) * 3600_000, ...n,
      }));
    }
    return companyNews(sym);
  }));
  return all.flat().sort((a, b) => b.datetime - a.datetime).slice(0, 40);
}
