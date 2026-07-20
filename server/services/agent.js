/**
 * AI agent service.
 *  - analyzePortfolio() : deterministic analysis (source of truth) — concentration,
 *    breakdown by sector / country / asset class, risk quantified in monetary value.
 *  - agentReply() : Claude via Anthropic API if ANTHROPIC_API_KEY is set;
 *    otherwise an EXTENDED rules engine (free, no key) covering: risk, diversification,
 *    volatility, Markowitz, DCA, compound interest, ETF, bonds, crypto,
 *    life insurance, dividends, P/E ratio, inflation, fees, time horizon, liquidity…
 */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// "gemini-flash-latest" is the alias maintained by Google for the current flash model
// eligible for the free plan — "gemini-2.0-flash" was hardcoded in a previous
// version and its free quota dropped to 0 (outdated model).
// Verified empirically on 2026-07-15 with a real key.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const SECTOR_THRESHOLD = 50;
const CORRECTION_SCENARIO = 0.20;

const KNOWN_SECTORS = ["Technology", "Healthcare", "Finance", "Energy", "Consumer", "Industrials"];
const CLASS_EN = { stock: "Stocks", etf: "ETF", crypto: "Crypto", bond: "Bonds" };

export function analyzePortfolio(holdings, quotes, cash) {
  const positions = holdings.map(h => {
    const price = quotes[h.symbol]?.price ?? h.avg_cost;
    return { ...h, price, value: +(price * h.shares).toFixed(2) };
  });
  const invested = +positions.reduce((s, p) => s + p.value, 0).toFixed(2);

  const groupPct = key => {
    const acc = {};
    for (const p of positions) {
      const k = p[key] || "Other";
      acc[k] = (acc[k] || 0) + p.value;
    }
    return Object.entries(acc)
      .map(([label, value]) => ({
        label, value: +value.toFixed(2),
        pct: invested > 0 ? +((value / invested) * 100).toFixed(1) : 0,
        symbols: positions.filter(p => (p[key] || "Other") === label).map(p => p.symbol),
      }))
      .sort((a, b) => b.pct - a.pct);
  };

  const sectorBreakdown = groupPct("sector");
  const countryBreakdown = groupPct("country");
  const classBreakdown = groupPct("asset_class");

  const alerts = [];
  const topSector = sectorBreakdown[0];
  if (topSector && topSector.pct > SECTOR_THRESHOLD && topSector.label !== "Bonds") {
    const riskEur = +(topSector.value * CORRECTION_SCENARIO).toFixed(0);
    alerts.push({
      type: "SECTOR_CONCENTRATION", label: topSector.label, pct: topSector.pct, riskEur,
      message: `The ${topSector.label} sector represents ${topSector.pct}% of your invested portfolio (caution threshold: ${SECTOR_THRESHOLD}%). A -20% correction in this sector would cost you approximately $${riskEur}.`,
    });
  }
  const crypto = classBreakdown.find(c => c.label === "crypto");
  if (crypto && crypto.pct > 25) {
    alerts.push({
      type: "CRYPTO_EXPOSURE", label: "Crypto", pct: crypto.pct,
      message: `Crypto assets represent ${crypto.pct}% of your portfolio ($${crypto.value.toFixed(0)}). Their volatility is much higher than stocks: swings of ±20% in a few days are common.`,
    });
  }
  const topCountry = countryBreakdown[0];
  if (topCountry && topCountry.pct > 80 && positions.length > 1 && topCountry.label !== "—") {
    alerts.push({
      type: "COUNTRY_CONCENTRATION", label: topCountry.label, pct: topCountry.pct,
      message: `${topCountry.pct}% of your invested capital depends on a single country (${topCountry.label}).`,
    });
  }

  const held = new Set(sectorBreakdown.map(s => s.label));
  const underRepresented = KNOWN_SECTORS.filter(s => !held.has(s) ||
    (sectorBreakdown.find(x => x.label === s)?.pct ?? 0) < 10);

  return {
    positions, invested, cash: +(+cash).toFixed(2),
    sectorBreakdown, countryBreakdown, classBreakdown,
    alerts, underRepresented, threshold: SECTOR_THRESHOLD,
  };
}

