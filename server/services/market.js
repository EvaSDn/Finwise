/**
 * Market data service — multi-actifs (actions, ETF, crypto, obligations).
 *  - Mode live : Finnhub (FINNHUB_API_KEY) avec caches (quotes 15 s, profils 24 h).
 *    IMPORTANT : le plan gratuit Finnhub ne couvre que les actions US ; pour tout
 *    symbole sans données (actions EU, etc.), on retombe sur un cours simulé
 *    déterministe, marqué { simulated: true } — plus jamais de fiche vide.
 *  - Mode démo : marché simulé déterministe (random walk seedé par symbole).
 */
const API_KEY = process.env.FINNHUB_API_KEY || "";
export const DEMO_MODE = !API_KEY;

const BASE = "https://finnhub.io/api/v1";

/* ------------------------------------------------------------------ */
/* Univers connu : sert de base au mode démo ET de métadonnées        */
/* (classe d'actif, secteur, pays) dans les deux modes.               */
/* ------------------------------------------------------------------ */
export const KNOWN_ASSETS = [
  /* --- Actions US --- */
  { symbol: "AAPL", name: "Apple Inc.", class: "stock", sector: "Technology", country: "US", base: 231 },
  { symbol: "MSFT", name: "Microsoft Corp.", class: "stock", sector: "Technology", country: "US", base: 442 },
  { symbol: "NVDA", name: "NVIDIA Corp.", class: "stock", sector: "Technology", country: "US", base: 187 },
  { symbol: "GOOGL", name: "Alphabet Inc.", class: "stock", sector: "Technology", country: "US", base: 178 },
  { symbol: "META", name: "Meta Platforms", class: "stock", sector: "Technology", country: "US", base: 592 },
  { symbol: "AMZN", name: "Amazon.com Inc.", class: "stock", sector: "Consumer", country: "US", base: 205 },
  { symbol: "TSLA", name: "Tesla Inc.", class: "stock", sector: "Consumer", country: "US", base: 265 },
  { symbol: "NFLX", name: "Netflix Inc.", class: "stock", sector: "Technology", country: "US", base: 890 },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", class: "stock", sector: "Finance", country: "US", base: 248 },
  { symbol: "GS", name: "Goldman Sachs", class: "stock", sector: "Finance", country: "US", base: 585 },
  { symbol: "V", name: "Visa Inc.", class: "stock", sector: "Finance", country: "US", base: 291 },
  { symbol: "MA", name: "Mastercard Inc.", class: "stock", sector: "Finance", country: "US", base: 512 },
  { symbol: "JNJ", name: "Johnson & Johnson", class: "stock", sector: "Healthcare", country: "US", base: 158 },
  { symbol: "PFE", name: "Pfizer Inc.", class: "stock", sector: "Healthcare", country: "US", base: 27 },
  { symbol: "LLY", name: "Eli Lilly & Co.", class: "stock", sector: "Healthcare", country: "US", base: 782 },
  { symbol: "XOM", name: "Exxon Mobil Corp.", class: "stock", sector: "Energy", country: "US", base: 118 },
  { symbol: "CVX", name: "Chevron Corp.", class: "stock", sector: "Energy", country: "US", base: 152 },
  { symbol: "KO", name: "Coca-Cola Co.", class: "stock", sector: "Consumer", country: "US", base: 63 },
  { symbol: "PEP", name: "PepsiCo Inc.", class: "stock", sector: "Consumer", country: "US", base: 152 },
  { symbol: "MCD", name: "McDonald's Corp.", class: "stock", sector: "Consumer", country: "US", base: 295 },
  { symbol: "NKE", name: "Nike Inc.", class: "stock", sector: "Consumer", country: "US", base: 76 },
  { symbol: "DIS", name: "Walt Disney Co.", class: "stock", sector: "Consumer", country: "US", base: 112 },
  { symbol: "BA", name: "Boeing Co.", class: "stock", sector: "Industrials", country: "US", base: 178 },
  { symbol: "CAT", name: "Caterpillar Inc.", class: "stock", sector: "Industrials", country: "US", base: 385 },
  /* --- Actions françaises / européennes (CAC 40 & co) --- */
  { symbol: "MC.PA", name: "LVMH", class: "stock", sector: "Consumer", country: "FR", base: 612 },
  { symbol: "OR.PA", name: "L'Oréal", class: "stock", sector: "Consumer", country: "FR", base: 348 },
  { symbol: "RMS.PA", name: "Hermès International", class: "stock", sector: "Consumer", country: "FR", base: 2280 },
  { symbol: "TTE.PA", name: "TotalEnergies SE", class: "stock", sector: "Energy", country: "FR", base: 59 },
  { symbol: "SAN.PA", name: "Sanofi", class: "stock", sector: "Healthcare", country: "FR", base: 92 },
  { symbol: "BNP.PA", name: "BNP Paribas", class: "stock", sector: "Finance", country: "FR", base: 64 },
  { symbol: "ACA.PA", name: "Crédit Agricole", class: "stock", sector: "Finance", country: "FR", base: 15 },
  { symbol: "GLE.PA", name: "Société Générale", class: "stock", sector: "Finance", country: "FR", base: 28 },
  { symbol: "AIR.PA", name: "Airbus SE", class: "stock", sector: "Industrials", country: "FR", base: 172 },
  { symbol: "SAF.PA", name: "Safran", class: "stock", sector: "Industrials", country: "FR", base: 218 },
  { symbol: "SU.PA", name: "Schneider Electric", class: "stock", sector: "Industrials", country: "FR", base: 238 },
  { symbol: "CAP.PA", name: "Capgemini", class: "stock", sector: "Technology", country: "FR", base: 158 },
  { symbol: "DSY.PA", name: "Dassault Systèmes", class: "stock", sector: "Technology", country: "FR", base: 34 },
  { symbol: "STLAP.PA", name: "Stellantis", class: "stock", sector: "Consumer", country: "FR", base: 12 },
  { symbol: "CA.PA", name: "Carrefour", class: "stock", sector: "Consumer", country: "FR", base: 14 },
  { symbol: "ENGI.PA", name: "Engie", class: "stock", sector: "Energy", country: "FR", base: 16 },
  { symbol: "ASML", name: "ASML Holding", class: "stock", sector: "Technology", country: "NL", base: 712 },
  { symbol: "SAP", name: "SAP SE", class: "stock", sector: "Technology", country: "DE", base: 242 },
  /* --- ETF --- */
  { symbol: "CW8.PA", name: "Amundi MSCI World — ETF Monde", class: "etf", sector: "Diversifié", country: "Monde", base: 528 },
  { symbol: "ESE.PA", name: "BNP Paribas S&P 500 — ETF", class: "etf", sector: "Diversifié", country: "US", base: 29 },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", class: "etf", sector: "Diversifié", country: "US", base: 612 },
  { symbol: "QQQ", name: "Invesco Nasdaq-100 ETF", class: "etf", sector: "Technology", country: "US", base: 528 },
  { symbol: "PAEEM.PA", name: "Amundi Marchés Émergents (ETF)", class: "etf", sector: "Diversifié", country: "Émergents", base: 24 },
  /* --- Crypto-actifs --- */
  { symbol: "BTC", name: "Bitcoin", class: "crypto", sector: "Crypto", country: "—", base: 97800, live: "BINANCE:BTCUSDT" },
  { symbol: "ETH", name: "Ethereum", class: "crypto", sector: "Crypto", country: "—", base: 3420, live: "BINANCE:ETHUSDT" },
  { symbol: "SOL", name: "Solana", class: "crypto", sector: "Crypto", country: "—", base: 218, live: "BINANCE:SOLUSDT" },
  { symbol: "XRP", name: "XRP", class: "crypto", sector: "Crypto", country: "—", base: 2.4, live: "BINANCE:XRPUSDT" },
  { symbol: "ADA", name: "Cardano", class: "crypto", sector: "Crypto", country: "—", base: 0.92, live: "BINANCE:ADAUSDT" },
  { symbol: "DOGE", name: "Dogecoin", class: "crypto", sector: "Crypto", country: "—", base: 0.31, live: "BINANCE:DOGEUSDT" },
  /* --- Obligations & taux (produits pédagogiques simulés, faible volatilité) --- */
  { symbol: "OAT10", name: "OAT France 10 ans (simulé)", class: "bond", sector: "Obligations", country: "FR", base: 98.6, vol: 0.001, yieldPct: 3.1 },
  { symbol: "BUND10", name: "Bund Allemagne 10 ans (simulé)", class: "bond", sector: "Obligations", country: "DE", base: 99.2, vol: 0.001, yieldPct: 2.4 },
  { symbol: "UST10", name: "Bon du Trésor US 10 ans (simulé)", class: "bond", sector: "Obligations", country: "US", base: 97.8, vol: 0.001, yieldPct: 4.3 },
];
const BY_SYMBOL = new Map(KNOWN_ASSETS.map(s => [s.symbol, s]));

