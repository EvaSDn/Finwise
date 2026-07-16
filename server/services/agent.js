/**
 * AI agent service.
 *  - analyzePortfolio() : analyse déterministe (source de vérité) — concentration,
 *    répartition par secteur / pays / classe d'actif, risque quantifié en euros.
 *  - agentReply() : Claude via l'API Anthropic si ANTHROPIC_API_KEY est présent ;
 *    sinon un moteur de règles ÉTENDU (gratuit) couvrant : risque, diversification,
 *    volatilité, Markowitz, DCA, intérêts composés, ETF, obligations, crypto,
 *    assurance vie, dividendes, PER, inflation, frais, horizon, liquidité…
 */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// "gemini-flash-latest" est l'alias maintenu par Google vers le modèle flash
// courant éligible au plan gratuit — "gemini-2.0-flash" est resté figé en dur
// dans une version antérieure du projet et son quota gratuit est retombé à 0
// (modèle daté). Vérifié empiriquement le 2026-07-15 avec une clé réelle.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const SECTOR_THRESHOLD = 50;
const CORRECTION_SCENARIO = 0.20;

const KNOWN_SECTORS = ["Technology", "Healthcare", "Finance", "Energy", "Consumer", "Industrials"];
const CLASS_FR = { stock: "Actions", etf: "ETF", crypto: "Crypto", bond: "Obligations" };

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
  if (topSector && topSector.pct > SECTOR_THRESHOLD && topSector.label !== "Obligations") {
    const riskEur = +(topSector.value * CORRECTION_SCENARIO).toFixed(0);
    alerts.push({
      type: "SECTOR_CONCENTRATION", label: topSector.label, pct: topSector.pct, riskEur,
      message: `Le secteur ${topSector.label} représente ${topSector.pct}% de votre portefeuille investi (seuil de prudence : ${SECTOR_THRESHOLD}%). Une correction de -20% de ce secteur vous coûterait environ ${riskEur} €.`,
    });
  }
  const crypto = classBreakdown.find(c => c.label === "crypto");
  if (crypto && crypto.pct > 25) {
    alerts.push({
      type: "CRYPTO_EXPOSURE", label: "Crypto", pct: crypto.pct,
      message: `Les crypto-actifs représentent ${crypto.pct}% de votre portefeuille (${crypto.value.toFixed(0)} €). Leur volatilité est très supérieure aux actions : des variations de ±20% en quelques jours sont courantes.`,
    });
  }
  const topCountry = countryBreakdown[0];
  if (topCountry && topCountry.pct > 80 && positions.length > 1 && topCountry.label !== "—") {
    alerts.push({
      type: "COUNTRY_CONCENTRATION", label: topCountry.label, pct: topCountry.pct,
      message: `${topCountry.pct}% de votre capital investi dépend d'un seul pays (${topCountry.label}).`,
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
/* Chat — moteur Claude (optionnel)                                    */
/* ------------------------------------------------------------------ */
function buildSystemPrompt(a) {
  return `Tu es l'agent Finwise, un coach pédagogique de gestion de portefeuille pour débutants, intégré à un SIMULATEUR (argent virtuel).

RÈGLES STRICTES :
- Tu es un outil PÉDAGOGIQUE. Tu ne donnes JAMAIS de conseil d'investissement réel.
- Tu t'appuies UNIQUEMENT sur les données d'analyse ci-dessous ; tu n'inventes ni chiffres ni actualités.
- Tu traduis les pourcentages en euros pour rendre le risque concret.
- Tu peux expliquer : diversification, volatilité, Markowitz, DCA, intérêts composés, ETF, obligations, crypto-actifs, assurance vie, dividendes, PER, inflation, frais, horizon de placement.
- Réponses courtes (moins de 150 mots), en français, ton bienveillant.

DONNÉES D'ANALYSE (source de vérité) :
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

/* Google Gemini (clé gratuite sur https://aistudio.google.com) */
async function geminiReply(message, analysis, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const contents = [
    ...history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: message }] },
  ];
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt(analysis) }] },
    contents,
    // thinkingBudget: 0 désactive le raisonnement interne des modèles Gemini
    // récents (2.5+) : sans ça, les tokens de "réflexion" invisible peuvent
    // consommer tout maxOutputTokens et couper la réponse visible
    // (observé avec gemini-flash-latest → gemini-3.5-flash, finishReason
    // MAX_TOKENS avant toute réponse utile). Pas besoin de raisonnement
    // long pour des réponses pédagogiques courtes et ancrées sur l'analyse.
    generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  });
  const call = () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  let res = await call();
  if (res.status === 429) {
    // Le plan gratuit a un quota par minute très bas ; une courte pause suivie
    // d'une seule nouvelle tentative absorbe la grande majorité des 429
    // rencontrés en usage normal (pas une boucle de retry — juste un essai de plus).
    await new Promise(r => setTimeout(r, 2500));
    res = await call();
  }
  if (!res.ok) throw new Error(`GEMINI_${res.status}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("\n").trim();
}

/* ------------------------------------------------------------------ */
/* Chat — moteur de règles étendu (gratuit, sans clé)                  */
/* ------------------------------------------------------------------ */
const fmt = n => (+n).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";

/** Chaque règle : mots-clés (regex) + générateur de réponse ancré sur l'analyse. */
const RULES = [
  {
    re: /(risque|perdre|perte|crash|correction|danger)/,
    fn: a => {
      const top = a.sectorBreakdown[0];
      if (!top) return null;
      const risk = (top.value * CORRECTION_SCENARIO).toFixed(0);
      return `Concrètement : votre plus grosse exposition est ${top.label} (${top.pct}% du portefeuille investi, soit ${fmt(top.value)}). Si ce secteur corrige de -20% — un scénario vu plusieurs fois par décennie — vous perdriez environ ${fmt(risk)}. C'est ça, le risque de concentration : un pourcentage abstrait devient une somme réelle. Pour le réduire : diversifier entre secteurs, pays et classes d'actifs (actions, obligations, ETF).`;
    },
  },
  {
    re: /(diversif|équilibr|rééquilibr|répartir|allocation)/,
    fn: a => {
      const top = a.sectorBreakdown[0];
      const under = a.underRepresented.slice(0, 3).join(", ");
      return `Pistes de rééquilibrage (pédagogiques, sur votre portefeuille virtuel) :\n1. ${top ? `Alléger ${top.label}, votre secteur dominant (${top.pct}%)` : "Commencer par 2-3 secteurs différents"}.\n2. Renforcer des secteurs sous-représentés : ${under || "aucun, bravo !"}.\n3. Penser au-delà des actions : un ETF Monde diversifie en un seul achat, une part d'obligations amortit les chocs.\nObjectif simple : qu'aucun secteur ne dépasse ${a.threshold}% — c'est l'esprit de Markowitz.`;
    },
  },
  {
    re: /(intérêt|interet|composé|compose|capitalis)/,
    fn: () => `Les intérêts composés, c'est gagner des intérêts sur les intérêts. Exemple : 100 € par mois à 5%/an → au bout de 20 ans vous avez versé 24 000 € mais le capital atteint environ 41 000 €. Les 17 000 € de différence, c'est l'effet boule de neige du temps. Deux leviers : commencer tôt et rester investi. L'onglet « Risques » contient un projecteur interactif pour tester vos propres chiffres.`,
  },
  {
    re: /(dca|dollar.?cost|versement|mensuel|lisser)/,
    fn: () => `Le DCA (Dollar-Cost Averaging) consiste à investir la même somme à intervalle régulier — par exemple 200 € chaque mois — quel que soit le niveau du marché. Avantages : vous lissez votre prix d'entrée (vous achetez plus de parts quand c'est bas, moins quand c'est haut), vous évitez le piège du « mauvais timing », et vous transformez l'investissement en habitude. C'est le mode par défaut de votre plan dans l'onglet Budget.`,
  },
  {
    re: /(etf|tracker|indice|msci|s&p|sp500|nasdaq)/,
    fn: () => `Un ETF (ou tracker) est un panier d'actions qui réplique un indice : en achetant une seule part d'un ETF MSCI World, vous détenez un morceau de ~1 500 entreprises de 23 pays. C'est l'outil de diversification le plus simple pour un débutant : frais très bas (~0,2%/an), pas de choix de titres à faire. Essayez d'en chercher un dans l'onglet Investir (ex : CW8, SPY, QQQ).`,
  },
  {
    re: /(obligation|bon du trésor|bon du tresor|oat|bund|treasury|coupon|taux)/,
    fn: () => `Une obligation est un prêt que vous faites à un État ou une entreprise : en échange, elle vous verse un intérêt régulier (le coupon) puis vous rembourse à l'échéance. Une OAT 10 ans, c'est prêter à la France sur 10 ans (~3% par an actuellement). Moins de rendement potentiel que les actions, mais beaucoup moins de volatilité : c'est l'amortisseur d'un portefeuille. Vous pouvez en ajouter dans Investir (OAT10, BUND10, UST10 — versions pédagogiques simulées).`,
  },
  {
    re: /(crypto|bitcoin|btc|ethereum|eth|solana|stablecoin|blockchain)/,
    fn: a => {
      const c = a.classBreakdown?.find(x => x.label === "crypto");
      const held = c ? ` Vous en détenez actuellement ${c.pct}% de votre portefeuille (${fmt(c.value)}).` : "";
      return `Les crypto-actifs (Bitcoin, Ethereum…) sont une classe d'actifs à part : très volatils (±20% en quelques jours n'est pas rare), non adossés à des revenus d'entreprise, et au cadre réglementaire encore mouvant.${held} Règle pédagogique courante : ne pas y consacrer plus de 5-10% d'un portefeuille, et uniquement de l'argent dont la perte totale serait supportable. Vous pouvez suivre leurs cours en direct dans Investir (BTC, ETH, SOL…).`;
    },
  },
  {
    re: /(assurance.?vie|livret|épargne|epargne|fonds euro)/,
    fn: () => `L'assurance vie est une enveloppe, pas un placement : à l'intérieur, vous choisissez entre fonds en euros (capital garanti, ~2,5-3%/an) et unités de compte (actions, ETF… non garanties). Son intérêt : fiscalité allégée après 8 ans et versements programmés (ex : 100 €/mois pendant 20 ans). Le Livret A, lui, est l'épargne de précaution : garanti, disponible, mais plafonné et au rendement proche de l'inflation. Utilisez le projecteur de l'onglet Risques pour visualiser 20 ans de versements mensuels avec intérêts composés.`,
  },
  {
    re: /(dividende|rendement du dividende|payout)/,
    fn: () => `Le dividende est la part du bénéfice qu'une entreprise reverse à ses actionnaires, souvent chaque année ou chaque trimestre. Le « rendement du dividende » = dividende annuel ÷ cours de l'action (ex : 3 € de dividende sur une action à 100 € = 3%). Attention au piège du rendement trop beau : un rendement de 10% cache souvent un cours qui s'est effondré. Un dividende régulier et en croissance est un meilleur signal qu'un dividende énorme.`,
  },
  {
    re: /(per\b|price.?earning|bénéfice|benefice|valorisation|cher|surévalué|sous.?évalué)/,
    fn: () => `Le PER (Price/Earnings Ratio) = cours de l'action ÷ bénéfice par action. Il dit combien d'années de bénéfices vous « payez » : un PER de 15 signifie 15 ans de bénéfices actuels. En gros : PER < 10 = potentiellement décoté (ou en difficulté), 15-25 = classique, > 30 = le marché attend une forte croissance. À toujours comparer au secteur : la tech a des PER structurellement plus élevés que la banque.`,
  },
  {
    re: /(inflation|pouvoir d'achat|érosion)/,
    fn: () => `L'inflation est la hausse générale des prix : à 2% par an, 1 000 € d'aujourd'hui ne vaudront plus que ~820 € de pouvoir d'achat dans 10 ans. C'est LA raison d'investir : de l'argent qui dort sur un compte courant perd de la valeur chaque année. Un placement n'est réellement gagnant que si son rendement dépasse l'inflation — on parle alors de rendement « réel ».`,
  },
  {
    re: /(frais|commission|courtage|ter)/,
    fn: () => `Les frais sont l'ennemi silencieux du rendement : 2% de frais annuels sur 20 ans amputent environ un tiers de votre capital final ! À surveiller : frais de courtage (par ordre), frais de gestion des fonds (TER — visez < 0,5% pour un ETF), frais d'entrée/sortie, et frais d'enveloppe (assurance vie). Dans ce simulateur il n'y a pas de frais, mais dans la vraie vie, comparez-les toujours avant le rendement promis.`,
  },
  {
    re: /(volatil)/,
    fn: () => `La volatilité mesure l'amplitude des variations d'un actif. Une action tech peut bouger de ±3% par jour, une obligation d'État de ±0,2%, un crypto-actif de ±10%. Plus la volatilité est élevée, plus les gains ET les pertes à court terme peuvent être brutaux — et plus il faut un horizon long pour absorber les creux. Un portefeuille diversifié a une volatilité inférieure à la moyenne de ses composants : c'est le « free lunch » de Markowitz.`,
  },
  {
    re: /(markowitz|théorie|theorie|frontière|corrélation|correlation)/,
    fn: () => `La théorie moderne du portefeuille (Markowitz, 1952, prix Nobel) démontre qu'en combinant des actifs peu corrélés — qui ne montent et ne baissent pas en même temps — on obtient un meilleur couple rendement/risque que chaque actif pris isolément. Exemple : actions + obligations. C'est le fondement mathématique de la diversification, et de toutes les alertes de concentration que je vous envoie.`,
  },
  {
    re: /(horizon|long terme|court terme|combien de temps|quand vendre)/,
    fn: () => `L'horizon de placement, c'est le temps avant d'avoir besoin de votre argent. Règle pédagogique : argent nécessaire sous 2 ans → épargne sécurisée (livret) ; 2-8 ans → mix prudent (obligations + un peu d'actions) ; 8 ans et plus → les actions ont historiquement toujours été gagnantes sur ces durées, malgré les krachs traversés. Plus l'horizon est court, moins on peut se permettre de volatilité.`,
  },
  {
    re: /(liquidité|liquidite|revendre|vendre vite)/,
    fn: () => `La liquidité, c'est la facilité à vendre un actif rapidement sans perdre de valeur. Une action du CAC 40 se vend en une seconde ; un bien immobilier prend des mois ; certaines petites capitalisations ou cryptos exotiques n'ont presque pas d'acheteurs. Avant d'investir, demandez-vous toujours : « si j'ai besoin de cet argent demain, à quel prix pourrai-je réellement le récupérer ? »`,
  },
  {
    re: /(pea|cto|compte.?titres|fiscalité|fiscalite|impôt|impot)/,
    fn: () => `En France, trois enveloppes principales : le PEA (actions européennes, gains exonérés d'impôt après 5 ans, plafond 150 000 €), le CTO (compte-titres ordinaire : tout est accessible, flat tax de 30% sur les gains) et l'assurance vie (fiscalité allégée après 8 ans). Un débutant commence souvent par un PEA avec un ETF Monde. Rappel : je suis un outil pédagogique, pas un conseiller fiscal !`,
  },
  {
    re: /(bourse|marché|marche|action c'est quoi|comment ça marche|comment ca marche|débuter|debuter|commencer)/,
    fn: () => `Une action est une part de propriété d'une entreprise : vous détenez un morceau de ses bénéfices futurs. Son cours varie en continu selon l'offre et la demande. Pour débuter sereinement : 1) se constituer d'abord une épargne de précaution, 2) investir régulièrement (DCA) plutôt que tout d'un coup, 3) diversifier (un ETF Monde fait l'essentiel du travail), 4) n'investir que ce dont on n'a pas besoin avant 8 ans. Ce simulateur est là pour pratiquer tout ça sans risque.`,
  },
  {
    re: /(action[s]? fran[çc]aise|cac ?40|conseil.*action|quelle action (acheter|choisir)|quelles? actions? (acheter|choisir))/,
    fn: () => `Je suis un outil pédagogique : je ne peux pas vous recommander d'acheter telle ou telle action précise — ce serait du conseil en investissement réel, hors de mon rôle ici. Ce que je peux faire : vous aider à analyser. Le CAC 40 regroupe les plus grandes capitalisations cotées à Paris ; vous en trouverez plusieurs dans l'onglet Investir (LVMH, L'Oréal, TotalEnergies, Sanofi, BNP Paribas, Airbus, Safran, Schneider Electric…). Pour comparer deux actions, regardez leur secteur, leur PER, leur dividende et leur volatilité — je peux vous expliquer chacun de ces critères. Lequel vous intéresse ?`,
  },
];

function ruleBasedReply(message, a) {
  const m = message.toLowerCase();

  if (a.positions.length === 0 && /(portefeuille|position|analyse)/.test(m)) {
    return "Votre portefeuille est vide pour l'instant. Alimentez votre compte dans Budget puis passez un premier ordre dans Investir — je pourrai ensuite analyser votre diversification. En attendant, posez-moi vos questions : DCA, intérêts composés, ETF, obligations, crypto, PER, dividendes… je suis là pour expliquer.";
  }
  for (const rule of RULES) {
    if (rule.re.test(m)) {
      const out = rule.fn(a);
      if (out) return out;
    }
  }
  // Aucune règle ne correspond : on le dit honnêtement plutôt que de renvoyer
  // un texte générique qui donnerait l'impression que la question a été ignorée.
  const alertTxt = a.alerts.length ? a.alerts[0].message
    : "Aucune alerte de concentration en ce moment.";
  const classes = (a.classBreakdown || []).filter(c => c.label !== "Other")
    .map(c => `${CLASS_FR[c.label] || c.label} ${c.pct}%`).join(" · ");
  return `Je n'ai pas de réponse toute prête pour cette question précise (mode "règles" — sans connexion à un moteur IA en ce moment). Voici où en est votre portefeuille en attendant : ${fmt(a.invested)} investis, ${fmt(a.cash)} de liquidités${classes ? ` (${classes})` : ""}. ${alertTxt}\n\nJe peux en revanche vous expliquer en détail : le risque et la diversification, le DCA, les intérêts composés, les ETF, les obligations, les crypto-actifs, l'assurance vie, les dividendes, le PER, l'inflation, les frais, l'horizon de placement, ou les actions françaises/CAC 40. Quel sujet vous intéresse ?`;
}

/* Priorité des moteurs : Anthropic > Gemini > règles.
   Chaque échec retombe proprement sur le moteur suivant. */
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