/* ------------------------------------------------------------------ */
/* Chat — Claude engine (optional)                                     */
/* ------------------------------------------------------------------ */
function buildSystemPrompt(a) {
  return `You are the Finwise agent, a pedagogical portfolio management coach for beginners, integrated into a SIMULATOR (virtual money).

STRICT RULES:
- You are an EDUCATIONAL tool. You NEVER give real investment advice.
- You rely ONLY on the analysis data below; you never invent numbers or news.
- You translate percentages into dollar amounts to make risk concrete.
- You can explain: diversification, volatility, Markowitz, DCA, compound interest, ETF, bonds, crypto assets, life insurance, dividends, P/E ratio, inflation, fees, time horizon.
- Short responses (under 150 words), in English, friendly tone.

ANALYSIS DATA (source of truth):
${JSON.stringify({
    invested: a.invested, cash: a.cash,
    sectorBreakdown: a.sectorBreakdown, countryBreakdown: a.countryBreakdown,
    classBreakdown: a.classBreakdown, alerts: a.alerts,
    underRepresented: a.underRepresented, thresholdPct: a.threshold,
  }, null, 2)}`;
}

async function claudeReply(message, analysis, history) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 600,
      system: buildSystemPrompt(analysis),
      messages: [...history, { role: "user", content: message }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ANTHROPIC_${res.status}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

/* Google Gemini (free key at https://aistudio.google.com) */
async function geminiReply(message, analysis, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const contents = [
    ...history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: message }] },
  ];
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt(analysis) }] },
    contents,
    // thinkingBudget: 0 disables internal reasoning on recent Gemini models (2.5+):
    // without this, "thinking" tokens can consume all maxOutputTokens and cut off
    // the visible response (observed with gemini-flash-latest, finishReason MAX_TOKENS
    // before any useful response). No long reasoning needed for short educational answers.
    generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  });
  const call = () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  // The free plan has a low per-minute quota and may return a 429/503
  // (momentary overload); two extra attempts with increasing delay absorb
  // the vast majority of real cases without turning into an infinite loop
  // (the 30s timeout per call bounds the worst case).
  let res = await call();
  for (const delayMs of [2000, 4000]) {
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise(r => setTimeout(r, delayMs));
    res = await call();
  }
  if (!res.ok) throw new Error(`GEMINI_${res.status}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("\n").trim();
}

/* ------------------------------------------------------------------ */
/* Chat — extended rules engine (free, no key required)               */
/* ------------------------------------------------------------------ */
const fmt = n => "$" + (+n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Each rule: keywords (regex) + response generator anchored to the analysis. */
const RULES = [
  {
    re: /(risk|loss|crash|correction|danger|losing|lose)/i,
    fn: a => {
      const top = a.sectorBreakdown[0];
      if (!top) return null;
      const risk = (top.value * CORRECTION_SCENARIO).toFixed(0);
      return `Concretely: your biggest exposure is ${top.label} (${top.pct}% of invested portfolio, i.e. ${fmt(top.value)}). If this sector corrects by -20% — a scenario seen several times per decade — you would lose approximately ${fmt(risk)}. That's concentration risk: an abstract percentage becomes a real dollar amount. To reduce it: diversify across sectors, countries, and asset classes (stocks, bonds, ETFs).`;
    },
  },
  {
    re: /(diversif|rebalance|rebalancing|allocation|spread)/i,
    fn: a => {
      const top = a.sectorBreakdown[0];
      const under = a.underRepresented.slice(0, 3).join(", ");
      return `Rebalancing suggestions (educational, on your virtual portfolio):\n1. ${top ? `Reduce ${top.label}, your dominant sector (${top.pct}%)` : "Start with 2-3 different sectors"}.\n2. Reinforce under-represented sectors: ${under || "none — great job!"}.\n3. Think beyond stocks: a World ETF diversifies in a single purchase, a bond allocation cushions shocks.\nSimple goal: no sector above ${a.threshold}% — that's the spirit of Markowitz.`;
    },
  },
  {
    re: /(compound|interest|compounding|capitaliz)/i,
    fn: () => `Compound interest means earning interest on your interest. Example: $100/month at 5%/year → after 20 years you've invested $24,000 but your capital reaches ~$41,000. The $17,000 difference is the snowball effect of time. Two levers: start early and stay invested. The "Risk" tab has an interactive projector to test your own numbers.`,
  },
  {
    re: /(dca|dollar.?cost|monthly|recurring|average|automat)/i,
    fn: () => `DCA (Dollar-Cost Averaging) means investing the same amount at regular intervals — e.g. $200 every month — regardless of market conditions. Benefits: you smooth your entry price (you buy more shares when it's low, fewer when it's high), you avoid the "bad timing" trap, and you turn investing into a habit. It's the default mode of your plan in the Budget tab.`,
  },
  {
    re: /(etf|tracker|index|msci|s&p|sp500|nasdaq)/i,
    fn: () => `An ETF (or tracker) is a basket of stocks that replicates an index: buying a single share of an MSCI World ETF gives you exposure to ~1,500 companies in 23 countries. It's the simplest diversification tool for a beginner: very low fees (~0.2%/year), no stock-picking required. Try searching for one in the Invest tab (e.g. CW8, SPY, QQQ).`,
  },
  {
    re: /(bond|treasury|yield|coupon|rate|oat|bund)/i,
    fn: () => `A bond is a loan you make to a government or company: in return, it pays you a regular interest (the coupon) and repays you at maturity. A 10-year US Treasury means lending to the US for 10 years (~4.3%/year currently). Less potential return than stocks, but much less volatility: it's the shock absorber of a portfolio. You can add bonds in Invest (OAT10, BUND10, UST10 — simulated educational versions).`,
  },
  {
    re: /(crypto|bitcoin|btc|ethereum|eth|solana|stablecoin|blockchain)/i,
    fn: a => {
      const c = a.classBreakdown?.find(x => x.label === "crypto");
      const held = c ? ` You currently hold ${c.pct}% of your portfolio in crypto (${fmt(c.value)}).` : "";
      return `Crypto assets (Bitcoin, Ethereum…) are a separate asset class: highly volatile (±20% in a few days is not uncommon), not backed by company earnings, and in an evolving regulatory landscape.${held} Common rule of thumb: no more than 5-10% of a portfolio, and only money you could afford to lose entirely. You can track live prices in Invest (BTC, ETH, SOL…).`;
    },
  },
  {
    re: /(life insurance|annuity|savings|emergency fund|money market)/i,
    fn: () => `A life insurance policy is a wrapper, not an investment: inside, you choose between guaranteed funds (~2.5-3%/year) and unit-linked funds (stocks, ETFs… not guaranteed). Its advantage: tax benefits after 8 years and scheduled contributions (e.g. $100/month for 20 years). An emergency fund, meanwhile, is your safety cushion: guaranteed, available, but low-yielding. Use the projector in the Risk tab to visualize 20 years of monthly contributions with compound interest.`,
  },
  {
    re: /(dividend|yield|payout)/i,
    fn: () => `A dividend is the share of profit a company returns to shareholders, often annually or quarterly. "Dividend yield" = annual dividend ÷ stock price (e.g. $3 dividend on a $100 stock = 3%). Beware of the high-yield trap: a 10% yield often hides a collapsed stock price. A regular and growing dividend is a better signal than a huge one.`,
  },
  {
    re: /(p\/e|pe ratio|price.?earning|valuation|overvalued|undervalued|earnings)/i,
    fn: () => `The P/E ratio (Price/Earnings) = stock price ÷ earnings per share. It tells you how many years of earnings you're "paying for": a P/E of 15 means 15 years of current earnings. Roughly: P/E < 10 = potentially undervalued (or in trouble), 15-25 = typical, > 30 = the market expects strong growth. Always compare to the sector: tech has structurally higher P/Es than banking.`,
  },
  {
    re: /(inflation|purchasing power|erosion)/i,
    fn: () => `Inflation is the general rise in prices: at 2%/year, $1,000 today will only have ~$820 of purchasing power in 10 years. That's THE reason to invest: money sitting in a checking account loses value every year. An investment is only truly profitable if its return exceeds inflation — this is called "real return".`,
  },
  {
    re: /(fee|commission|expense|ter|cost)/i,
    fn: () => `Fees are the silent enemy of returns: 2% annual fees over 20 years wipe out about a third of your final capital! Watch out for: brokerage commissions (per trade), fund management fees (TER — aim for < 0.5% for an ETF), entry/exit fees, and account fees. This simulator has no fees, but in real life, always compare them before looking at advertised returns.`,
  },
  {
    re: /(volatil)/i,
    fn: () => `Volatility measures the magnitude of an asset's price swings. A tech stock might move ±3% per day, a government bond ±0.2%, a crypto ±10%. The higher the volatility, the more severe the short-term gains AND losses — and the longer the time horizon needed to absorb downturns. A diversified portfolio has lower volatility than the average of its components: that's Markowitz's "free lunch".`,
  },
  {
    re: /(markowitz|modern portfolio|correlation|efficient frontier)/i,
    fn: () => `Modern Portfolio Theory (Markowitz, 1952, Nobel Prize) proves that by combining assets with low correlation — that don't rise and fall together — you get a better risk/return trade-off than any single asset. Example: stocks + bonds. This is the mathematical foundation of diversification and all the concentration alerts I send you.`,
  },
  {
    re: /(horizon|long.?term|short.?term|when to sell|how long)/i,
    fn: () => `Your investment horizon is how long before you need your money. Educational rule: money needed in under 2 years → secure savings (money market); 2-8 years → cautious mix (bonds + some stocks); 8 years and more → stocks have historically always been profitable over these periods, despite crashes along the way. The shorter the horizon, the less volatility you can afford.`,
  },
  {
    re: /(liquid|sell quickly|cash out)/i,
    fn: () => `Liquidity is how easily you can sell an asset quickly without losing value. A blue-chip stock sells in a second; real estate takes months; some small-caps or exotic cryptos have almost no buyers. Before investing, always ask: "If I need this money tomorrow, at what price can I realistically get it back?"`,
  },
  {
    re: /(isa|401k|roth|ira|brokerage|tax|account type)/i,
    fn: () => `Common investment accounts: a Brokerage Account (everything accessible, standard capital gains tax), a Roth IRA (tax-free growth, after-tax contributions, great for long-term), a Traditional IRA (tax-deductible contributions, taxed at withdrawal), and 401(k) (employer-sponsored, pre-tax). Choosing the right account wrapper is as important as choosing the right assets. Note: I'm an educational tool, not a tax advisor!`,
  },
  {
    re: /(stock market|what is a stock|how does it work|beginner|getting started|start investing)/i,
    fn: () => `A stock is a share of ownership in a company: you hold a piece of its future profits. Its price fluctuates continuously based on supply and demand. To start well: 1) first build an emergency fund (3-6 months of expenses), 2) invest regularly (DCA) rather than all at once, 3) diversify (a World ETF does most of the work), 4) only invest money you won't need for 8+ years. This simulator is here to practice all of this risk-free.`,
  },
];