/* pseudo-aléatoire seedé : chaque symbole a une trajectoire stable */
function seeded(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/* état simulé par symbole : prix + sparkline glissante (30 points) */
const simState = new Map();
function baseFor(symbol) {
  const meta = BY_SYMBOL.get(symbol);
  if (meta) return { base: meta.base, vol: meta.vol ?? (meta.class === "crypto" ? 0.05 : 0.02) };
  // symbole inconnu : prix de base déterministe plausible dérivé du nom
  const rnd = seeded("base:" + symbol);
  return { base: +(8 + rnd() * 300).toFixed(2), vol: 0.02 };
}
function sim(symbol) {
  if (!simState.has(symbol)) {
    const { base, vol } = baseFor(symbol);
    const rnd = seeded(symbol);
    let p = base;
    const spark = [];
    for (let i = 0; i < 30; i++) { p *= 1 + (rnd() - 0.5) * vol; spark.push(+p.toFixed(p < 5 ? 4 : 2)); }
    simState.set(symbol, { price: spark[29], prevClose: spark[28], spark, rnd, vol, lastTick: Date.now() });
  }
  return simState.get(symbol);
}
function tick(symbol) {
  const s = sim(symbol);
  const now = Date.now();
  if (now - s.lastTick > 10_000) {
    s.lastTick = now;
    s.price = +(s.price * (1 + (s.rnd() - 0.5) * s.vol * 0.3)).toFixed(s.price < 5 ? 4 : 2);
    s.spark.push(s.price);
    if (s.spark.length > 30) s.spark.shift();
  }
  return s;
}
function simulatedQuote(symbol) {
  const s = tick(symbol);
  return {
    symbol, price: s.price,
    changePct: +(((s.price - s.prevClose) / s.prevClose) * 100).toFixed(2),
    prevClose: s.prevClose, simulated: true,
  };
}

/* ------------------------------------------------------------------ */
/* Mode live                                                           */
/* ------------------------------------------------------------------ */
const quoteCache = new Map(), profileCache = new Map(), sparkHistory = new Map();
const searchProfileHints = new Map(); // symbol -> description vue dans la recherche
const QUOTE_TTL = 15_000, PROFILE_TTL = 24 * 3600_000;

async function finnhub(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FINNHUB_${res.status}`);
  return res.json();
}

const SECTOR_MAP = {
  "Technology": "Technology", "Semiconductors": "Technology", "Media": "Technology",
  "Communication Services": "Technology", "Software": "Technology",
  "Pharmaceuticals": "Healthcare", "Health Care": "Healthcare", "Biotechnology": "Healthcare",
  "Banking": "Finance", "Financial Services": "Finance", "Insurance": "Finance",
  "Energy": "Energy", "Oil & Gas": "Energy", "Utilities": "Energy",
  "Retail": "Consumer", "Consumer products": "Consumer", "Automobiles": "Consumer",
  "Beverages": "Consumer", "Textiles, Apparel & Luxury Goods": "Consumer", "Hotels": "Consumer",
  "Aerospace & Defense": "Industrials", "Machinery": "Industrials",
  "Industrials": "Industrials", "Airlines": "Industrials", "Logistics": "Industrials",
};
function normalizeSector(raw) {
  if (!raw) return "Other";
  if (SECTOR_MAP[raw]) return SECTOR_MAP[raw];
  const k = Object.keys(SECTOR_MAP).find(x => raw.includes(x));
  return k ? SECTOR_MAP[k] : "Other";
}

/* ------------------------------------------------------------------ */
/* Twelve Data (optionnel) — second fournisseur gratuit utilisé en repli    */
/* pour les actions/ETF européens et asiatiques, hors couverture Finnhub    */
/* gratuite (US uniquement). Voir https://twelvedata.com (clé gratuite,    */
/* 8 req/min, 800/jour). Sans clé configurée, cette étape est simplement   */
/* ignorée et le comportement existant (repli vers le cours simulé) reste  */
/* inchangé.                                                                */
/* ------------------------------------------------------------------ */
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";
const TWELVEDATA_BASE = "https://api.twelvedata.com";

// Twelve Data désambiguïse un ticker par place boursière via son paramètre
// `exchange` plutôt que par un suffixe façon ".PA". Mapping suffixe → nom
// d'exchange, vérifié le 2026-07-16 par appel réel à /symbol_search
// (Air Liquide/AI.PA → symbol "AI", exchange "Euronext" ; ADR allemandes →
// exchange "XETR", pas "XETRA"). Le reste (SW/MI/T/HK) n'est pas encore
// vérifié — voir AUDIT.md.
const SUFFIX_EXCHANGE = {
  PA: "Euronext", AS: "Euronext", BR: "Euronext", LS: "Euronext",
  DE: "XETR", L: "LSE", SW: "SIX", MI: "Milan", T: "Tokyo", HK: "HKEX",
};
// Rempli à la volée par twelveDataSearch() : symbole -> {exchange, mic_code}
// tels que renvoyés par Twelve Data lui-même pour CE symbole précis — plus
// fiable que le mapping générique par suffixe ci-dessus quand disponible.
const twelveDataExchangeHints = new Map();

function symbolAttempts(symbol) {
  const attempts = [];
  const hint = twelveDataExchangeHints.get(symbol);
  const base = symbol.includes(".") ? symbol.split(".")[0] : symbol;
  const suffix = symbol.includes(".") ? symbol.split(".").pop().toUpperCase() : null;
  if (hint) attempts.push({ symbol: hint.symbol || base, exchange: hint.exchange, mic_code: hint.mic_code });
  if (suffix && SUFFIX_EXCHANGE[suffix]) attempts.push({ symbol: base, exchange: SUFFIX_EXCHANGE[suffix] });
  attempts.push({ symbol }); // dernier recours : tel quel
  return attempts;
}

async function twelveDataQuote(symbol) {
  if (!TWELVEDATA_KEY) return null;
  for (const attempt of symbolAttempts(symbol)) {
    try {
      const url = new URL(`${TWELVEDATA_BASE}/quote`);
      url.searchParams.set("symbol", attempt.symbol);
      if (attempt.exchange) url.searchParams.set("exchange", attempt.exchange);
      else if (attempt.mic_code) url.searchParams.set("mic_code", attempt.mic_code);
      url.searchParams.set("apikey", TWELVEDATA_KEY);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const q = await res.json();
      if (!q || q.status === "error" || q.close == null) continue;
      return {
        symbol, price: +q.close,
        changePct: q.percent_change != null ? +(+q.percent_change).toFixed(2) : 0,
        prevClose: q.previous_close != null ? +q.previous_close : +q.close,
        simulated: false,
      };
    } catch { /* on tente le format suivant, ou on abandonne */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Yahoo Finance (non officiel) — sans clé, sans quota documenté.       */
/* Endpoint public utilisé par la librairie yfinance, hors des CGU      */
/* officielles de Yahoo pour un usage automatisé (risque connu et       */
/* largement accepté par la communauté pour ce type de projet). Accepte */
/* directement le même format de symbole que le reste de l'app          */
/* ("MC.PA", "AI.PA"…) — vérifié le 2026-07-16 en conditions réelles,   */
/* aucun mapping suffixe/exchange nécessaire contrairement à Twelve     */
/* Data. Placé après Finnhub et avant Twelve Data dans la cascade de     */
/* repli : c'est la source la plus fiable pour l'Europe/l'Asie à date.  */
/* ------------------------------------------------------------------ */
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

async function yahooQuote(symbol) {
  try {
    const res = await fetch(`${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    return {
      symbol, price: meta.regularMarketPrice,
      changePct: prevClose ? +(((meta.regularMarketPrice - prevClose) / prevClose) * 100).toFixed(2) : 0,
      prevClose, simulated: false,
    };
  } catch {
    return null; // on retombe sur Twelve Data, puis le cours simulé
  }
}

const TD_TYPE_TO_CLASS = { "Common Stock": "stock", "ETF": "etf", "Investment Trust": "etf" };
async function twelveDataSearch(q) {
  if (!TWELVEDATA_KEY) return [];
  try {
    const url = new URL(`${TWELVEDATA_BASE}/symbol_search`);
    url.searchParams.set("symbol", q);
    url.searchParams.set("apikey", TWELVEDATA_KEY);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    // On mémorise l'exchange/mic_code réels de Twelve Data pour ce symbole
    // précis : réutilisé par twelveDataQuote() pour interroger /quote avec
    // les bons paramètres au lieu de deviner à partir d'un suffixe générique.
    for (const x of data?.data || []) {
      if (x.symbol) twelveDataExchangeHints.set(x.symbol, { symbol: x.symbol, exchange: x.exchange, mic_code: x.mic_code });
    }
    return (data?.data || []).slice(0, 10).map(x => ({
      symbol: x.symbol,
      description: x.instrument_name ? `${x.instrument_name}${x.exchange ? " · " + x.exchange : ""}` : x.symbol,
      assetClass: TD_TYPE_TO_CLASS[x.instrument_type] || "stock",
    }));
  } catch {
    return []; // recherche Finnhub/locale seules
  }
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */
export async function getQuote(symbol) {
  const meta = BY_SYMBOL.get(symbol);
  if (DEMO_MODE) return simulatedQuote(symbol);

  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.at < QUOTE_TTL) return cached.data;

  // crypto : Finnhub attend un symbole d'exchange (BINANCE:BTCUSDT)
  const liveSym = meta?.live || symbol;
  let data = null;
  try {
    const q = await finnhub("/quote", { symbol: liveSym });
    if (q && q.c) {
      data = { symbol, price: q.c, changePct: +(q.dp ?? 0).toFixed(2), prevClose: q.pc, simulated: false };
    }
  } catch { /* on tente les fournisseurs suivants, puis le simulé */ }
  // Yahoo Finance (non officiel, sans clé) : comble les actions
  // européennes/asiatiques hors couverture Finnhub gratuite (US uniquement).
  // Vérifié fonctionnel en conditions réelles le 2026-07-16.
  if (!data) data = await yahooQuote(symbol);
  // Twelve Data en dernier recours avant le simulé (utile si une clé payante
  // est ajoutée un jour ; sur le plan gratuit, les actions EU y sont bloquées
  // — voir AUDIT.md section 0.4).
  if (!data) data = await twelveDataQuote(symbol);
  // Fallback final : jamais de fiche vide → cours simulé déterministe,
  // clairement marqué.
  if (!data) data = simulatedQuote(symbol);

  quoteCache.set(symbol, { at: Date.now(), data });
  const hist = sparkHistory.get(symbol) || [];
  if (hist[hist.length - 1] !== data.price) { hist.push(data.price); if (hist.length > 30) hist.shift(); }
  sparkHistory.set(symbol, hist);
  return data;
}

export async function getQuotes(symbols) {
  const out = {};
  await Promise.all(symbols.map(async sym => {
    try { out[sym] = await getQuote(sym); } catch { /* skip */ }
  }));
  return out;
}

export async function getProfile(symbol) {
  const meta = BY_SYMBOL.get(symbol);
  if (meta) {
    return { symbol, name: meta.name, sector: meta.sector, country: meta.country, assetClass: meta.class, yieldPct: meta.yieldPct ?? null };
  }
  if (DEMO_MODE) {
    // symbole hors univers connu : fiche générique simulée (jamais de 404 après recherche)
    return { symbol, name: searchProfileHints.get(symbol) || symbol, sector: "Other", country: "—", assetClass: "stock", yieldPct: null };
  }
  const cached = profileCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.data;
  let data = null;
  try {
    const p = await finnhub("/stock/profile2", { symbol });
    if (p && p.name) {
      data = {
        symbol, name: p.name,
        sector: normalizeSector(p.finnhubIndustry),
        country: p.country || "—", assetClass: "stock", yieldPct: null,
        currency: p.currency, logo: p.logo, exchange: p.exchange,
      };
    }
  } catch { /* fallback dessous */ }
  if (!data) {
    // profil indisponible (rate limit, action non-US…) → fiche minimale
    data = { symbol, name: searchProfileHints.get(symbol) || symbol, sector: "Other", country: symbol.includes(".PA") ? "FR" : "—", assetClass: "stock", yieldPct: null };
  }
  profileCache.set(symbol, { at: Date.now(), data });
  return data;
}

const CLASS_LABEL = { stock: "Action", etf: "ETF", crypto: "Crypto", bond: "Obligation" };

// Yahoo Finance (recherche non officielle) : source principale de la
// recherche live — un seul fournisseur, cohérent avec yahooQuote() (mêmes
// symboles, pas de mapping exchange à deviner), résultats déjà triés par
// pertinence. Vérifié en conditions réelles le 2026-07-16.
const YAHOO_SEARCH_TYPE_TO_CLASS = { EQUITY: "stock", ETF: "etf", CRYPTOCURRENCY: "crypto" };
async function yahooSearch(q) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    // Yahoo renvoie toutes les cotations croisées d'une même entreprise
    // (Paris, OTC US, ADR Francfort…) triées par pertinence : on ne garde
    // que la première (la plus pertinente) par entreprise, pour ne pas
    // noyer l'utilisateur sous des doublons.
    const seenCompany = new Set();
    const out = [];
    for (const x of data?.quotes || []) {
      const assetClass = YAHOO_SEARCH_TYPE_TO_CLASS[x.quoteType];
      if (!assetClass || !x.symbol) continue;
      const companyKey = (x.longname || x.shortname || x.symbol).toLowerCase();
      if (seenCompany.has(companyKey)) continue;
      seenCompany.add(companyKey);
      out.push({
        symbol: x.symbol,
        description: `${x.longname || x.shortname || x.symbol}${x.exchDisp ? " · " + x.exchDisp : ""}`,
        assetClass,
      });
    }
    return out.slice(0, 10);
  } catch {
    return []; // recherche Finnhub/Twelve Data/locale en repli
  }
}

