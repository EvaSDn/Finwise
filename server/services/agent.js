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
    re: /(yield curve|credit rating|credit spread|investment grade|junk bond|high.?yield bond)/i,
    fn: () => `The yield curve plots bond yields against their maturities. Normally it slopes upward (longer maturity = higher yield, more uncertainty to compensate). An inverted curve (short-term yields above long-term) has historically preceded recessions. Credit rating (S&P, Moody's, Fitch) grades an issuer's default risk: "investment grade" (BBB-/Baa3 and above) is considered safer; below that is "junk"/high-yield — riskier, so it must offer a higher yield (the "credit spread" over a comparable Treasury) to attract buyers.`,
  },
  {
    re: /(quantitative easing|\bqe\b|monetary policy|central bank rate|federal reserve|\bfed\b rate|interest rate hike|rate cut)/i,
    fn: () => `Central banks (e.g. the Fed, ECB) steer the economy mainly via interest rates: raising rates cools inflation but slows growth and borrowing; cutting rates stimulates growth but risks inflation. Quantitative Easing (QE) is an extra tool used when rates are already near zero: the central bank buys bonds to inject liquidity directly into the financial system, pushing long-term yields down and asset prices up. It expanded massively after 2008 and 2020. QT (Quantitative Tightening) is the reverse — shrinking that balance sheet, which tends to pressure asset prices down.`,
  },
  {
    re: /(bond|treasury|yield|coupon|rate|oat|bund)/i,
    fn: () => `A bond is a loan you make to a government or company: in return, it pays you a regular interest (the coupon) and repays you at maturity. A 10-year US Treasury means lending to the US for 10 years (~4.3%/year currently). Less potential return than stocks, but much less volatility: it's the shock absorber of a portfolio. You can add bonds in Invest (OAT10, BUND10, UST10 — simulated educational versions).`,
  },
  {
    re: /(proof of work|proof.?of.?stake|\bpow\b|\bpos\b|consensus mechanism|mining vs staking|\bvalidator(s)?\b|nonce|byzantine fault)/i,
    fn: () => `Consensus mechanisms let a decentralized network agree on the state of the ledger without a central authority. Proof of Work (Bitcoin): miners race to solve a computational puzzle; the winner adds the block and earns the reward — secure but energy-intensive. Proof of Stake (Ethereum since "The Merge" in 2022): validators lock up ("stake") capital as collateral and are chosen to propose/attest blocks proportionally to their stake; dishonest behavior gets "slashed" (a portion of the stake destroyed). PoS uses ~99% less energy than PoW but concentrates influence with whoever holds the most capital — a different trade-off, not a free lunch.`,
  },
  {
    re: /(smart contract)/i,
    fn: () => `A smart contract is self-executing code deployed on a blockchain (e.g. Ethereum, Solidity): if condition X is met, action Y happens automatically, with no intermediary. It powers DeFi lending, DEXs, NFTs. Strengths: transparent, tamper-resistant once deployed, no counterparty needed. Risks: code is law — a bug is exploitable and usually irreversible (e.g. The DAO hack, 2016, ~$60M drained). Audits reduce but never eliminate this risk.`,
  },
  {
    re: /(defi\b|decentralized finance|automated market maker|\bamm\b|liquidity pool|impermanent loss|yield farm(ing)?|liquidity mining)/i,
    fn: () => `DeFi (Decentralized Finance) recreates banking services (lending, trading, savings) with smart contracts instead of banks. Key building block: the AMM (Automated Market Maker, e.g. Uniswap) — instead of an order book, liquidity providers deposit a pair of assets into a pool and prices move along a formula (e.g. x·y=k) as trades occur. Providers earn trading fees but face impermanent loss: if the pool's assets move apart in price, withdrawing can be worth less than just holding them. Yield farming means chasing the highest returns across these pools — often layered with extra token incentives and extra risk.`,
  },
  {
    re: /(\bnft\b|non.?fungible)/i,
    fn: () => `An NFT (Non-Fungible Token) is a unique, non-interchangeable token on a blockchain, typically pointing to a digital (or physical) asset — art, collectibles, in-game items, real-estate titles. "Non-fungible" means one NFT ≠ another NFT, unlike Bitcoin where 1 BTC = 1 BTC (fungible). It proves provenance and ownership on-chain, but the underlying file itself is usually stored off-chain (IPFS or a server), which is a common critique. Value is purely driven by scarcity + demand — no cash flow backs it, so it's pure speculation, not an investment in the traditional sense.`,
  },
  {
    re: /(gas fee|gas price|gwei|transaction fee.*(chain|network)|network fee.*(eth|blockchain))/i,
    fn: () => `Gas is the fee paid to compensate the network (miners/validators) for processing a transaction or executing a smart contract, denominated in "gwei" (10⁻⁹ ETH on Ethereum). It scales with computational complexity and network congestion: a simple transfer costs little, a complex DeFi interaction costs more, and fees spike when demand is high (like surge pricing). It's a real cost that erodes returns on small or frequent transactions — one reason Layer-2 networks exist.`,
  },
  {
    re: /(halving|hard fork|soft fork|chain split)/i,
    fn: () => `A fork is a change to a blockchain's protocol rules. A soft fork is backward-compatible (old nodes still validate new blocks). A hard fork is not — it splits the chain in two if not everyone upgrades (e.g. Bitcoin/Bitcoin Cash in 2017, Ethereum/Ethereum Classic in 2016). Halving is specific to Bitcoin: roughly every 4 years, the block reward miners earn is cut in half (currently 3.125 BTC), reducing new supply issuance — a mechanism baked into its fixed 21M supply cap.`,
  },
  {
    re: /(private key|seed phrase|cold wallet|hot wallet|self.?custody|hardware wallet|not your keys)/i,
    fn: () => `A wallet doesn't "store" crypto — it stores the private key that proves you control assets recorded on the blockchain. Hot wallet: connected to the internet (app, exchange) — convenient, more exposed. Cold wallet: offline (hardware device, paper) — safer, less convenient. "Not your keys, not your coins": if you leave assets on an exchange, the exchange controls the keys and can freeze or lose them (e.g. FTX, 2022). Self-custody removes that counterparty risk but shifts full responsibility — and an irreversible loss — onto you if the seed phrase is lost.`,
  },
  {
    re: /(\bdao\b|decentralized autonomous organization)/i,
    fn: () => `A DAO (Decentralized Autonomous Organization) is an organization governed by rules encoded in smart contracts and by token-holder votes, rather than a traditional management hierarchy. Token holders propose and vote on decisions (treasury spending, protocol upgrades); execution is often automatic. Benefits: transparent, permissionless participation. Real-world friction: low voter turnout, whales (large holders) can dominate votes, and legal accountability is still murky in most jurisdictions.`,
  },
  {
    re: /(tokenomics|circulating supply|max supply|token supply|inflationary token|deflationary token|token burn)/i,
    fn: () => `Tokenomics is the economic design of a crypto asset: total/max supply, circulating supply (what's actually tradable now vs. still locked/vesting), issuance schedule, and utility (what the token is actually used for). A fixed-supply asset like Bitcoin (21M cap) is disinflationary by design. Some projects "burn" tokens (permanently remove them from supply) to counter inflation. Red flag to check as an analyst: a small circulating supply relative to a huge max supply often means heavy future dilution as more tokens unlock.`,
  },
  {
    re: /(layer ?2\b|\bl2\b|rollup|sidechain|scaling solution)/i,
    fn: () => `Layer-2 networks (e.g. Arbitrum, Optimism, Polygon) sit on top of a base blockchain ("Layer-1", e.g. Ethereum) to process transactions faster and cheaper, then post a compressed proof or batch back to L1 for final security. Rollups are the main design: they bundle thousands of transactions into one L1 transaction. Trade-off: you inherit most of L1's security while cutting fees dramatically, at the cost of some added complexity and (for some designs) a withdrawal delay back to L1.`,
  },
  {
    re: /(\bdex\b|\bcex\b|decentralized exchange|centralized exchange|order book vs amm)/i,
    fn: () => `A CEX (Centralized Exchange, e.g. Coinbase, Binance) works like a traditional broker: it holds custody of your funds and matches orders on an internal order book — fast, user-friendly, but you trust a company. A DEX (Decentralized Exchange, e.g. Uniswap) lets you trade directly from your own wallet via smart contracts (usually an AMM, not an order book) — you keep custody, but you're exposed to smart-contract risk and, on some chains, higher fees.`,
  },
  {
    re: /(oracle problem|price oracle|chainlink)/i,
    fn: () => `Blockchains can't natively read outside data (e.g. a stock price, a sports score) — that's the "oracle problem." Oracles (e.g. Chainlink) are services that feed real-world data on-chain so smart contracts can act on it. This reintroduces a point of trust/failure into an otherwise trustless system: if the oracle is manipulated or lagged, exploits follow (a common cause of DeFi hacks — feeding a manipulated price to drain a lending protocol).`,
  },
  {
    re: /(51%|double.?spend)/i,
    fn: () => `A 51% attack happens when a single entity controls more than half of a network's mining power (PoW) or staked capital (PoS), letting them rewrite recent transaction history and "double-spend" — spend the same coins twice. It's economically impractical on large networks like Bitcoin (the hardware/energy cost dwarfs the potential gain) but has happened on smaller-cap chains with less distributed hash power (e.g. Ethereum Classic, Bitcoin Gold).`,
  },
  {
    re: /(\bkyc\b|\baml\b|crypto regulation|\bmica\b|travel rule)/i,
    fn: () => `KYC (Know Your Customer) and AML (Anti-Money Laundering) are regulatory requirements forcing exchanges to verify user identity and monitor for illicit flows — this is why centralized exchanges ask for ID. Regulatory frameworks are still maturing: the EU's MiCA (Markets in Crypto-Assets, in force since 2024) is one of the first comprehensive regimes, covering stablecoin issuance and exchange licensing. Regulation is a double-edged sword for crypto: it adds legitimacy and investor protection but reduces the permissionless, pseudonymous nature that drew early adopters.`,
  },
  {
    re: /(\bcbdc\b|central bank digital currency)/i,
    fn: () => `A CBDC (Central Bank Digital Currency) is a digital form of a country's official currency, issued and backed directly by its central bank — unlike crypto, it's centralized and not meant to be scarce or speculative. Examples in development/pilot: the digital euro, China's e-CNY. Goals typically cited: payment efficiency, financial inclusion, monetary policy transmission. Criticism: potential for granular state surveillance of every transaction, unlike cash.`,
  },
  {
    re: /(algorithmic stablecoin|collateralized stablecoin|\busdt\b|\busdc\b|\bdai\b|stablecoin depeg|stablecoin type)/i,
    fn: () => `Not all stablecoins work the same way. Fiat-collateralized (USDT, USDC): backed 1:1 by dollar reserves held off-chain — simple, but relies on trusting the issuer's audits/reserves. Crypto-collateralized (DAI): backed by an over-collateralized basket of crypto locked in smart contracts (e.g. $150 of ETH backing $100 of DAI) — more decentralized, but still exposed to the volatility of the collateral. Algorithmic stablecoins try to hold the peg with code and incentives instead of full collateral — much riskier, as shown by TerraUSD's collapse in 2022, which wiped out ~$40B in days.`,
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
    re: /(sharpe ratio|risk.?adjusted return|sortino ratio)/i,
    fn: () => `The Sharpe ratio measures return earned per unit of risk taken: (Portfolio Return − Risk-Free Rate) ÷ Volatility (standard deviation). A higher Sharpe ratio means better risk-adjusted performance — two portfolios can have the same return, but the one with lower volatility to get there has the better Sharpe ratio. Rule of thumb: > 1 is considered good, > 2 is very good. Limitation: it penalizes upside volatility the same as downside, which is why the Sortino ratio (using only downside deviation) is sometimes preferred.`,
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
  {
    re: /(call option|put option|strike price|option premium|options? contract)/i,
    fn: () => `An option gives the right, but not the obligation, to buy (call) or sell (put) an asset at a fixed "strike" price before/at expiration, in exchange for an upfront premium. Buying a call = betting the price rises (max loss = premium paid, unlimited upside). Buying a put = betting the price falls, or hedging a position you own. Selling (writing) options flips the risk: capped gain (the premium) but potentially large losses. Options are leverage tools — small premium, large notional exposure — which is exactly why they amplify both gains and losses.`,
  },
  {
    re: /(future contract|forward contract|\bfutures\b|\bforwards\b|\bswap\b|derivative)/i,
    fn: () => `A derivative is a contract whose value derives from an underlying asset (a stock, a rate, a commodity) rather than being that asset itself. Forward: a private, customized agreement to trade an asset at a set price on a future date. Future: the same idea, but standardized and traded on an exchange (daily margin, no counterparty risk). Swap: two parties exchange cash flows (e.g. fixed rate for floating rate). Original purpose: hedging (a farmer locks in a wheat price); in practice, most volume today is speculation.`,
  },
  {
    re: /(short sell|shorting|margin call|leverage\b|margin trading|borrow(ed)? stock)/i,
    fn: () => `Short selling means borrowing a stock, selling it immediately, and hoping to buy it back cheaper later to return it — profiting from a price drop. Unlike a normal "long" position, the loss is theoretically unlimited (a stock can rise forever, but can only fall to $0). Leverage/margin means trading with borrowed money to amplify a position: gains are magnified, but so are losses, and a margin call forces you to add cash or get liquidated if the position moves against you past a threshold. This is exactly why this simulator uses virtual, unleveraged money for beginners.`,
  },
  {
    re: /(\bcapm\b|capital asset pricing model|\bbeta\b coefficient|systematic risk|cost of equity)/i,
    fn: () => `CAPM (Capital Asset Pricing Model) estimates the expected return an investor should require for a stock: Expected Return = Risk-Free Rate + Beta × (Market Return − Risk-Free Rate). Beta measures a stock's sensitivity to the overall market: beta = 1 moves with the market, > 1 amplifies market swings (more volatile), < 1 dampens them. It only captures systematic (market-wide) risk — the risk diversification can't remove — not company-specific (unsystematic) risk, which CAPM assumes you've already diversified away.`,
  },
  {
    re: /(\bwacc\b|weighted average cost of capital)/i,
    fn: () => `WACC (Weighted Average Cost of Capital) is the blended rate a company pays to finance itself, weighting the cost of equity and the (after-tax) cost of debt by their share of the capital structure: WACC = (E/V)×Re + (D/V)×Rd×(1−Tax rate). It's the standard discount rate used to value a company's future cash flows (DCF) and to judge whether a project or investment creates value — a project only adds value if its expected return exceeds the WACC.`,
  },
  {
    re: /(\bnpv\b|\birr\b|discounted cash flow|net present value|internal rate of return|\bdcf\b)/i,
    fn: () => `NPV (Net Present Value) discounts a project's future cash flows back to today at a chosen rate (often the WACC) and subtracts the initial investment: NPV > 0 means the project creates value. IRR (Internal Rate of Return) is the discount rate that makes NPV exactly zero — the project's "break-even" return; compare it to your cost of capital to accept/reject. DCF (Discounted Cash Flow) is the broader valuation method underlying both: estimate future free cash flows, discount them to present value, sum them up.`,
  },
  {
    re: /(\bebitda\b|balance sheet|income statement|cash flow statement|financial statement)/i,
    fn: () => `EBITDA (Earnings Before Interest, Taxes, Depreciation & Amortization) approximates a company's operating cash-generating ability, stripping out financing and accounting choices — useful for comparing companies with different debt levels or tax regimes. It appears on the income statement (profit over a period). The balance sheet is a snapshot at one point in time (assets = liabilities + equity). The cash flow statement tracks actual cash moving in/out (operating, investing, financing) — the one statement that can't be "dressed up" with accounting choices the way reported profit sometimes can.`,
  },
  {
    re: /(\barbitrage\b)/i,
    fn: () => `Arbitrage means simultaneously buying and selling the same (or equivalent) asset in different markets to profit from a price discrepancy with virtually no risk — e.g. a stock trading at $100 on one exchange and $100.10 on another. In practice, these gaps are tiny and closed within milliseconds by algorithmic traders, which is also why markets are considered fairly efficient: arbitrageurs' own trading pushes the mismatched prices back together.`,
  },
  {
    re: /(market order|limit order|stop.?loss|stop.?limit|order type)/i,
    fn: () => `Market order: executes immediately at the best available price — guarantees execution, not price. Limit order: executes only at your specified price or better — guarantees price, not execution (it may never fill). Stop-loss order: becomes a market order once a trigger price is hit — used to cap downside automatically. Combining them (stop-limit) trades off certainty of execution against certainty of price; in fast-moving markets a stop-loss can still execute well below your trigger ("slippage").`,
  },
  {
    re: /(efficient market|random walk|market efficiency|emh\b)/i,
    fn: () => `The Efficient Market Hypothesis (EMH) argues that asset prices already reflect all available information, so consistently "beating the market" through stock-picking or timing is largely luck, not skill — prices follow something close to a random walk. It comes in three flavors: weak (past prices don't predict future ones), semi-strong (public information is already priced in), strong (even private/insider information is priced in — the most contested form). It's the theoretical backbone for why low-cost index investing outperforms most active managers over the long run, though behavioral finance points to real anomalies (bubbles, herding) that pure EMH struggles to explain.`,
  },
  {
    re: /(hedge fund|private equity|alternative investment|venture capital)/i,
    fn: () => `Alternative investments sit outside traditional stocks/bonds. Hedge funds pool capital and pursue varied, often leveraged or derivative-heavy strategies (long/short, macro, arbitrage) aiming for returns uncorrelated with the market — high fees ("2 and 20": 2% management + 20% of profits), typically restricted to accredited/institutional investors. Private equity buys entire (often private) companies, restructures them, and exits years later — illiquid, long lock-ups. Venture capital funds early-stage startups for equity, expecting most to fail and a few to return the whole fund. All three trade liquidity and access for the potential of higher, less-correlated returns.`,
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