function ruleBasedReply(message, a) {
  const m = message.toLowerCase();

  if (a.positions.length === 0 && /(portfolio|position|analy)/.test(m)) {
    return "Your portfolio is empty for now. Fund your account in Budget then place your first order in Invest — I'll then be able to analyze your diversification. In the meantime, ask me anything: DCA, compound interest, ETFs, bonds, crypto, P/E ratio, dividends… I'm here to explain.";
  }
  for (const rule of RULES) {
    if (rule.re.test(m)) {
      const out = rule.fn(a);
      if (out) return out;
    }
  }
  // No rule matched: say so honestly rather than returning a generic response
  // that would give the impression the question was ignored.
  const alertTxt = a.alerts.length ? a.alerts[0].message
    : "No concentration alerts at the moment.";
  const classes = (a.classBreakdown || []).filter(c => c.label !== "Other")
    .map(c => `${CLASS_EN[c.label] || c.label} ${c.pct}%`).join(" · ");
  return `I don't have a ready-made answer for that specific question (running in "rules" mode — no AI engine connected right now). Here's where your portfolio stands: ${fmt(a.invested)} invested, ${fmt(a.cash)} in cash${classes ? ` (${classes})` : ""}. ${alertTxt}\n\nI can explain in detail: risk and diversification, DCA, compound interest, ETFs, bonds, crypto, life insurance, dividends, P/E ratio, inflation, fees, investment horizon, or stocks. Which topic interests you?`;
}

/* Engine priority: Anthropic > Gemini > rules.
   Each failure falls cleanly to the next engine. */
export async function agentReply(message, analysis, history) {
  if (ANTHROPIC_KEY) {
    try {
      const reply = await claudeReply(message, analysis, history);
      if (reply) return { reply, engine: "claude" };
    } catch (e) {
      console.error("Anthropic API error, fallback:", e.message);
    }
  }
  if (GEMINI_KEY) {
    try {
      const reply = await geminiReply(message, analysis, history);
      if (reply) return { reply, engine: "gemini" };
    } catch (e) {
      console.error("Gemini API error, fallback:", e.message);
    }
  }
  return { reply: ruleBasedReply(message, analysis), engine: "rules" };
}