// Cache court (60 s) sur les requêtes de recherche : évite de retaper les
// fournisseurs à chaque frappe pour la même requête.
const searchCache = new Map();
const SEARCH_TTL = 60_000;

export async function searchSymbols(q) {
  const needle = q.toLowerCase();
  const localHits = KNOWN_ASSETS
    .filter(s => s.symbol.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle))
    .map(s => ({ symbol: s.symbol, description: s.name, assetClass: s.class }));

  if (DEMO_MODE) return localHits.slice(0, 10);

  const cached = searchCache.get(needle);
  let remote;
  if (cached && Date.now() - cached.at < SEARCH_TTL) {
    remote = cached.remote;
  } else {
    remote = await yahooSearch(q);
    if (!remote.length) {
      // Yahoo indisponible ou aucun résultat : repli sur Finnhub + Twelve Data.
      const [finnhubResult, tdResult] = await Promise.allSettled([
        finnhub("/search", { q }),
        twelveDataSearch(q),
      ]);
      const finnhubHits = finnhubResult.status === "fulfilled"
        ? (finnhubResult.value?.result || [])
          .filter(x => !x.type || x.type === "Common Stock" || x.type === "ETP")
          .slice(0, 10)
          .map(x => ({ symbol: x.symbol, description: x.description, assetClass: x.type === "ETP" ? "etf" : "stock" }))
        : [];
      const tdHits = tdResult.status === "fulfilled" ? tdResult.value : [];
      const seenRemote = new Set();
      remote = [...finnhubHits, ...tdHits].filter(x => (seenRemote.has(x.symbol) ? false : (seenRemote.add(x.symbol), true)));
    }
    remote.forEach(x => searchProfileHints.set(x.symbol, x.description));
    searchCache.set(needle, { at: Date.now(), remote });
  }

  // Résultats live prioritaires ; la liste figée ne comble que ce qu'aucun
  // fournisseur ne couvre bien en gratuit (crypto majeures, obligations simulées).
  const seen = new Set();
  const merged = [];
  for (const item of [...remote, ...localHits]) {
    if (seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    merged.push(item);
  }
  return merged.slice(0, 10);
}

export function assetClassLabel(cls) { return CLASS_LABEL[cls] || "Action"; }

/** Historique de prix récent pour les mini-graphes (synchrone). */
export function getSparkline(symbol) {
  if (DEMO_MODE) return sim(symbol).spark.slice();
  const hist = sparkHistory.get(symbol);
  if (hist && hist.length >= 8) return hist.slice();
  const q = quoteCache.get(symbol)?.data;
  if (q?.simulated) return sim(symbol).spark.slice();
  if (!q) return [];
  return [q.prevClose ?? q.price, q.price];
}