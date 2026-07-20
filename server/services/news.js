/**
 * News service — real financial news across every asset class.
 *
 *  - Portfolio feed: Finnhub company-news, filtered to the symbols the
 *    user actually holds (personalized).
 *  - Market feed: Finnhub category endpoints (general / crypto / forex /
 *    merger — the four categories the free plan exposes), each tagged with
 *    finer-grained topics (stocks, etf, bonds, commodities,
 *    currencies, companies) via keyword heuristics, since Finnhub's free
 *    tier has no dedicated "bonds" or "commodities" feed.
 *  - Every article is scanned for mentions of known tickers/companies so
 *    the client can show "related companies" and highlight articles
 *    that relate to the user's holdings.
 *  - No API key -> demo mode: a realistic, fully offline multi-category
 *    feed so the section is never empty.
 */
import { DEMO_MODE, KNOWN_ASSETS } from "./market.js";

const API_KEY = process.env.FINNHUB_API_KEY || "";
const BASE = "https://finnhub.io/api/v1";

export const NEWS_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "portfolio", label: "My Portfolio" },
  { id: "marches", label: "Markets" },
  { id: "actions", label: "Stocks" },
  { id: "etf", label: "ETF" },
  { id: "obligations", label: "Bonds" },
  { id: "matieres-premieres", label: "Commodities" },
  { id: "devises", label: "Currencies" },
  { id: "crypto", label: "Crypto" },
  { id: "entreprises", label: "Companies" },
];
const VALID_TAGS = new Set(NEWS_CATEGORIES.map(c => c.id));

