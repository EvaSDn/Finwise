/**
 * News service — real financial news across every asset class.
 *
 *  - Portfolio feed : Finnhub company-news, filtered to the symbols the
 *    user actually holds (personalized).
 *  - Market feed : Finnhub category endpoints (general / crypto / forex /
 *    merger — the four categories the free plan exposes), each tagged with
 *    finer-grained topics (actions, etf, obligations, matières premières,
 *    devises, entreprises) via keyword heuristics, since Finnhub's free
 *    tier has no dedicated "bonds" or "commodities" feed.
 *  - Every article is scanned for mentions of known tickers/companies so
 *    the client can show "entreprises concernées" and highlight articles
 *    that relate to the user's holdings.
 *  - No API key -> demo mode: a realistic, fully offline multi-category
 *    feed so the section is never empty.
 */
import { DEMO_MODE, KNOWN_ASSETS } from "./market.js";

const API_KEY = process.env.FINNHUB_API_KEY || "";
const BASE = "https://finnhub.io/api/v1";

export const NEWS_CATEGORIES = [
  { id: "all", label: "Tout" },
  { id: "portfolio", label: "Mon portefeuille" },
  { id: "marches", label: "Marchés" },
  { id: "actions", label: "Actions" },
  { id: "etf", label: "ETF" },
  { id: "obligations", label: "Obligations" },
  { id: "matieres-premieres", label: "Matières premières" },
  { id: "devises", label: "Devises" },
  { id: "crypto", label: "Cryptomonnaies" },
  { id: "entreprises", label: "Entreprises" },
];
const VALID_TAGS = new Set(NEWS_CATEGORIES.map(c => c.id));

/* ------------------------------------------------------------------ */
/* Entreprises/actifs mentionnés — détection par mots-clés             */
/* ------------------------------------------------------------------ */
const ASSET_MATCHERS = KNOWN_ASSETS
  .filter(a => a.class !== "bond") // "France", "Allemagne"... trop de faux positifs
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
/* Tags thématiques (une actualité peut couvrir plusieurs sujets)      */
/* ------------------------------------------------------------------ */
const KEYWORD_TAGS = [
  { tag: "obligations", re: /\bobligation|\bbond(s)?\b|treasury|\byield(s)?\b|rendement obligataire|\bbund\b|\bgilt\b|taux directeur|banque centrale|\bfed\b|\bbce\b|oat\b/i },
  { tag: "etf", re: /\betf\b|tracker|fonds indiciel/i },
  { tag: "matieres-premieres", re: /\bor\b|\bgold\b|p[eé]trole|\boil\b|\bbrent\b|\bwti\b|gaz naturel|natural gas|\bcuivre\b|\bcopper\b|\bbl[eé]\b|\bwheat\b|mati[eè]re[s]? premi[eè]re|\bcommodit(y|ies)\b/i },
  { tag: "devises", re: /\bforex\b|\bdevise[s]?\b|\bdollar\b|\beuro\b|eur\/usd|\byen\b|livre sterling|taux de change|exchange rate/i },
  { tag: "entreprises", re: /acquisition|\bmerger\b|fusion|rachat|\bipo\b|introduction en bourse|opa\b/i },
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
const CACHE_TTL = 5 * 60_000;   // marché : 5 min (quasi temps réel, respecte le quota gratuit)
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
    headline: raw.headline || "(sans titre)",
    summary: raw.summary || "",
    source: raw.source || "",
    url: raw.url || null,
    image: raw.image || null,
    datetime: (raw.datetime || Math.floor(Date.now() / 1000)) * 1000,
    relatedSymbols: related,
    personalized: false,
  };
}