/* ------------------------------------------------------------------ */
/* Companies/assets mentioned — keyword detection                      */
/* ------------------------------------------------------------------ */
const ASSET_MATCHERS = KNOWN_ASSETS
  .filter(a => a.class !== "bond") // "France", "Germany"... too many false positives
  .map(a => {
    const firstWord = a.name.split(/[\s.,]+/)[0];
    const needle = firstWord.length >= 4 ? firstWord : a.name;
    return { symbol: a.symbol, name: a.name, assetClass: a.class, re: new RegExp(`\\b${escapeRe(needle)}\\b`, "i") };
  });
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function relatedSymbolsFor(text) {
  if (!text) return [];
  const out = [];
  for (const m of ASSET_MATCHERS) {
    if (m.re.test(text)) out.push({ symbol: m.symbol, name: m.name, assetClass: m.assetClass });
    if (out.length >= 5) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Thematic tags (an article can cover multiple topics)                */
/* ------------------------------------------------------------------ */
const KEYWORD_TAGS = [
  { tag: "obligations", re: /\bbond(s)?\b|treasury|\byield(s)?\b|bond market|\bbund\b|\bgilt\b|central bank rate|central bank|\bfed\b|\becb\b|oat\b/i },
  { tag: "etf", re: /\betf\b|tracker|index fund/i },
  { tag: "matieres-premieres", re: /\bgold\b|\boil\b|\bbrent\b|\bwti\b|natural gas|\bcopper\b|\bwheat\b|commodit(y|ies)\b/i },
  { tag: "devises", re: /\bforex\b|\bcurrency\b|\bdollar\b|\beuro\b|eur\/usd|\byen\b|sterling|exchange rate/i },
  { tag: "entreprises", re: /acquisition|\bmerger\b|\bipo\b|initial public offering/i },
];
function deriveTags(text, sourceTag, hasStockMatch) {
  const tags = new Set([sourceTag]);
  for (const { tag, re } of KEYWORD_TAGS) if (re.test(text)) tags.add(tag);
  if (hasStockMatch) tags.add("actions");
  if (tags.size === 1 && sourceTag === "marches") tags.add("marches");
  return [...tags].filter(t => VALID_TAGS.has(t));
}

/* ------------------------------------------------------------------ */
/* Finnhub                                                             */
/* ------------------------------------------------------------------ */
const CACHE_TTL = 5 * 60_000;   // markets: 5 min (near real-time, respects free quota)
const PORTFOLIO_TTL = 10 * 60_000;
const cache = new Map();        // key -> { at, items }

async function finnhubJson(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FINNHUB_${res.status}`);
  return res.json();
}

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function normalize(raw, idPrefix, sourceTag) {
  const text = `${raw.headline || ""} ${raw.summary || ""}`;
  const related = relatedSymbolsFor(text);
  const tags = deriveTags(text, sourceTag, related.some(r => r.assetClass === "stock"));
  return {
    id: `${idPrefix}-${raw.id ?? raw.datetime ?? Math.random().toString(36).slice(2)}`,
    tags,
    category: tags[0] || sourceTag,
    headline: raw.headline || "(no title)",
    summary: raw.summary || "",
    source: raw.source || "",
    url: raw.url || null,
    image: raw.image || null,
    datetime: (raw.datetime || Math.floor(Date.now() / 1000)) * 1000,
    relatedSymbols: related,
    personalized: false,
  };
}

/** One of the 4 free Finnhub feeds: general, crypto, forex, merger. */
async function fetchCategory(finnhubCategory, sourceTag) {
  const cacheKey = "cat:" + finnhubCategory;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.items;
  let items = [];
  try {
    const raw = await finnhubJson("/news", { category: finnhubCategory });
    items = (Array.isArray(raw) ? raw : []).slice(0, 40).map(n => normalize(n, finnhubCategory, sourceTag));
  } catch (e) {
    console.error(`News fetch failed (${finnhubCategory}):`, e.message);
    items = cached?.items || [];
  }
  cache.set(cacheKey, { at: Date.now(), items });
  return items;
}

async function fetchCompanyNews(symbol) {
  const cacheKey = "company:" + symbol;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < PORTFOLIO_TTL) return cached.items;
  let items = [];
  try {
    const raw = await finnhubJson("/company-news", { symbol, from: isoDay(-7), to: isoDay(0) });
    items = (Array.isArray(raw) ? raw : []).slice(0, 8).map(n => {
      const item = normalize(n, `co-${symbol}`, assetTagFor(symbol));
      item.personalized = true;
      if (!item.relatedSymbols.some(r => r.symbol === symbol)) {
        const meta = KNOWN_ASSETS.find(a => a.symbol === symbol);
        if (meta) item.relatedSymbols = [{ symbol, name: meta.name, assetClass: meta.class }, ...item.relatedSymbols].slice(0, 5);
      }
      return item;
    });
  } catch (e) {
    console.error(`Company news fetch failed (${symbol}):`, e.message);
    items = cached?.items || [];
  }
  cache.set(cacheKey, { at: Date.now(), items });
  return items;
}

function assetTagFor(symbol) {
  const meta = KNOWN_ASSETS.find(a => a.symbol === symbol);
  if (!meta) return "actions";
  return { stock: "actions", etf: "etf", crypto: "crypto", bond: "obligations" }[meta.class] || "actions";
}

/* ------------------------------------------------------------------ */
/* Demo mode (no API key) — realistic, fully local feed               */
/* ------------------------------------------------------------------ */
const DEMO_ITEMS = [
  { tag: "marches", headline: "European indices close slightly higher, led by banking stocks", summary: "The CAC 40 and DAX advance as investors digest the latest inflation data ahead of the next central bank meeting.", source: "Demo Markets Wire", related: [] },
  { tag: "marches", headline: "Wall Street hesitates ahead of major tech earnings releases", summary: "The S&P 500 and Nasdaq hover near flat, with investors cautious ahead of results from Apple, Microsoft and Amazon.", source: "Demo Markets Wire", related: ["AAPL", "MSFT", "AMZN"] },
  { tag: "actions", headline: "LVMH: luxury market shows signs of recovery in Asia", summary: "The French luxury group saw sales stabilize in the Asia-Pacific region, an encouraging signal after several difficult quarters.", source: "Demo Business Wire", related: ["MC.PA"] },
  { tag: "actions", headline: "NVIDIA: demand for AI chips remains robust", summary: "Analysts raise price targets following optimistic comments from major cloud providers on their AI infrastructure investments.", source: "Demo Tech Wire", related: ["NVDA"] },
  { tag: "actions", headline: "Airbus reaffirms annual delivery targets", summary: "The European planemaker reiterated its forecasts despite ongoing tensions in its supply chain.", source: "Demo Business Wire", related: ["AIR.PA"] },
  { tag: "etf", headline: "World ETFs continue to attract retail investor flows", summary: "MSCI World trackers recorded another record inflow this quarter, driven by the rise of scheduled investment (DCA).", source: "Demo Funds Wire", related: ["CW8.PA"] },
  { tag: "etf", headline: "Tech sector ETFs: strong inflows on AI enthusiasm", summary: "Nasdaq-100 trackers benefit from investor appetite for technology stocks.", source: "Demo Funds Wire", related: ["QQQ"] },
  { tag: "obligations", headline: "Sovereign yields ease slightly following Fed comments", summary: "The US 10-year Treasury yield retreats as markets anticipate a pause in the rate-hiking cycle.", source: "Demo Rates Wire", related: ["UST10"] },
  { tag: "obligations", headline: "French OATs: spread versus German Bund under close watch", summary: "Investors are monitoring France's fiscal trajectory, which directly influences the cost of government debt.", source: "Demo Rates Wire", related: ["OAT10"] },
  { tag: "matieres-premieres", headline: "Gold hits new high as investors seek safe haven", summary: "The yellow metal benefits from geopolitical uncertainty and expectations of lower real interest rates.", source: "Demo Commodities Wire", related: [] },
  { tag: "matieres-premieres", headline: "Oil retreats on global demand concerns", summary: "Brent crude loses ground after weaker-than-expected Chinese economic data.", source: "Demo Commodities Wire", related: [] },
  { tag: "devises", headline: "Euro stabilizes against dollar ahead of inflation figures", summary: "The EUR/USD pair trades in a narrow range as traders await upcoming US inflation data.", source: "Demo FX Wire", related: [] },
  { tag: "devises", headline: "Yen remains under pressure despite warnings from Japanese authorities", summary: "The Japanese currency continues to depreciate against the dollar, fueling speculation of a Bank of Japan intervention.", source: "Demo FX Wire", related: [] },
  { tag: "crypto", headline: "Bitcoin takes a breather after a volatile week", summary: "The leading cryptocurrency continues to trade in a wide range, with investors watching spot ETF flows.", source: "Demo Crypto Wire", related: ["BTC"] },
  { tag: "crypto", headline: "Ethereum: on-chain activity picks up again", summary: "Daily transaction volume rises, driven by the DeFi ecosystem and new staking protocols.", source: "Demo Crypto Wire", related: ["ETH"] },
  { tag: "entreprises", headline: "Wave of M&A activity expected in European banking sector", summary: "Several institutions are reportedly studying mergers to gain scale in the face of competition from US giants.", source: "Demo Business Wire", related: ["BNP.PA", "GLE.PA"] },
  { tag: "entreprises", headline: "Highly anticipated tech IPO could revive the listings market", summary: "Investors are closely watching the operation, which could reopen the IPO window after a quiet year.", source: "Demo Business Wire", related: [] },
];

function demoRelated(symbols) {
  return symbols.map(sym => {
    const meta = KNOWN_ASSETS.find(a => a.symbol === sym);
    return meta ? { symbol: meta.symbol, name: meta.name, assetClass: meta.class } : null;
  }).filter(Boolean);
}

function buildDemoMarketFeed() {
  const now = Date.now();
  return DEMO_ITEMS.map((it, i) => {
    const related = demoRelated(it.related);
    const text = `${it.headline} ${it.summary}`;
    return {
      id: `demo-${i}`,
      tags: deriveTags(text, it.tag, related.some(r => r.assetClass === "stock")),
      category: it.tag,
      headline: it.headline,
      summary: it.summary,
      source: it.source,
      url: null,
      image: null,
      datetime: now - i * 47 * 60_000,
      relatedSymbols: related,
      personalized: false,
    };
  });
}

const DEMO_PORTFOLIO_TEMPLATES = {
  crypto: sym => [{ headline: `${sym}: volatility remains high in crypto markets`, summary: "Analysts note that swings of more than 10% in a week remain the norm for this asset class.", source: "Demo Crypto Wire" }],
  bond: sym => [{ headline: `${sym}: bond yields stabilize`, summary: "The rates market is pricing in the latest central bank announcements; government bonds remain the reference safe-haven asset.", source: "Demo Rates Wire" }],
  etf: sym => [{ headline: `${sym}: inflows remain solid this quarter`, summary: "This tracker continues to attract investors seeking low-cost diversification.", source: "Demo Funds Wire" }],
  default: sym => [
    { headline: `${sym}: quarterly results beat consensus estimates`, summary: "Revenue and margins slightly exceeded analyst expectations; annual guidance is maintained.", source: "Demo Business Wire" },
    { headline: `${sym} announces strategic partnership`, summary: "The company signed a multi-year agreement set to open a new distribution channel in Europe.", source: "Demo Business Wire" },
  ],
};
function demoPortfolioFeed(symbols) {
  const now = Date.now();
  return symbols.flatMap((sym, i) => {
    const meta = KNOWN_ASSETS.find(a => a.symbol === sym);
    const tpl = DEMO_PORTFOLIO_TEMPLATES[meta?.class] || DEMO_PORTFOLIO_TEMPLATES.default;
    return tpl(sym).map((n, j) => {
      const text = `${n.headline} ${n.summary}`;
      const tag = assetTagFor(sym);
      return {
        id: `demo-portfolio-${sym}-${j}`,
        tags: deriveTags(text, tag, meta?.class === "stock"),
        category: tag,
        headline: n.headline, summary: n.summary, source: n.source,
        url: null, image: null,
        datetime: now - (i * 3 + j) * 3_600_000,
        relatedSymbols: meta ? [{ symbol: meta.symbol, name: meta.name, assetClass: meta.class }] : [],
        personalized: true,
      };
    });
  });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
function dedupe(items) {
  const seen = new Set();
  return items.filter(it => (seen.has(it.headline) ? false : (seen.add(it.headline), true)));
}
function sortDesc(items) { return items.slice().sort((a, b) => b.datetime - a.datetime); }
function markPersonalized(items, heldSet) {
  if (!heldSet.size) return items;
  return items.map(it => it.personalized || it.relatedSymbols.some(r => heldSet.has(r.symbol))
    ? { ...it, personalized: true } : it);
}

async function marketFeed() {
  if (DEMO_MODE) return buildDemoMarketFeed();
  const [general, crypto, forex, merger] = await Promise.all([
    fetchCategory("general", "marches"),
    fetchCategory("crypto", "crypto"),
    fetchCategory("forex", "devises"),
    fetchCategory("merger", "entreprises"),
  ]);
  return dedupe([...general, ...crypto, ...forex, ...merger]);
}

async function portfolioFeed(symbols) {
  if (!symbols.length) return [];
  if (DEMO_MODE) return demoPortfolioFeed(symbols.slice(0, 10));
  const lists = await Promise.all(symbols.slice(0, 10).map(fetchCompanyNews));
  return dedupe(lists.flat());
}

/**
 * @param {{ category: string, heldSymbols: string[] }} opts
 * @returns {Promise<object[]>} normalized, sorted (most recent first) news items
 */
export async function getMarketNews({ category = "all", heldSymbols = [] }) {
  const heldSet = new Set(heldSymbols);

  if (category === "portfolio") {
    return sortDesc(await portfolioFeed(heldSymbols));
  }

  const market = await marketFeed();
  const marked = markPersonalized(market, heldSet);

  if (category === "all") {
    const portfolio = heldSymbols.length ? await portfolioFeed(heldSymbols) : [];
    return sortDesc(dedupe([...portfolio, ...marked])).slice(0, 80);
  }

  return sortDesc(marked.filter(it => it.tags.includes(category))).slice(0, 60);
}