/** Un des 4 flux Finnhub gratuits : general, crypto, forex, merger. */
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
/* Mode démo (aucune clé API) — flux réaliste et intégralement local   */
/* ------------------------------------------------------------------ */
const DEMO_ITEMS = [
  { tag: "marches", headline: "Les indices européens clôturent en légère hausse, portés par les valeurs bancaires", summary: "Le CAC 40 et le DAX progressent alors que les investisseurs digèrent les derniers indicateurs d'inflation avant la prochaine réunion des banques centrales.", source: "Demo Markets Wire", related: [] },
  { tag: "marches", headline: "Wall Street hésite avant la publication des résultats trimestriels des grandes technologiques", summary: "Le S&P 500 et le Nasdaq évoluent proches de l'équilibre, les investisseurs restant prudents à l'approche des résultats d'Apple, Microsoft et Amazon.", source: "Demo Markets Wire", related: ["AAPL", "MSFT", "AMZN"] },
  { tag: "actions", headline: "LVMH : le marché du luxe montre des signes de reprise en Asie", summary: "Le groupe de luxe français a vu ses ventes se stabiliser sur la zone Asie-Pacifique, un signal encourageant après plusieurs trimestres difficiles.", source: "Demo Business Wire", related: ["MC.PA"] },
  { tag: "actions", headline: "NVIDIA : la demande de puces pour l'IA reste soutenue", summary: "Les analystes relèvent leurs objectifs de cours après des commentaires optimistes de plusieurs grands fournisseurs de cloud sur leurs investissements en infrastructure IA.", source: "Demo Tech Wire", related: ["NVDA"] },
  { tag: "actions", headline: "Airbus confirme ses objectifs de livraisons annuelles", summary: "L'avionneur européen a réaffirmé ses prévisions malgré des tensions persistantes sur sa chaîne d'approvisionnement.", source: "Demo Business Wire", related: ["AIR.PA"] },
  { tag: "etf", headline: "Les ETF Monde continuent d'attirer les flux des investisseurs particuliers", summary: "Les trackers répliquant l'indice MSCI World ont enregistré une nouvelle collecte record ce trimestre, portés par l'essor de l'investissement programmé (DCA).", source: "Demo Funds Wire", related: ["CW8.PA"] },
  { tag: "etf", headline: "ETF sectoriels technologiques : forte collecte sur fond d'engouement pour l'IA", summary: "Les trackers exposés au Nasdaq-100 profitent de l'appétit des investisseurs pour les valeurs technologiques.", source: "Demo Funds Wire", related: ["QQQ"] },
  { tag: "obligations", headline: "Les taux souverains se détendent légèrement après les propos de la Fed", summary: "Le rendement des bons du Trésor américain à 10 ans recule alors que les marchés anticipent une pause dans le cycle de hausse des taux directeurs.", source: "Demo Rates Wire", related: ["UST10"] },
  { tag: "obligations", headline: "OAT françaises : l'écart avec le Bund allemand sous surveillance", summary: "Les investisseurs surveillent de près la trajectoire budgétaire française, qui influence directement le coût de la dette de l'État.", source: "Demo Rates Wire", related: ["OAT10"] },
  { tag: "matieres-premieres", headline: "L'or atteint un nouveau plus haut, valeur refuge plébiscitée", summary: "Le métal jaune profite des incertitudes géopolitiques et des anticipations de baisse des taux réels.", source: "Demo Commodities Wire", related: [] },
  { tag: "matieres-premieres", headline: "Le pétrole recule sur fond de craintes pour la demande mondiale", summary: "Le Brent cède du terrain après des données économiques chinoises plus faibles qu'attendu.", source: "Demo Commodities Wire", related: [] },
  { tag: "devises", headline: "L'euro se stabilise face au dollar avant les statistiques d'inflation", summary: "La paire EUR/USD évolue dans un range étroit, les cambistes attendant les prochains chiffres de l'inflation américaine.", source: "Demo FX Wire", related: [] },
  { tag: "devises", headline: "Le yen reste sous pression malgré les avertissements des autorités japonaises", summary: "La devise nippone continue de se déprécier face au dollar, ravivant les spéculations sur une intervention de la Banque du Japon.", source: "Demo FX Wire", related: [] },
  { tag: "crypto", headline: "Bitcoin reprend son souffle après une semaine volatile", summary: "La première cryptomonnaie oscille toujours dans une fourchette large, les investisseurs restant attentifs aux flux des ETF spot.", source: "Demo Crypto Wire", related: ["BTC"] },
  { tag: "crypto", headline: "Ethereum : l'activité on-chain repart à la hausse", summary: "Le nombre de transactions quotidiennes progresse, porté par l'écosystème DeFi et les nouveaux protocoles de staking.", source: "Demo Crypto Wire", related: ["ETH"] },
  { tag: "entreprises", headline: "Une vague de fusions-acquisitions attendue dans le secteur bancaire européen", summary: "Plusieurs établissements étudieraient des rapprochements pour gagner en taille critique face à la concurrence des géants américains.", source: "Demo Business Wire", related: ["BNP.PA", "GLE.PA"] },
  { tag: "entreprises", headline: "Une introduction en bourse très attendue dans la tech pourrait relancer le marché des IPO", summary: "Les investisseurs surveillent de près cette opération qui pourrait rouvrir la fenêtre des introductions en bourse après une année calme.", source: "Demo Business Wire", related: [] },
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
  crypto: sym => [{ headline: `${sym} : la volatilité reste élevée sur les marchés crypto`, summary: "Les analystes rappellent que des variations de plus de 10 % en une semaine restent la norme sur cette classe d'actifs.", source: "Demo Crypto Wire" }],
  bond: sym => [{ headline: `${sym} : les rendements obligataires se stabilisent`, summary: "Le marché des taux intègre les dernières annonces des banques centrales ; les obligations d'État restent l'actif refuge de référence.", source: "Demo Rates Wire" }],
  etf: sym => [{ headline: `${sym} : la collecte reste solide ce trimestre`, summary: "Ce tracker continue d'attirer les investisseurs en quête de diversification à bas coût.", source: "Demo Funds Wire" }],
  default: sym => [
    { headline: `${sym} : résultats trimestriels supérieurs au consensus`, summary: "Le chiffre d'affaires et les marges dépassent légèrement les attentes des analystes ; les prévisions annuelles sont maintenues.", source: "Demo Business Wire" },
    { headline: `${sym} annonce un partenariat stratégique`, summary: "L'entreprise a signé un accord pluriannuel censé ouvrir un nouveau canal de distribution en Europe.", source: "Demo Business Wire" },
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
/* API publique                                                        */
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