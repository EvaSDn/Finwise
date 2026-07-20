/* ============================================================================
   FINWISE — frontend SPA (vanilla JS, CSP-safe: no inline handlers)
   - Budget updates IN PLACE (no more page "jumps" on click/slider)
   - Stock search connected to /api/market/search (debounce)
   - Prices polled every 15s and patched into the DOM (tick-flash)
============================================================================ */
"use strict";

/* ---------------------------------------------------------------- state -- */
const State = {
  user: null,
  budget: null,
  plan: null,
  deposits: [],
  thresholdPct: 10,
  portfolio: null,          // { positions, cash, invested, total, transactions }
  demoMode: false,
  view: "dashboard",
  breakdownView: "sector",  // 'sector' | 'country'
  trade: { symbol: null, side: "buy", qty: 1, amount: 100, inputMode: "qty", detail: null },
  newsCategory: "all",
  newsSymbolFilter: "all",
  newsSearchQuery: "",
  newsCache: {},             // category -> { at, items }
  newsAutoTimer: null,
  chat: [],                 // { role:'user'|'assistant', content }
  insights: null,
  pollTimer: null,
};

const SECTOR_COLORS = {
  Technology: "#e3b567", Healthcare: "#6fb8b0", Finance: "#8f8fd9",
  Energy: "#7fb88f", Consumer: "#d98fb8", Industrials: "#c9a06a", Other: "#6b6d80",
};
const SECTOR_EN = {
  Technology: "Technology", Healthcare: "Healthcare", Finance: "Finance",
  Energy: "Energy", Consumer: "Consumer", Industrials: "Industrials",
  Bonds: "Bonds", Crypto: "Crypto", "Diversified": "Diversified", Other: "Other",
};
const CLASS_EN = { stock: "Stock", etf: "ETF", crypto: "Crypto", bond: "Bond" };
const CLASS_COLORS = { stock: "#e3b567", etf: "#6fb8b0", crypto: "#8f8fd9", bond: "#7fb88f" };
const classTag = cls => cls ? `<span class="tag" style="background:${(CLASS_COLORS[cls] || "#6b6d80")}22;color:${CLASS_COLORS[cls] || "#6b6d80"};">${CLASS_EN[cls] || cls}</span>` : "";

/* -------------------------------------------------------------- helpers -- */
const $ = sel => document.querySelector(sel);
const root = () => $("#root");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmtEur = (n, d = 0) =>
  "€" + (n ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = n => (n >= 0 ? "+" : "") + (n ?? 0).toFixed(1) + " %";
/* fractional quantities: up to 6 decimal places, trailing zeros removed */
const fmtQty = n => (+n).toLocaleString("en-US", { maximumFractionDigits: 6 });
function timeAgo(ts) {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

let toastTimer = null;
function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

/* Confirmation modal — returns a Promise<boolean>. With checkLabel,
   the Confirm button remains disabled until the checkbox is checked. */
function confirmModal({ title, body, warning = "", checkLabel = "", confirmText = "Confirm" }) {
  return new Promise(resolve => {
    const bd = $("#modal-backdrop");
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = body;
    const warnEl = $("#modal-warning");
    warnEl.style.display = warning ? "block" : "none";
    warnEl.innerHTML = warning;
    const wrap = $("#modal-check-wrap");
    const check = $("#modal-check");
    const confirmBtn = $("#modal-confirm");
    const cancelBtn = $("#modal-cancel");
    check.checked = false;
    if (checkLabel) {
      wrap.style.display = "flex";
      $("#modal-check-label").textContent = checkLabel;
      confirmBtn.disabled = true;
    } else {
      wrap.style.display = "none";
      confirmBtn.disabled = false;
    }
    confirmBtn.textContent = confirmText;
    bd.classList.add("open");

    const done = ok => {
      bd.classList.remove("open");
      check.onchange = confirmBtn.onclick = cancelBtn.onclick = null;
      resolve(ok);
    };
    check.onchange = () => { confirmBtn.disabled = checkLabel ? !check.checked : false; };
    confirmBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
  });
}

/* ------------------------------------------------------------ mini charts */
function sparklineSvg(values, { w = 100, h = 32, stroke = "#e3b567", fill = false, cls = "" } = {}) {
  if (!values || values.length < 2) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="#2c2f40" stroke-width="1.5" stroke-dasharray="3 4"/></svg>`;
  }
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 3 - ((v - min) / range) * (h - 6)]);
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = fill ? `${path} L${w},${h} L0,${h} Z` : "";
  return `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${fill ? `<path d="${area}" fill="${stroke}" opacity="0.12"/>` : ""}
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function riskGaugeSvg(pct) {
  const cx = 110, cy = 110, r = 86;
  const angleFor = p => -90 + (p / 100) * 180;
  const toXY = deg => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (f, t, color) => {
    const [x1, y1] = toXY(angleFor(f)), [x2, y2] = toXY(angleFor(t));
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${(t - f) > 50 ? 1 : 0} 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>`;
  };
  const p = Math.min(pct, 100);
  const [nx, ny] = toXY(angleFor(p));
  return `<svg viewBox="0 0 220 130" preserveAspectRatio="xMidYMid meet">
    ${arc(0, 50, "#2c2f40")}${arc(50, 75, "#3a3320")}${arc(75, 100, "#3a2422")}
    ${arc(0, Math.min(p, 50), "#7fb88f")}
    ${p > 50 ? arc(50, Math.min(p, 75), "#e8a33d") : ""}
    ${p > 75 ? arc(75, Math.min(p, 100), "#e0645a") : ""}
    <circle cx="${cx}" cy="${cy}" r="4.5" fill="#f1efe9"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#f1efe9" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

/* "Finary-style" Sankey: Salary → Budget → Categories. */
function sankeySvg(income, cats) {
  const W = 920, H = 340, NODE_W = 12, PAD = 8, GAP = 10;
  const cols = [70, 430, 820];
  const usable = H - PAD * 2;
  const total = Math.max(income, 1);
  const list = cats.filter(c => c.value > 0.5);
  const sumGaps = GAP * Math.max(0, list.length - 1);

  const catH = c => Math.max(6, (c.value / total) * (usable - sumGaps));
  let y = PAD + (usable - (list.reduce((s, c) => s + catH(c), 0) + sumGaps)) / 2;
  const rights = list.map(c => {
    const h = catH(c);
    const node = { ...c, x: cols[2], y, h };
    y += h + GAP;
    return node;
  });
  const left = { x: cols[0], y: PAD, h: usable, color: "#8f8fd9", label: "Salary", value: income };
  const mid = { x: cols[1], y: PAD, h: usable, color: "#e3b567", label: "Budget", value: income };

  const ribbon = (x1, y1, h1, x2, y2, h2, color) => {
    const cxm = (x1 + x2) / 2;
    return `<path d="M ${x1} ${y1} C ${cxm} ${y1}, ${cxm} ${y2}, ${x2} ${y2}
                     L ${x2} ${y2 + h2} C ${cxm} ${y2 + h2}, ${cxm} ${y1 + h1}, ${x1} ${y1 + h1} Z"
             fill="${color}" opacity="0.28"/>`;
  };
  const nodeRect = n => `<rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="4" fill="${n.color}"/>`;
  const label = (n, anchor, x) =>
    `<text x="${x}" y="${n.y + n.h / 2}" dominant-baseline="middle" text-anchor="${anchor}"
       class="sankey-node-label">${esc(n.label)}</text>
     <text x="${x}" y="${n.y + n.h / 2 + 15}" dominant-baseline="middle" text-anchor="${anchor}"
       class="sankey-node-value">${fmtEur(n.value)}</text>`;

  let midCursor = mid.y;
  const flows = rights.map(rn => {
    const h1 = (rn.value / total) * usable;
    const p = ribbon(mid.x + NODE_W, midCursor, h1, rn.x, rn.y, rn.h, rn.color);
    midCursor += h1;
    return p;
  }).join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${ribbon(left.x + NODE_W, left.y, left.h, mid.x, mid.y, mid.h, "#8f8fd9")}
    ${flows}
    ${nodeRect(left)}${nodeRect(mid)}
    ${rights.map(nodeRect).join("")}
    ${label(left, "start", left.x + NODE_W + 10)}
    ${label(mid, "end", mid.x - 10)}
    ${rights.map(n => label(n, "end", n.x - 10)).join("")}
  </svg>`;
}

/* --------------------------------------------------------------- icons -- */
const icon = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
  budget: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18v12H3z"/><path d="M3 10h18M7 15h4"/></svg>`,
  trade: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/></svg>`,
  news: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h4"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.2"/><path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/><path d="M9.5 12l1.8 1.8L15 10"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L15.5 10"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.5-3.5 4.2-5 7-5s5.5 1.5 7 5"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 12.5h8M8 16h4"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>`,
};

/* --------------------------------------------------------- news config -- */
const NEWS_CATS = [
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
const NEWS_CAT_LABEL = Object.fromEntries(NEWS_CATS.map(c => [c.id, c.label]));
const NEWS_AUTOREFRESH_MS = 120_000; // near real-time, respects free API quota

/* ============================================================ LANDING === */
const LANDING_FEATURES = [
  { icon: icon.budget, title: "Smart Budget", body: "Split your income into a clear plan and track every category in real time, visualized as a flowing Sankey diagram." },
  { icon: icon.trade, title: "Virtual Trading", body: "Buy and sell stocks, ETFs, bonds and crypto with live market data — zero real money, zero real risk." },
  { icon: icon.agent, title: "AI Advisor", body: "Chat with an AI agent that reviews your portfolio, explains market moves, and answers your investing questions." },
  { icon: icon.shield, title: "Risk Profile", body: "Understand your risk exposure with a live gauge and personalized insights as your portfolio evolves." },
];

const LANDING_PRICING_ITEMS = [
  "Full portfolio simulator, unlimited trades",
  "Live market data & real-time news feed",
  "AI-powered portfolio agent",
  "Budget planner & risk analytics",
  "No real money, no real risk — ever",
];

const LANDING_PRICING_PLANS = {
  monthly: { price: "9.99", suffix: "/month", note: "" },
  yearly: { price: "99.99", suffix: "/year", note: "Save 2 months vs. paying monthly" },
};

function renderLanding(pricingPeriod = "yearly") {
  root().innerHTML = `
  <div class="landing-page">
    <header class="landing-header">
      <div class="auth-brand" style="cursor:pointer;margin-bottom:0;" id="land-brand-btn">
        <div class="brand-mark">F</div>
        <div>
          <div class="auth-brand-name">Finwise</div>
          <div class="auth-brand-tag">Educational Simulator</div>
        </div>
      </div>
      <nav class="landing-nav">
        <a href="#land-features">Features</a>
        <a href="#land-pricing">Pricing</a>
      </nav>
      <div class="landing-cta-group">
        <button class="landing-btn-login" id="land-login-btn">Sign In</button>
        <button class="landing-btn-signup" id="land-signup-btn">Get Started</button>
      </div>
    </header>

    <section class="landing-hero">
      <div class="landing-hero-badge">100% virtual · zero risk</div>
      <h1>Learn to invest, <span>without risking a cent.</span></h1>
      <p>Finwise is a full portfolio simulator with live market data, a budget planner and an AI advisor —
        so you can build real investing skills before you put real money on the line.</p>
      <div class="landing-hero-ctas">
        <button class="btn-primary" id="land-hero-signup">Get Started — €99.99/year</button>
        <button class="btn-ghost" id="land-hero-login">I already have an account</button>
      </div>
    </section>

    <div class="landing-stats-bar">
      <div class="landing-stats-container">
        <div class="landing-stat-item"><h3>0 €</h3><p>Real money at risk</p></div>
        <div class="landing-stat-item"><h3>Live</h3><p>Market data & news</p></div>
        <div class="landing-stat-item"><h3>24/7</h3><p>AI portfolio agent</p></div>
        <div class="landing-stat-item"><h3>15s</h3><p>Price refresh rate</p></div>
      </div>
    </div>

    <section class="landing-features" id="land-features">
      <h2 class="landing-section-title">Everything you need to learn</h2>
      <p class="landing-section-sub">One platform to plan your budget, trade with confidence, and understand
        the "why" behind every market move.</p>
      <div class="landing-features-grid">
        ${LANDING_FEATURES.map(f => `
          <div class="landing-feature-card">
            <div class="landing-feature-icon">${f.icon}</div>
            <h3>${f.title}</h3>
            <p>${f.body}</p>
          </div>`).join("")}
      </div>
    </section>

    <section class="landing-pricing" id="land-pricing">
      <div class="landing-pricing-card">
        <div class="landing-pricing-badge">Simple</div>
        <h3>Premium Access</h3>
        <div class="landing-pricing-toggle" id="land-pricing-toggle">
          <button type="button" data-period="monthly" class="${pricingPeriod === "monthly" ? "active" : ""}">Monthly</button>
          <button type="button" data-period="yearly" class="${pricingPeriod === "yearly" ? "active" : ""}">Yearly</button>
        </div>
        <div class="landing-price">€${LANDING_PRICING_PLANS[pricingPeriod].price}<span> ${LANDING_PRICING_PLANS[pricingPeriod].suffix}</span></div>
        ${LANDING_PRICING_PLANS[pricingPeriod].note ? `<div class="landing-price-note">${esc(LANDING_PRICING_PLANS[pricingPeriod].note)}</div>` : `<div class="landing-price-note" style="visibility:hidden;">placeholder</div>`}
        <div class="landing-pricing-benefit">🧠 Boost your financial IQ — deeper, personalized educational insights to help you become smarter with money.</div>
        <div class="landing-pricing-list">
          ${LANDING_PRICING_ITEMS.map(t => `<div class="landing-pricing-item">${icon.check}${esc(t)}</div>`).join("")}
        </div>
        <button class="btn-primary" id="land-pricing-signup">Get Started</button>
      </div>
    </section>

    <footer class="landing-footer">
      <div class="landing-footer-disclaimer">Finwise is an educational simulator. Portfolios, trades and
        balances are entirely virtual — nothing here constitutes financial advice or a real brokerage account.</div>
      <div>© ${new Date().getFullYear()} Finwise</div>
    </footer>
  </div>`;

  const toRegister = () => renderAuth("register");
  const toLogin = () => renderAuth("login");
  $("#land-brand-btn").addEventListener("click", () => root().scrollTo?.(0, 0));
  $("#land-login-btn").addEventListener("click", toLogin);
  $("#land-signup-btn").addEventListener("click", toRegister);
  $("#land-hero-signup").addEventListener("click", toRegister);
  $("#land-hero-login").addEventListener("click", toLogin);
  $("#land-pricing-signup").addEventListener("click", toRegister);
  $("#land-pricing-toggle").querySelectorAll("[data-period]").forEach(b =>
    b.addEventListener("click", () => {
      const scrollY = window.scrollY;
      renderLanding(b.dataset.period);
      window.scrollTo(0, scrollY);
    }));
}

/* ============================================================== AUTH ==== */
function renderAuth(mode = "login") {
  root().innerHTML = `
  <div class="auth-screen">
    <div class="auth-card">
      <div class="auth-brand" style="cursor:pointer;" id="auth-brand-btn">
        <div class="brand-mark">F</div>
        <div>
          <div class="auth-brand-name">Finwise</div>
          <div class="auth-brand-tag">Educational Simulator</div>
        </div>
      </div>
      <div class="auth-title">${mode === "login" ? "Sign In" : "Create an Account"}</div>
      <div class="auth-sub">100% virtual portfolio: learn to invest without risking a single penny.</div>
      <div class="form-error" id="auth-error"></div>
      ${mode === "register" ? `
      <div class="field"><label>First Name</label><input id="f-name" type="text" autocomplete="name" placeholder="Sarah"></div>` : ""}
      <div class="field"><label>Email</label><input id="f-email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label>Password</label><input id="f-pass" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}">
        ${mode === "register" ? `<div class="hint">8 characters minimum.</div>` : ""}</div>
      <button class="btn-primary" id="auth-submit">${mode === "login" ? "Sign In" : "Create Account"}</button>
      <div class="auth-switch">
        ${mode === "login" ? "Don't have an account?" : "Already registered?"}
        <button id="auth-switch-btn">${mode === "login" ? "Sign Up" : "Sign In"}</button>
      </div>
    </div>
  </div>`;

  $("#auth-brand-btn").addEventListener("click", () => renderLanding());
  $("#auth-switch-btn").addEventListener("click", () => renderAuth(mode === "login" ? "register" : "login"));
  const submit = async () => {
    const errEl = $("#auth-error");
    errEl.classList.remove("visible");
    const email = $("#f-email").value.trim();
    const password = $("#f-pass").value;
    const btn = $("#auth-submit");
    btn.disabled = true;
    try {
      let data;
      if (mode === "login") {
        data = await API.post("/api/auth/login", { email, password });
      } else {
        data = await API.post("/api/auth/register", { email, password, name: $("#f-name").value.trim() });
      }
      State.user = data.user;
      if (!State.user.onboarded) renderOnboarding();
      else await enterApp();
    } catch (e) {
      const map = {
        INVALID_CREDENTIALS: "Incorrect email or password.",
        EMAIL_TAKEN: "This email is already in use.",
        PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
        INVALID_EMAIL: "Invalid email address.",
        INVALID_NAME: "Invalid first name.",
      };
      errEl.textContent = map[e.code] || "An error occurred. Please try again.";
      errEl.classList.add("visible");
    } finally { btn.disabled = false; }
  };
  $("#auth-submit").addEventListener("click", submit);
  root().querySelectorAll("input").forEach(i =>
    i.addEventListener("keydown", e => { if (e.key === "Enter") submit(); }));
}

/* ========================================================= ONBOARDING === */
function renderOnboarding() {
  let step = 1;
  const data = {
    monthlyIncome: 2500, housing: 1200, dailyLife: 400, subscriptions: 80,
    investPct: 8, dcaMode: "dca", firstDepositNow: true,
  };

  const draw = () => {
    const monthly = (data.monthlyIncome * data.investPct / 100);
    root().innerHTML = `
    <div class="auth-screen">
      <div class="auth-card wide">
        <div class="auth-brand">
          <div class="brand-mark">F</div>
          <div><div class="auth-brand-name">Welcome, ${esc(State.user.name)}</div>
          <div class="auth-brand-tag">Budget Setup</div></div>
        </div>
        <div class="onboard-steps">
          <div class="onboard-step done"></div>
          <div class="onboard-step ${step >= 2 ? "done" : ""}"></div>
        </div>
        <div class="form-error" id="ob-error"></div>
        ${step === 1 ? `
        <div class="auth-title">Your Monthly Budget</div>
        <div class="auth-sub">Just like Finary: we start with your income, subtract your fixed expenses, and see what you can put toward investing.</div>
        <div class="field"><label>Net Monthly Salary (€)</label><input id="ob-income" type="number" min="0" value="${data.monthlyIncome}"></div>
        <div class="field-row">
          <div class="field"><label>Housing (Rent + Utilities)</label><input id="ob-housing" type="number" min="0" value="${data.housing}"></div>
          <div class="field"><label>Daily Life</label><input id="ob-daily" type="number" min="0" value="${data.dailyLife}"></div>
        </div>
        <div class="field"><label>Subscriptions</label><input id="ob-subs" type="number" min="0" value="${data.subscriptions}"></div>
        <button class="btn-primary" id="ob-next">Continue</button>
        ` : `
        <div class="auth-title">How much to invest each month?</div>
        <div class="auth-sub">You decide the percentage. Above <b>10%</b> of your income, we will ask for an explicit confirmation — simple prudence, not a restriction.</div>
        <div class="field">
          <label>Share of salary to invest</label>
          <input id="ob-pct" class="budget-slider" type="range" min="0" max="40" step="1" value="${data.investPct}">
          <div class="budget-slider-readout">
            <span class="mono" style="font-size:22px;" id="ob-pct-val">${data.investPct} %</span>
            <span style="color:var(--text-tertiary); font-size:12px;" id="ob-pct-eur">≈ ${fmtEur(monthly)} / month</span>
          </div>
          <div class="budget-alert" id="ob-alert" style="display:${data.investPct > 10 ? "flex" : "none"};">
            ${icon.warn}<div>You are exceeding the caution threshold of <b>10%</b> of your income. It is your choice — a confirmation will be requested.</div>
          </div>
        </div>
        <div class="field">
          <label>Contribution Mode</label>
          <div class="mode-toggle">
            <button type="button" data-mode="dca" class="${data.dcaMode === "dca" ? "active" : ""}">DCA — Monthly</button>
            <button type="button" data-mode="once" class="${data.dcaMode === "once" ? "active" : ""}">One-time Deposit</button>
          </div>
          <div class="hint">DCA (Dollar-Cost Averaging): invest the same amount at regular intervals to average the purchase price.</div>
        </div>
        <label class="confirm-check">
          <input type="checkbox" id="ob-firstnow" ${data.firstDepositNow ? "checked" : ""}>
          <span>Make the first deposit now (${fmtEur(monthly)}) to be able to place your first virtual orders.</span>
        </label>
        <button class="btn-primary" id="ob-finish">Complete Setup</button>
        <button class="btn-ghost" id="ob-back">Back</button>
        `}
      </div>
    </div>`;
    bind();
  };

  const bind = () => {
    if (step === 1) {
      $("#ob-next").addEventListener("click", () => {
        data.monthlyIncome = +$("#ob-income").value || 0;
        data.housing = +$("#ob-housing").value || 0;
        data.dailyLife = +$("#ob-daily").value || 0;
        data.subscriptions = +$("#ob-subs").value || 0;
        const err = $("#ob-error");
        if (data.monthlyIncome <= 0) { err.textContent = "Please enter a valid monthly salary."; err.classList.add("visible"); return; }
        if (data.housing + data.dailyLife + data.subscriptions > data.monthlyIncome) {
          err.textContent = "Your fixed expenses exceed your salary — please check the amounts."; err.classList.add("visible"); return;
        }
        step = 2; draw();
      });
    } else {
      const slider = $("#ob-pct");
      slider.addEventListener("input", () => {
        data.investPct = +slider.value;
        $("#ob-pct-val").textContent = data.investPct + " %";
        $("#ob-pct-eur").textContent = "≈ " + fmtEur(data.monthlyIncome * data.investPct / 100) + " / month";
        $("#ob-alert").style.display = data.investPct > 10 ? "flex" : "none";
      });
      root().querySelectorAll("[data-mode]").forEach(b =>
        b.addEventListener("click", () => { data.dcaMode = b.dataset.mode; draw(); }));
      $("#ob-back").addEventListener("click", () => { step = 1; draw(); });
      $("#ob-finish").addEventListener("click", () => submitOnboarding(false));
    }
  };

  const submitOnboarding = async confirmed => {
    const chk = $("#ob-firstnow");
    if (chk) data.firstDepositNow = chk.checked;
    try {
      const res = await API.post("/api/auth/onboarding", { ...data, confirmedOverThreshold: confirmed });
      if (res.confirmationRequired) {
        const ok = await confirmModal({
          title: "Above Caution Threshold",
          body: `You have chosen to invest <b>${data.investPct} %</b> of your monthly income, which is <b>${fmtEur(data.monthlyIncome * data.investPct / 100)}</b> per month.`,
          warning: `The caution threshold is set at <b>10 %</b>. Investing more reduces your safety margin in case of unforeseen events. The decision is yours.`,
          checkLabel: "I understand the risk and confirm this percentage.",
          confirmText: "Confirm " + data.investPct + " %",
        });
        if (ok) return submitOnboarding(true);
        return;
      }
      State.user = res.user;
      State.budget = res.budget;
      toast("Budget configured ✓", "success");
      await enterApp();
    } catch (e) {
      const err = $("#ob-error");
      err.textContent = e.code === "COSTS_EXCEED_INCOME"
        ? "Your fixed expenses exceed your salary."
        : "Error saving. Please try again.";
      err.classList.add("visible");
    }
  };

  draw();
}

/* ============================================================ APP SHELL = */
const VIEWS = [
  { id: "dashboard", label: "Dashboard", eyebrow: "Overview", title: "Dashboard", subtitle: "Your simulated wealth — sector by sector, country by country.", icon: icon.home },
  { id: "budget", label: "Budget", eyebrow: "Income & deposits", title: "Budget", subtitle: "Where the money comes from, where it goes — and what you invest.", icon: icon.budget },
  { id: "trading", label: "Invest", eyebrow: "Place an order", title: "Trading", subtitle: "Buy and sell on real prices without risking a single penny.", icon: icon.trade },
  { id: "news", label: "News", eyebrow: "Filtered feed", title: "News Feed", subtitle: "Only financial news concerning your positions and markets.", icon: icon.news },
  { id: "agent", label: "AI Agent", eyebrow: "Assistant", title: "AI Agent", subtitle: "Your co-pilot who translates risk into concrete euros.", icon: icon.agent },
  { id: "risk", label: "Risks", eyebrow: "Before investing", title: "Understand Risks", subtitle: "Key concepts illustrated with your own portfolio.", icon: icon.shield },
  { id: "account", label: "My Account", eyebrow: "Settings", title: "My Account", subtitle: "Profile, password and personal data.", icon: icon.user },
  { id: "admin", label: "Admin", eyebrow: "Administration", title: "User Management", subtitle: "Accounts, activity, and deletion — reserved for administrators.", icon: icon.admin, adminOnly: true },
];
const visibleViews = () => VIEWS.filter(v => !v.adminOnly || (State.user && State.user.role === "admin"));

async function enterApp() {
  root().innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand" style="cursor:pointer;" id="sidebar-brand-btn">
        <div class="brand-mark" style="width:30px;height:30px;border-radius:9px;font-size:16px;">F</div>
        <div><div class="brand-name">Finwise</div><div class="brand-tag">Simulator</div></div>
      </div>
      <nav class="nav" id="nav"></nav>
      <div class="sidebar-footer">
        <div class="disclaimer-pill"><b>Educational tool.</b> Virtual portfolio — nothing here constitutes real investment advice.</div>
        <button class="logout-btn" id="logout-btn">Log Out</button>
      </div>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <div class="page-eyebrow" id="page-eyebrow"></div>
          <div class="page-title" id="page-title"></div>
          <div class="page-subtitle" id="page-subtitle"></div>
        </div>
        <div class="topbar-right">
          <span class="demo-chip" id="demo-chip" style="display:none;">Simulated Data</span>
          <div class="cash-chip">Cash · <b id="cash-chip-value">—</b></div>
          <div class="avatar" id="avatar-btn" style="cursor:pointer;" title="My account">${esc((State.user.name || "?").slice(0, 2).toUpperCase())}</div>
        </div>
      </div>
      <div id="view-root"></div>
    </main>
  </div>`;

  $("#avatar-btn").addEventListener("click", () => navigate("account"));
  $("#logout-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    stopPolling();
    try {
      await API.post("/api/auth/logout");
    } catch (err) {
      /* Even if the network call fails (expired session, offline, ...),
         the user still expects to land back on the login screen instantly. */
    }
    State.user = null;
    State.portfolio = null;
    State.budget = null;
    State.plan = null;
    State.deposits = [];
    State.newsCache = {};
    State.newsCategory = "all";
    State.newsSymbolFilter = "all";
    State.newsSearchQuery = "";
    State.chat = [];
    State.insights = null;
    State.view = "dashboard";
    renderLanding();
    root().scrollTo?.(0, 0);
  });

  try {
    const st = await API.get("/api/market/status");
    State.demoMode = !!st.demoMode;
    $("#demo-chip").style.display = State.demoMode ? "inline-block" : "none";
  } catch (e) { /* non-blocking */ }

  await Promise.all([refreshPortfolio(), refreshBudget()]);
  navigate("dashboard");
  startPolling();
}

function navigate(viewId) {
  State.view = viewId;
  const v = VIEWS.find(x => x.id === viewId) || VIEWS[0];
  $("#page-eyebrow").textContent = v.eyebrow;
  $("#page-title").textContent = v.title;
  $("#page-subtitle").textContent = v.subtitle;
  $("#nav").innerHTML = visibleViews().map(x => `
    <button class="nav-item ${x.id === viewId ? "active" : ""}" data-nav="${x.id}">
      ${x.icon}<span>${x.label}</span>
    </button>`).join("");
  $("#nav").querySelectorAll("[data-nav]").forEach(b =>
    b.addEventListener("click", () => navigate(b.dataset.nav)));
  ({
    dashboard: renderDashboard, budget: renderBudget, trading: renderTrading,
    news: renderNews, agent: renderAgent, risk: renderRisk,
    account: renderAccount, admin: renderAdmin,
  }[viewId])();
  window.scrollTo(0, 0);
}

function updateCashChip() {
  const el = $("#cash-chip-value");
  if (el && State.portfolio) el.textContent = fmtEur(State.portfolio.cash, 2);
}

async function refreshPortfolio() {
  State.portfolio = await API.get("/api/portfolio");
  updateCashChip();
}
async function refreshBudget() {
  const b = await API.get("/api/budget");
  State.budget = b.budget; State.plan = b.plan; State.deposits = b.deposits;
  State.thresholdPct = b.thresholdPct != null ? b.thresholdPct : 10;
  if (b.user) State.user = b.user;
}

/* ------------------------------------------------ realtime quote polling */
function startPolling() {
  stopPolling();
  State.pollTimer = setInterval(pollQuotes, 15000);
}
function stopPolling() {
  clearInterval(State.pollTimer); State.pollTimer = null;
  clearInterval(State.newsAutoTimer); State.newsAutoTimer = null;
}

async function pollQuotes() {
  if (!State.portfolio) return;
  const symbols = new Set(State.portfolio.positions.map(p => p.symbol));
  if (State.trade.detail) symbols.add(State.trade.detail.symbol);
  if (!symbols.size) return;
  try {
    const quotes = await API.get("/api/market/quotes?symbols=" + [...symbols].join(","));
    for (const p of State.portfolio.positions) {
      const q = quotes[p.symbol];
      if (!q) continue;
      p.price = q.price; p.changePct = q.changePct;
      p.value = +(q.price * p.shares).toFixed(2);
      p.pnl = +((q.price - p.avg_cost) * p.shares).toFixed(2);
    }
    State.portfolio.invested = +State.portfolio.positions.reduce((s, p) => s + p.value, 0).toFixed(2);
    State.portfolio.total = +(State.portfolio.invested + State.portfolio.cash).toFixed(2);
    if (State.trade.detail && quotes[State.trade.detail.symbol]) {
      Object.assign(State.trade.detail, quotes[State.trade.detail.symbol]);
    }
    /* DOM patch in place — no re-render: no lost scroll */
    document.querySelectorAll("[data-live]").forEach(el => {
      const parts = el.dataset.live.split(":");
      const kind = parts[0], sym = parts[1];
      const p = State.portfolio.positions.find(x => x.symbol === sym) ||
        (State.trade.detail && State.trade.detail.symbol === sym ? State.trade.detail : null);
      if (!p) return;
      let txt = null;
      if (kind === "price") txt = fmtEur(p.price, 2);
      if (kind === "value") txt = fmtEur(p.value);
      if (kind === "chg") { txt = fmtPct(p.changePct); el.className = "tag " + (p.changePct >= 0 ? "positive" : "negative"); }
      if (txt !== null && el.textContent !== txt) {
        el.textContent = txt;
        el.classList.remove("tick-flash"); void el.offsetWidth; el.classList.add("tick-flash");
      }
    });
    const totalEl = document.querySelector("[data-live-total]");
    if (totalEl) totalEl.textContent = fmtEur(State.portfolio.total);
    const investedEl = document.querySelector("[data-live-invested]");
    if (investedEl) investedEl.textContent = fmtEur(State.portfolio.invested);
    updateCashChip();
    if (State.view === "trading") updateOrderSummary();
  } catch (e) { /* next tick will try again */ }
}

/* ============================================================ DASHBOARD = */
function computeBreakdown(by) {
  const pf = State.portfolio;
  const acc = {};
  for (const p of pf.positions) {
    const key = p[by] || "Other";
    acc[key] = (acc[key] || 0) + p.value;
  }
  return Object.entries(acc).map(([key, value]) => ({
    key,
    label: by === "sector" ? (SECTOR_EN[key] || key) : key,
    color: by === "sector" ? (SECTOR_COLORS[key] || "#6b6d80") : "#6fb8b0",
    value,
    pct: pf.invested > 0 ? (value / pf.invested) * 100 : 0,
  })).sort((a, b) => b.pct - a.pct);
}

function renderDashboard() {
  const pf = State.portfolio;
  const deposited = State.deposits.reduce((s, d) => s + d.amount, 0);
  const delta = pf.total - deposited;
  const deltaPct = deposited > 0 ? (delta / deposited) * 100 : 0;

  if (!pf.positions.length) {
    $("#view-root").innerHTML = `<div class="view">
      <div class="hero-row">
        <div class="hero-value-card">
          <div class="hero-label">Total Portfolio Value</div>
          <div class="hero-number"><span data-live-total>${fmtEur(pf.total)}</span> <small>virtual</small></div>
          <div class="hero-sub">Total Deposited: ${fmtEur(deposited)} · Available Cash: ${fmtEur(pf.cash, 2)}</div>
        </div>
        <div class="empty-state" style="display:flex;flex-direction:column;justify-content:center;gap:14px;">
          <div><b>No positions yet.</b><br>
          Fund your account in <b>Budget</b>, then place your first order.</div>
          <button class="btn-primary" id="dash-go-invest" style="max-width:260px;margin:0 auto;">+ Add a position</button>
        </div>
      </div></div>`;
    const goBtn = $("#dash-go-invest");
    if (goBtn) goBtn.addEventListener("click", () => navigate("trading"));
    return;
  }

  const breakdown = computeBreakdown(State.breakdownView);
  const top = breakdown[0];
  const riskEuros = top.value * 0.20;
  const overexposed = top.pct > 50;
  const spark = (pf.positions[0] && pf.positions[0].sparkline) || [];

  $("#view-root").innerHTML = `<div class="view">
    <div class="hero-row">
      <div class="hero-value-card">
        <div class="hero-label">Total Portfolio Value</div>
        <div class="hero-number"><span data-live-total>${fmtEur(pf.total)}</span> <small>virtual</small></div>
        <div class="hero-delta">
          <span class="tag ${delta >= 0 ? "positive" : "negative"}">${fmtPct(deltaPct)}</span>
          <span class="mono" style="color:var(--text-secondary)">${delta >= 0 ? "+" : ""}${fmtEur(delta)} vs total deposited</span>
        </div>
        <div class="hero-sub"><span class="live-dot"></span>Prices updated every 15s · Total deposited: ${fmtEur(deposited)}</div>
      </div>
      <div class="card gauge-card" style="min-height:auto;">
        <div class="card-title">Invested vs Cash</div>
        <div class="budget-stat-row">
          <div><div class="tiny-label">Invested</div><div class="mono budget-figure" data-live-invested>${fmtEur(pf.invested)}</div></div>
          <div><div class="tiny-label">Cash</div><div class="mono budget-figure">${fmtEur(pf.cash, 2)}</div></div>
          <div><div class="tiny-label">Positions</div><div class="mono budget-figure">${pf.positions.length}</div></div>
        </div>
        <div style="flex:1; min-height:120px;">${sparklineSvg(spark, { w: 500, h: 130, stroke: delta >= 0 ? "#7fb88f" : "#e0645a", fill: true, cls: "chart-svg" })}</div>
      </div>
    </div>

    <div class="risk-gauge-row">
      <div class="card gauge-card">
        <div class="card-title">${State.breakdownView === "country" ? "Geographical Exposure" : "Sector Exposure"}</div>
        <div class="gauge-body">
          <div class="gauge-half">
            ${riskGaugeSvg(top.pct)}
            <div class="gauge-readout">
              <div class="pct" style="color:${top.color}">${top.pct.toFixed(0)}%</div>
              <div class="lbl">${esc(top.label)}</div>
            </div>
          </div>
          ${overexposed ? `
          <div class="warning-half alert">
            <div class="warning-head">${icon.warn}<span class="warning-title">High Concentration</span></div>
            <div class="warning-figure">−${fmtEur(riskEuros)}</div>
            <div class="warning-text">Estimated loss if this exposure corrects by <b>20%</b> — this is what a percentage means in real euros.</div>
          </div>` : `
          <div class="warning-half ok">
            <div class="warning-head">${icon.check}<span class="warning-title">Balanced Allocation</span></div>
            <div class="warning-text">No concentration alerts at the moment. Keep an eye on this gauge as you trade.</div>
          </div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Breakdown ${State.breakdownView === "country" ? "by country" : "by sector"}
          <div class="segmented">
            <button data-bd="sector" class="${State.breakdownView === "sector" ? "active" : ""}">Sector</button>
            <button data-bd="country" class="${State.breakdownView === "country" ? "active" : ""}">Country</button>
          </div>
        </div>
        <div class="sector-list">
          ${breakdown.map(s => `
          <div class="sector-row">
            <div class="sector-row-top">
              <span class="name">${esc(s.label)}</span>
              <span class="pct">${fmtEur(s.value)} · ${s.pct.toFixed(1)} %</span>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width:${s.pct}%;background:${s.color};"></div></div>
          </div>`).join("")}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Positions
        <button class="filter-chip" id="dash-add-pos">+ Add position</button>
      </div>
      <table class="holdings-table">
        <thead><tr><th>Asset</th><th>Sector</th><th>Country</th><th>Price</th><th>Chg.</th><th>Trend</th><th>Value</th><th>P&L</th></tr></thead>
        <tbody>
          ${pf.positions.map(h => `
          <tr>
            <td><div class="stock-cell">
              <div class="stock-logo">${esc(h.symbol.slice(0, 2))}</div>
              <div><div class="stock-name">${esc(h.name || h.symbol)}</div>
              <div class="stock-ticker">${esc(h.symbol)} · ${fmtQty(h.shares)} share(s)</div></div>
            </div></td>
            <td><span class="tag" style="background:${(SECTOR_COLORS[h.sector] || "#6b6d80")}22;color:${SECTOR_COLORS[h.sector] || "#6b6d80"};">${esc(SECTOR_EN[h.sector] || h.sector || "—")}</span></td>
            <td style="font-size:12.5px;color:var(--text-secondary);">${esc(h.country || "—")}</td>
            <td class="mono" data-live="price:${esc(h.symbol)}">${fmtEur(h.price, 2)}</td>
            <td><span class="tag ${h.changePct >= 0 ? "positive" : "negative"}" data-live="chg:${esc(h.symbol)}">${fmtPct(h.changePct)}</span></td>
            <td>${sparklineSvg(h.sparkline, { w: 80, h: 26, stroke: h.changePct >= 0 ? "#7fb88f" : "#e0645a" })}</td>
            <td class="mono" data-live="value:${esc(h.symbol)}">${fmtEur(h.value)}</td>
            <td class="mono" style="color:${h.pnl >= 0 ? "var(--positive)" : "var(--negative)"}">${h.pnl >= 0 ? "+" : ""}${fmtEur(h.pnl)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;

  $("#view-root").querySelectorAll("[data-bd]").forEach(b =>
    b.addEventListener("click", () => { State.breakdownView = b.dataset.bd; renderDashboard(); }));
  const addBtn = $("#dash-add-pos");
  if (addBtn) addBtn.addEventListener("click", () => navigate("trading"));
}

/* =============================================================== BUDGET = */
function renderBudget() {
  const b = State.budget;
  if (!b) {
    $("#view-root").innerHTML = `<div class="view"><div class="empty-state"><b>Budget not configured.</b></div></div>`;
    return;
  }
  const local = { investPct: b.invest_pct, dcaMode: b.dca_mode }; // local form state
  const income = b.monthly_income;
  const monthlyOf = pct => income * pct / 100;
  const rest = () => Math.max(0, income - b.housing - b.daily_life - b.subscriptions - monthlyOf(local.investPct));

  const sankey = () => sankeySvg(income, [
    { label: "Monthly Investments", value: monthlyOf(local.investPct), color: "#e3b567" },
    { label: "Housing", value: b.housing, color: "#8f8fd9" },
    { label: "Daily Life", value: b.daily_life, color: "#6fb8b0" },
    { label: "Subscriptions", value: b.subscriptions, color: "#7fb88f" },
    { label: "Remaining Balance", value: rest(), color: "#9a9cae" },
  ]);

  $("#view-root").innerHTML = `<div class="view">
    <div class="budget-intro"><p>The chart below works just like Finary: your salary funds the budget, which is distributed between fixed expenses, investments, and remaining balance. Move the slider to see the effect of changing the percentage — nothing is saved until you confirm.</p></div>

    <div class="card">
      <div class="card-title">Monthly Flow — ${fmtEur(income)}</div>
      <div class="sankey-wrap" id="sankey-wrap">${sankey()}</div>
    </div>

    <div class="budget-grid">
      <div class="card">
        <div class="card-title">Share Invested Monthly</div>
        <div class="budget-stat-row">
          <div><div class="tiny-label">Salary</div><div class="mono budget-figure">${fmtEur(income)}</div></div>
          <div><div class="tiny-label">Fixed Expenses</div><div class="mono budget-figure">${fmtEur(b.housing + b.daily_life + b.subscriptions)}</div></div>
          <div><div class="tiny-label">Remaining</div><div class="mono budget-figure" id="bg-rest">${fmtEur(rest())}</div></div>
        </div>
        <label class="tiny-label">Percentage of salary invested</label>
        <input id="bg-pct" class="budget-slider" type="range" min="0" max="40" step="1" value="${local.investPct}">
        <div class="budget-slider-readout">
          <span class="mono" style="font-size:22px;" id="bg-pct-val">${local.investPct} %</span>
          <span style="color:var(--text-tertiary);font-size:12px;" id="bg-pct-eur">≈ ${fmtEur(monthlyOf(local.investPct))} / month</span>
        </div>
        <div class="budget-alert" id="bg-alert" style="display:${local.investPct > State.thresholdPct ? "flex" : "none"};">
          ${icon.warn}<div>Above <b>${State.thresholdPct} %</b> of your income: an explicit confirmation will be requested when saving. The decision remains yours.</div>
        </div>
        <div class="mode-toggle" style="margin-top:14px;">
          <button type="button" data-mode="dca" class="${local.dcaMode === "dca" ? "active" : ""}">DCA — Monthly</button>
          <button type="button" data-mode="once" class="${local.dcaMode === "once" ? "active" : ""}">One-time Deposit</button>
        </div>
        <button class="btn-primary" id="bg-save" style="margin-top:14px;">Save Budget</button>
        ${State.plan && State.plan.active ? `
        <div class="budget-alert ok" style="margin-top:14px;">
          ${icon.check}<div>Active DCA Plan: <b>${fmtEur(State.plan.monthly_amount, 2)}</b> / month.
          ${State.plan.last_executed_at ? `Last deposit: ${esc(State.plan.last_executed_at.slice(0, 10))}.` : "No deposit executed yet."}</div>
        </div>
        <button class="btn-ghost" id="bg-exec">Execute this month's deposit (${fmtEur(State.plan.monthly_amount, 2)})</button>` : ""}
      </div>

      <div class="card">
        <div class="card-title">Add One-Time Cash</div>
        <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
          A one-time deposit adds to your plan. If it exceeds <b>${State.thresholdPct}%</b> of your monthly salary, a warning will be displayed and your confirmation is required.</p>
        <div class="field"><label>Amount (€)</label><input id="dep-amount" type="number" min="1" placeholder="200"></div>
        <button class="btn-primary" id="dep-btn">Deposit into my virtual account</button>

        <div class="card-title" style="margin-top:22px;">Deposit History</div>
        <div class="deposit-history" id="dep-history">${depositHistoryHtml()}</div>
      </div>
    </div>
  </div>`;

  /* --- IN PLACE interactions --- */
  const slider = $("#bg-pct");
  slider.addEventListener("input", () => {
    local.investPct = +slider.value;
    $("#bg-pct-val").textContent = local.investPct + " %";
    $("#bg-pct-eur").textContent = "≈ " + fmtEur(monthlyOf(local.investPct)) + " / month";
    $("#bg-rest").textContent = fmtEur(rest());
    $("#bg-alert").style.display = local.investPct > State.thresholdPct ? "flex" : "none";
    $("#sankey-wrap").innerHTML = sankey();
  });
  document.querySelectorAll("#view-root [data-mode]").forEach(btn =>
    btn.addEventListener("click", () => {
      local.dcaMode = btn.dataset.mode;
      document.querySelectorAll("#view-root [data-mode]").forEach(x =>
        x.classList.toggle("active", x.dataset.mode === local.dcaMode));
    }));

  const saveBudget = async confirmed => {
    try {
      const res = await API.put("/api/budget/profile", {
        monthlyIncome: income, housing: b.housing, dailyLife: b.daily_life,
        subscriptions: b.subscriptions, investPct: local.investPct,
        dcaMode: local.dcaMode, confirmedOverThreshold: confirmed,
      });
      if (res.confirmationRequired) {
        const ok = await confirmModal({
          title: "Above Caution Threshold",
          body: `You wish to invest <b>${local.investPct} %</b> of your income, which is <b>${fmtEur(monthlyOf(local.investPct))}</b> per month.`,
          warning: `The caution threshold is set at <b>${State.thresholdPct} %</b> of your monthly income. This is your decision — we only want it to be made with full awareness.`,
          checkLabel: "I understand the risk and confirm this percentage.",
          confirmText: "Confirm " + local.investPct + " %",
        });
        if (ok) return saveBudget(true);
        return;
      }
      State.budget = res.budget; State.plan = res.plan;
      toast("Budget saved ✓", "success");
      renderBudget();
    } catch (e) { toast("Error saving budget.", "error"); }
  };
  $("#bg-save").addEventListener("click", () => saveBudget(false));

  const execBtn = $("#bg-exec");
  if (execBtn) execBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Monthly Deposit",
      body: `Execute this month's DCA deposit: <b>${fmtEur(State.plan.monthly_amount, 2)}</b> will be added to your virtual cash.`,
    });
    if (!ok) return;
    try {
      const res = await API.post("/api/budget/plan/execute");
      State.user = res.user;
      await Promise.all([refreshPortfolio(), refreshBudget()]);
      toast(`Deposit of ${fmtEur(res.executed, 2)} completed ✓`, "success");
      renderBudget();
    } catch (e) {
      toast(e.code === "NO_ACTIVE_PLAN" ? "No active plan." : "Error executing deposit.", "error");
    }
  });

  const doDeposit = async confirmed => {
    const amount = +$("#dep-amount").value;
    if (!amount || amount <= 0) { toast("Enter a valid amount.", "error"); return; }
    try {
      const res = await API.post("/api/budget/deposit", { amount, confirmedOverThreshold: confirmed });
      if (res.confirmationRequired) {
        const ok = await confirmModal({
          title: "Deposit Above Threshold",
          body: `You are about to deposit <b>${fmtEur(amount, 2)}</b>, which represents <b>${res.pctOfIncome} %</b> of your monthly salary.`,
          warning: `This amount exceeds the caution threshold of <b>${res.threshold} %</b>. You are free to proceed — simply confirm that this is a deliberate choice.`,
          checkLabel: "I understand and confirm this deposit.",
          confirmText: "Deposit " + fmtEur(amount, 2),
        });
        if (ok) return doDeposit(true);
        return;
      }
      State.user = res.user;
      await Promise.all([refreshPortfolio(), refreshBudget()]);
      toast(`Deposit of ${fmtEur(amount, 2)} completed ✓`, "success");
      $("#dep-history").innerHTML = depositHistoryHtml();
      $("#dep-amount").value = "";
      updateCashChip();
    } catch (e) { toast("Error making deposit.", "error"); }
  };
  $("#dep-btn").addEventListener("click", () => doDeposit(false));
}

function depositHistoryHtml() {
  if (!State.deposits.length) return `<div class="empty-state" style="padding:18px;">No deposits yet.</div>`;
  return State.deposits.map(d => `
    <div class="deposit-row">
      <div>
        <div>${d.type === "monthly" ? "Monthly Deposit (DCA)" : "One-time Deposit"}
          ${d.over_threshold ? `<span class="tag warning" style="margin-left:6px;">&gt; ${State.thresholdPct}% confirmed</span>` : ""}</div>
        <div class="when">${esc((d.created_at || "").slice(0, 16))}${d.pct_of_income != null ? ` · ${(+d.pct_of_income).toFixed(1)} % of salary` : ""}</div>
      </div>
      <div class="mono" style="color:var(--positive);">+${fmtEur(d.amount, 2)}</div>
    </div>`).join("");
}

/* ============================================================== TRADING = */
function renderTrading() {
  const pf = State.portfolio;
  if (!State.trade.symbol && pf.positions.length) State.trade.symbol = pf.positions[0].symbol;

  $("#view-root").innerHTML = `<div class="view"><div class="trading-layout">
    <div>
      <div class="search-box">
        ${icon.search}
        <input id="tr-search" type="text" placeholder="Search stock, ETF, crypto..." autocomplete="off">
        <div class="search-results" id="tr-results"></div>
      </div>
      <div class="card-title" style="margin-bottom:8px;">My positions</div>
      <div id="tr-watchlist">
        ${pf.positions.length ? pf.positions.map(h => `
        <div class="watchlist-item ${h.symbol === State.trade.symbol ? "active" : ""}" data-sym="${esc(h.symbol)}">
          <div class="watchlist-left">
            <div class="stock-logo" style="width:26px;height:26px;font-size:9.5px;">${esc(h.symbol.slice(0, 2))}</div>
            <div><div style="font-weight:600;font-size:12.5px;">${esc(h.symbol)}</div>
            <div style="font-size:10.5px;color:var(--text-tertiary);">${esc(h.name || "")}</div></div>
          </div>
          <div class="mono" style="font-size:12px;color:${h.changePct >= 0 ? "var(--positive)" : "var(--negative)"}">${fmtPct(h.changePct)}</div>
        </div>`).join("") : `<div class="empty-state" style="padding:18px;">No positions. Search for an asset above to start.</div>`}
      </div>
      <div class="card-title" style="margin:18px 0 8px;">Popular</div>
      <div id="tr-popular">
        ${[["AAPL", "Apple", "stock"], ["MC.PA", "LVMH", "stock"], ["CW8.PA", "World ETF", "etf"], ["BTC", "Bitcoin", "crypto"], ["ETH", "Ethereum", "crypto"], ["OAT10", "OAT 10 years", "bond"]].map(p => `
        <div class="watchlist-item" data-sym="${p[0]}">
          <div class="watchlist-left">
            <div class="stock-logo" style="width:26px;height:26px;font-size:9.5px;background:${CLASS_COLORS[p[2]]};">${p[0].slice(0, 2)}</div>
            <div><div style="font-weight:600;font-size:12.5px;">${p[0]}</div>
            <div style="font-size:10.5px;color:var(--text-tertiary);">${p[1]}</div></div>
          </div>
          <span class="tag" style="background:${CLASS_COLORS[p[2]]}22;color:${CLASS_COLORS[p[2]]};font-size:10px;">${CLASS_EN[p[2]]}</span>
        </div>`).join("")}
      </div>
    </div>
    <div class="card" id="tr-detail"><div class="empty-state">Select an asset or use search.</div></div>
    <div class="card" id="tr-order"></div>
  </div></div>`;

  /* --- search: 250ms debounce on /api/market/search --- */
  const input = $("#tr-search");
  const resultsEl = $("#tr-results");
  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 1) { resultsEl.classList.remove("open"); return; }
    debounce = setTimeout(async () => {
      try {
        const results = await API.get("/api/market/search?q=" + encodeURIComponent(q));
        resultsEl.innerHTML = results.length
          ? results.map(r => `
            <div class="search-result" data-sym="${esc(r.symbol)}">
              <span class="sym">${esc(r.symbol)} ${r.assetClass && r.assetClass !== "stock" ? `<span class="tag" style="background:${CLASS_COLORS[r.assetClass]}22;color:${CLASS_COLORS[r.assetClass]};font-size:9.5px;margin-left:5px;">${CLASS_EN[r.assetClass]}</span>` : ""}</span>
              <span class="desc">${esc(r.description || "")}</span>
            </div>`).join("")
          : `<div class="search-empty">No results for "${esc(q)}".</div>`;
        resultsEl.classList.add("open");
        resultsEl.querySelectorAll("[data-sym]").forEach(el =>
          el.addEventListener("click", () => {
            resultsEl.classList.remove("open");
            input.value = "";
            selectSymbol(el.dataset.sym);
          }));
      } catch (e) { /* silent */ }
    }, 250);
  });
  document.addEventListener("click", e => {
    if (!e.target.closest || !e.target.closest(".search-box")) resultsEl.classList.remove("open");
  });

  document.querySelectorAll("#tr-watchlist [data-sym], #tr-popular [data-sym]").forEach(el =>
    el.addEventListener("click", () => selectSymbol(el.dataset.sym)));

  if (State.trade.symbol) selectSymbol(State.trade.symbol);
  else renderOrderForm();
}

async function selectSymbol(symbol) {
  State.trade.symbol = symbol;
  State.trade.qty = 1;
  document.querySelectorAll("#tr-watchlist [data-sym]").forEach(el =>
    el.classList.toggle("active", el.dataset.sym === symbol));
  const detailEl = $("#tr-detail");
  if (!detailEl) return;
  detailEl.innerHTML = `<div class="empty-state">Loading ${esc(symbol)}...</div>`;
  try {
    const d = await API.get("/api/market/stock/" + encodeURIComponent(symbol));
    State.trade.detail = d;
    const held = State.portfolio.positions.find(p => p.symbol === symbol);
    detailEl.innerHTML = `
      <div class="stock-detail-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="stock-logo">${esc(symbol.slice(0, 2))}</div>
          <div><div style="font-weight:700;font-size:15px;">${esc(d.name || symbol)}</div>
          <div class="stock-ticker">${esc(symbol)} · ${esc(SECTOR_EN[d.sector] || d.sector || "—")} · ${esc(d.country || "—")} ${classTag(d.assetClass)}</div></div>
        </div>
        <div style="text-align:right;">
          <div class="stock-detail-price" data-live="price:${esc(symbol)}">${fmtEur(d.price, 2)}</div>
          <span class="tag ${d.changePct >= 0 ? "positive" : "negative"}" data-live="chg:${esc(symbol)}">${fmtPct(d.changePct)}</span>
          ${d.simulated && !State.demoMode ? `<div style="margin-top:6px;"><span class="tag warning">simulated price (no API coverage)</span></div>` : ""}
          ${d.yieldPct ? `<div style="margin-top:6px;"><span class="tag positive">yield ~${d.yieldPct}%/year</span></div>` : ""}
        </div>
      </div>
      <div class="chart-area">${sparklineSvg(d.sparkline, { w: 520, h: 180, stroke: d.changePct >= 0 ? "#7fb88f" : "#e0645a", fill: true })}</div>
      ${held ? `
      <div style="display:flex;justify-content:space-between;padding-top:14px;border-top:1px solid var(--border);">
        <div><div class="tiny-label">Current Position</div><div class="mono" style="font-size:14px;margin-top:4px;">${fmtQty(held.shares)} share(s) · <span data-live="value:${esc(symbol)}">${fmtEur(held.value)}</span></div></div>
        <div><div class="tiny-label">Average Cost</div><div class="mono" style="font-size:14px;margin-top:4px;">${fmtEur(held.avg_cost, 2)}</div></div>
        <div><div class="tiny-label">Unrealized P&L</div><div class="mono" style="font-size:14px;margin-top:4px;color:${held.pnl >= 0 ? "var(--positive)" : "var(--negative)"}">${held.pnl >= 0 ? "+" : ""}${fmtEur(held.pnl)}</div></div>
      </div>` : ""}`;
  } catch (e) {
    detailEl.innerHTML = `<div class="empty-state"><b>Symbol not found.</b> Try another search.</div>`;
    State.trade.detail = null;
  }
  renderOrderForm();
}

function renderOrderForm() {
  const el = $("#tr-order");
  if (!el) return;
  const d = State.trade.detail;
  if (!d) { el.innerHTML = `<div class="card-title">Place an Order</div><div class="empty-state" style="padding:18px;">Select an asset first.</div>`; return; }
  const t = State.trade;
  el.innerHTML = `
    <div class="card-title">Place an Order</div>
    <div class="buysell-toggle">
      <button type="button" class="buy ${t.side === "buy" ? "active" : ""}" data-side="buy">Buy</button>
      <button type="button" class="sell ${t.side === "sell" ? "active" : ""}" data-side="sell">Sell</button>
    </div>
    <div class="order-form">
      <label>Order Input</label>
      <div class="mode-toggle" style="margin-bottom:10px;">
        <button type="button" data-imode="qty" class="${t.inputMode === "qty" ? "active" : ""}">By Quantity</button>
        <button type="button" data-imode="eur" class="${t.inputMode === "eur" ? "active" : ""}">By Amount (€)</button>
      </div>
      <div id="order-input-zone"></div>
      <div id="order-summary"></div>
      <button class="btn-primary" id="order-btn" style="margin-top:14px;"></button>
      <div class="hint" style="margin-top:8px;color:var(--text-tertiary);font-size:11px;">Fractional shares allowed (up to 6 decimals) — like modern brokers, you can buy 0.001 Bitcoin or 0.5 shares.</div>
    </div>`;
  el.querySelectorAll("[data-side]").forEach(b =>
    b.addEventListener("click", () => {
      t.side = b.dataset.side;
      el.querySelectorAll("[data-side]").forEach(x => x.classList.toggle("active", x.dataset.side === t.side));
      renderOrderInputZone();
      updateOrderSummary();
    }));
  el.querySelectorAll("[data-imode]").forEach(b =>
    b.addEventListener("click", () => {
      t.inputMode = b.dataset.imode;
      el.querySelectorAll("[data-imode]").forEach(x => x.classList.toggle("active", x.dataset.imode === t.inputMode));
      renderOrderInputZone();
      updateOrderSummary();
    }));
  $("#order-btn").addEventListener("click", placeOrder);
  renderOrderInputZone();
  updateOrderSummary();
}

function heldShares() {
  const d = State.trade.detail;
  const held = d && State.portfolio.positions.find(p => p.symbol === d.symbol);
  return held ? held.shares : 0;
}

/* input zone: quantity (with +/− and Max) or amount in euros */
function renderOrderInputZone() {
  const zone = $("#order-input-zone");
  const t = State.trade;
  if (!zone) return;
  if (t.inputMode === "qty") {
    zone.innerHTML = `
      <div class="qty-input-wrap">
        <button type="button" id="qty-minus">–</button>
        <input id="qty-input" type="text" inputmode="decimal" value="${fmtQty(t.qty)}">
        <button type="button" id="qty-plus">+</button>
      </div>
      <button type="button" class="btn-ghost" id="qty-max" style="margin-top:8px;padding:8px;font-size:12px;">${t.side === "buy" ? "Max (all my cash)" : "Sell All"}</button>`;
    $("#qty-minus").addEventListener("click", () => stepQty(-0.5));
    $("#qty-plus").addEventListener("click", () => stepQty(+0.5));
    $("#qty-input").addEventListener("change", e => setQty(parseDecimal(e.target.value)));
    $("#qty-max").addEventListener("click", () => {
      const d = t.detail;
      if (!d) return;
      setQty(t.side === "buy" ? Math.floor((State.portfolio.cash / d.price) * 1e6) / 1e6 : heldShares());
    });
  } else {
    zone.innerHTML = `
      <div class="qty-input-wrap">
        <input id="amount-input" type="text" inputmode="decimal" value="${fmtQty(t.amount)}" style="padding:0 12px;text-align:left;">
        <span style="padding:0 12px;color:var(--text-tertiary);font-family:var(--font-mono);">€</span>
      </div>
      <button type="button" class="btn-ghost" id="amount-max" style="margin-top:8px;padding:8px;font-size:12px;">${t.side === "buy" ? "Max (all my cash)" : "Sell All"}</button>`;
    $("#amount-input").addEventListener("change", e => {
      t.amount = Math.max(0.01, Math.min(10_000_000, parseDecimal(e.target.value) || 0.01));
      e.target.value = fmtQty(t.amount);
      updateOrderSummary();
    });
    $("#amount-max").addEventListener("click", () => {
      const d = t.detail;
      if (!d) return;
      t.amount = t.side === "buy" ? Math.floor(State.portfolio.cash * 100) / 100 : Math.floor(heldShares() * d.price * 100) / 100;
      $("#amount-input").value = fmtQty(t.amount);
      updateOrderSummary();
    });
  }
}

/* "0,001" or "0.001" → 0.001 */
function parseDecimal(v) {
  return parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
}

/* +/− buttons: step 0.5 with floor at 0.5 (free input via keyboard
   remains possible down to 0.000001 for crypto) */
function stepQty(delta) {
  const next = Math.round((State.trade.qty + delta) * 1e6) / 1e6;
  setQty(next < 0.5 ? 0.5 : next);
}

function setQty(q) {
  const t = State.trade;
  t.qty = Math.max(0.000001, Math.min(100000, Math.round((q || 0) * 1e6) / 1e6));
  const inp = $("#qty-input");
  if (inp) inp.value = fmtQty(t.qty);
  updateOrderSummary();
}

/* actual quantity sent to server depending on input mode */
function effectiveQty() {
  const t = State.trade, d = t.detail;
  if (!d) return 0;
  if (t.inputMode === "qty") return t.qty;
  return Math.round((t.amount / d.price) * 1e6) / 1e6;
}

function updateOrderSummary() {
  const d = State.trade.detail;
  const sumEl = $("#order-summary");
  if (!d || !sumEl) return;
  const qty = effectiveQty();
  const est = d.price * qty;
  const cash = State.portfolio.cash;
  const after = State.trade.side === "buy" ? cash - est : cash + est;
  sumEl.innerHTML = `
    <div class="order-summary-row"><span>Current Price</span><b>${fmtEur(d.price, 2)}</b></div>
    <div class="order-summary-row"><span>Quantity</span><b>${fmtQty(qty)}</b></div>
    <div class="order-summary-row"><span>Estimated Amount</span><b>${fmtEur(est, 2)}</b></div>
    <div class="order-summary-row"><span>Cash after order</span><b style="color:${after < 0 ? "var(--negative)" : "inherit"}">${fmtEur(after, 2)}</b></div>`;
  const btn = $("#order-btn");
  if (btn) {
    btn.textContent = State.trade.side === "buy" ? "Confirm Purchase" : "Confirm Sale";
    btn.disabled = qty <= 0;
  }
}

async function placeOrder() {
  const d = State.trade.detail;
  if (!d) return;
  const side = State.trade.side;
  const qty = effectiveQty();
  if (qty <= 0) { toast("Invalid quantity.", "error"); return; }
  const est = d.price * qty;
  const ok = await confirmModal({
    title: side === "buy" ? "Confirm Purchase" : "Confirm Sale",
    body: `${side === "buy" ? "Buy" : "Sell"} <b>${fmtQty(qty)} × ${esc(d.symbol)}</b> at market price (~${fmtEur(d.price, 2)} / share), totaling approximately <b>${fmtEur(est, 2)}</b>.<br><br>The executed price will be the server price at the time of the order.`,
  });
  if (!ok) return;
  try {
    const res = await API.post("/api/portfolio/order", { symbol: d.symbol, side, qty });
    await refreshPortfolio();
    State.newsCache = {}; // holdings changed → personalized feed needs refresh
    State.insights = null; // holdings changed → risk/AI-agent analysis is stale, force recompute
    toast(`Order executed: ${fmtQty(res.qty ?? qty)} × ${fmtEur(res.executedPrice, 2)} — total ${fmtEur(res.total, 2)} ✓`, "success");
    renderTrading();
  } catch (e) {
    const map = { INSUFFICIENT_CASH: "Insufficient cash — fund your account in Budget.", INSUFFICIENT_SHARES: "You do not own enough shares.", SYMBOL_NOT_FOUND: "Symbol not found.", INVALID_QTY: "Invalid quantity." };
    toast(map[e.code] || "Error placing order.", "error");
  }
}

/* ================================================================= NEWS = */
function newsThumbHtml(n) {
  return n.image
    ? `<img src="${esc(n.image)}" alt="" class="news-thumb" loading="lazy">`
    : `<div class="news-thumb news-thumb-fallback">${icon.news}</div>`;
}

function newsCardHtml(n) {
  const companies = (n.relatedSymbols || []).slice(0, 4)
    .map(s => `<span class="news-stock-badge">${esc(s.symbol)}</span>`).join("");
  return `
    <button class="news-card" type="button" data-news-id="${esc(n.id)}">
      ${newsThumbHtml(n)}
      <div class="news-card-body">
        <div class="news-meta">
          <span class="tag news-cat-tag">${esc(NEWS_CAT_LABEL[n.category] || n.category)}</span>
          ${n.personalized ? `<span class="tag positive">Your Portfolio</span>` : ""}
          <span class="news-source">${esc(n.source || "")}</span>
          <span class="news-time">· ${timeAgo(n.datetime)}</span>
        </div>
        <div class="news-headline">${esc(n.headline)}</div>
        <div class="news-summary">${esc(n.summary || "")}</div>
        ${companies ? `<div class="news-companies">${companies}</div>` : ""}
      </div>
    </button>`;
}

function newsEmptyMessage(category, held) {
  if (category === "portfolio" && !held.length) {
    return `<div class="empty-state"><b>No positions yet.</b><br>Fund your account and place an order in "Invest": your personalized feed will appear here.</div>`;
  }
  return `<div class="empty-state">No news for this filter at the moment.</div>`;
}

async function fetchNewsCategory(category, { force = false } = {}) {
  const cached = State.newsCache[category];
  if (!force && cached && Date.now() - cached.at < NEWS_AUTOREFRESH_MS) return cached.items;
  const res = await API.get("/api/news?category=" + encodeURIComponent(category));
  State.newsCache[category] = { at: Date.now(), items: res.items || [] };
  return State.newsCache[category].items;
}

async function loadNews({ force = false } = {}) {
  const held = State.portfolio.positions.map(p => p.symbol);
  const listEl = $("#news-list");
  const symFiltersEl = $("#news-sym-filters");
  if (!listEl) return;

  if (State.newsCategory === "portfolio" && held.length) {
    symFiltersEl.style.display = "flex";
    symFiltersEl.innerHTML = [`<button class="filter-chip ${State.newsSymbolFilter === "all" ? "active" : ""}" data-nf="all">All my positions</button>`,
    ...held.map(s => `<button class="filter-chip ${State.newsSymbolFilter === s ? "active" : ""}" data-nf="${esc(s)}">${esc(s)}</button>`)].join("");
    symFiltersEl.querySelectorAll("[data-nf]").forEach(b =>
      b.addEventListener("click", () => { State.newsSymbolFilter = b.dataset.nf; loadNews(); }));
  } else {
    symFiltersEl.style.display = "none";
    symFiltersEl.innerHTML = "";
  }

  listEl.innerHTML = `<div class="empty-state">Loading news...</div>`;
  try {
    let items = await fetchNewsCategory(State.newsCategory, { force });
    if (State.newsCategory === "portfolio" && State.newsSymbolFilter !== "all") {
      items = items.filter(n => (n.relatedSymbols || []).some(s => s.symbol === State.newsSymbolFilter));
    }
    const q = State.newsSearchQuery.trim().toLowerCase();
    if (q) {
      items = items.filter(n =>
        (n.headline || "").toLowerCase().includes(q) ||
        (n.summary || "").toLowerCase().includes(q) ||
        (n.relatedSymbols || []).some(s => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
    }
    listEl.innerHTML = items.length ? items.map(newsCardHtml).join("")
      : (q ? `<div class="empty-state">No news matching "${esc(State.newsSearchQuery.trim())}".</div>` : newsEmptyMessage(State.newsCategory, held));

    listEl.querySelectorAll("[data-news-id]").forEach(el =>
      el.addEventListener("click", () => openNewsModal(items.find(n => n.id === el.dataset.newsId))));
    listEl.querySelectorAll("img.news-thumb").forEach(img =>
      img.addEventListener("error", () => { img.outerHTML = `<div class="news-thumb news-thumb-fallback">${icon.news}</div>`; }));
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Unable to load news at the moment.</div>`;
  }
}

function scheduleNewsAutoRefresh() {
  clearInterval(State.newsAutoTimer);
  State.newsAutoTimer = setInterval(() => {
    if (State.view === "news") loadNews({ force: true });
  }, NEWS_AUTOREFRESH_MS);
}

async function renderNews() {
  const held = State.portfolio.positions.map(p => p.symbol);
  const cats = NEWS_CATS.filter(c => c.id !== "portfolio" || held.length);

  $("#view-root").innerHTML = `<div class="view">
    <div class="news-toolbar">
      <div class="news-filters" id="news-cat-filters">
        ${cats.map(c => `<button class="filter-chip ${State.newsCategory === c.id ? "active" : ""}" data-cat="${c.id}">${esc(c.label)}</button>`).join("")}
      </div>
      <div class="search-box news-search-box">
        <input id="news-search" type="text" placeholder="Search news (e.g. Nvidia, AAPL)…" value="${esc(State.newsSearchQuery)}">
      </div>
      <button class="btn-ghost news-refresh-btn" id="news-refresh" type="button">${icon.refresh}<span>Refresh</span></button>
    </div>
    <div class="news-pipeline-note">Feed: live financial news via Finnhub · quotes fall back to Yahoo Finance for assets outside Finnhub's free-tier coverage.</div>
    <div class="news-filters" id="news-sym-filters" style="display:none;"></div>
    <div class="news-list" id="news-list"><div class="empty-state">Loading news...</div></div>
  </div>`;

  $("#news-cat-filters").querySelectorAll("[data-cat]").forEach(b =>
    b.addEventListener("click", () => {
      State.newsCategory = b.dataset.cat;
      State.newsSymbolFilter = "all";
      renderNews();
    }));
  $("#news-refresh").addEventListener("click", () => loadNews({ force: true }));

  /* --- search: 250ms debounce, filters the already-loaded feed client-side --- */
  let newsSearchDebounce = null;
  $("#news-search").addEventListener("input", (e) => {
    clearTimeout(newsSearchDebounce);
    const val = e.target.value;
    newsSearchDebounce = setTimeout(() => {
      State.newsSearchQuery = val;
      loadNews();
    }, 250);
  });

  await loadNews();
  scheduleNewsAutoRefresh();
}

/* -------------------------------------------------- news detail window -- */
function openNewsModal(item) {
  if (!item) return;
  const bd = $("#news-modal-backdrop");
  $("#news-modal-image").innerHTML = item.image ? `<img src="${esc(item.image)}" alt="" class="news-modal-img">` : "";
  $("#news-modal-meta").innerHTML = `
    <span class="tag news-cat-tag">${esc(NEWS_CAT_LABEL[item.category] || item.category)}</span>
    ${item.personalized ? `<span class="tag positive">Your Portfolio</span>` : ""}
    <span class="news-source">${esc(item.source || "")}</span>
    <span class="news-time">· ${new Date(item.datetime).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>`;
  $("#news-modal-title").textContent = item.headline;
  $("#news-modal-summary").textContent = item.summary || "No summary available for this article.";

  const companies = item.relatedSymbols || [];
  const companiesEl = $("#news-modal-companies");
  companiesEl.innerHTML = companies.length ? `
    <div class="card-title" style="margin:16px 0 8px;font-size:12px;">Related companies / assets</div>
    <div class="news-companies">${companies.map(c =>
    `<button class="news-stock-badge news-stock-badge-link" type="button" data-goto="${esc(c.symbol)}">${esc(c.symbol)} · ${esc(c.name)}</button>`).join("")}</div>` : "";
  companiesEl.querySelectorAll("[data-goto]").forEach(b =>
    b.addEventListener("click", () => { closeNewsModal(); State.trade.symbol = b.dataset.goto; navigate("trading"); }));

  const linkEl = $("#news-modal-link");
  if (item.url) { linkEl.href = item.url; linkEl.style.display = "inline-flex"; }
  else linkEl.style.display = "none";

  bd.classList.add("open");
  bd.onclick = e => { if (e.target === bd) closeNewsModal(); };
  $("#news-modal-close").onclick = closeNewsModal;
  $("#news-modal-ok").onclick = closeNewsModal;
}
function closeNewsModal() { $("#news-modal-backdrop").classList.remove("open"); }

/* ================================================================ AGENT = */
async function renderAgent() {
  $("#view-root").innerHTML = `<div class="view"><div class="agent-layout">
    <div>
      <div id="agent-alerts"></div>
      <div class="card">
        <div class="card-title">Conversation with the Agent
          <div style="display:flex;gap:6px;">
            <button class="filter-chip" id="chat-new">+ New</button>
            <button class="filter-chip" id="chat-clear">Delete</button>
          </div>
        </div>
        <div class="chat-thread" id="chat-thread"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Write to the agent… (e.g.: what is my risk?)" maxlength="2000">
          <button id="chat-send">${icon.send}</button>
        </div>
      </div>
    </div>
    <div>
      <div class="card" style="margin-bottom:16px;"><div class="card-title">Rebalancing Suggestions</div><div id="agent-suggestions"><div class="empty-state" style="padding:18px;">Analysis in progress…</div></div></div>
      <div class="card"><div class="card-title">Archived Conversations</div><div id="chat-archives"></div></div>
    </div>
  </div></div>`;

  if (!State.chat.length) resetChat();
  drawChat();
  drawArchives();
  $("#chat-send").addEventListener("click", sendChat);
  $("#chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
  $("#chat-new").addEventListener("click", newConversation);
  $("#chat-clear").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Delete conversation",
      body: "The current conversation will be permanently deleted (without archiving). Continue?",
      confirmText: "Delete",
    });
    if (!ok) return;
    resetChat();
    drawChat();
    toast("Conversation deleted", "success");
  });

  try {
    State.insights = await API.get("/api/agent/insights");
    const a = State.insights;
    $("#agent-alerts").innerHTML = a.alerts.length ? a.alerts.map(al => `
      <div class="alert-card">
        <div class="alert-icon">${icon.warn}</div>
        <div><div class="alert-title">${al.type === "SECTOR_CONCENTRATION" ? "Overexposure detected · " + esc(SECTOR_EN[al.label] || al.label) : "Geographical concentration · " + esc(al.label)}</div>
        <div class="alert-body">${esc(al.message)}</div></div>
      </div>`).join("") : `
      <div class="budget-alert ok" style="margin:0 0 14px;">${icon.check}<div><b>No concentration alerts.</b> Your allocation remains below caution thresholds — the agent continues monitoring.</div></div>`;

    const top = a.sectorBreakdown[0];
    const under = a.underRepresented.slice(0, 3);
    $("#agent-suggestions").innerHTML = a.sectorBreakdown.length ? `
      ${top && top.pct > a.threshold ? `
      <div class="suggestion-item"><div class="suggestion-icon">1</div>
        <div class="suggestion-text">Slightly reduce exposure to <b>${esc(SECTOR_EN[top.label] || top.label)}</b>, your dominant sector (${top.pct} %).</div></div>` : ""}
      ${under.map((s, i) => `
      <div class="suggestion-item"><div class="suggestion-icon">${(top && top.pct > a.threshold ? 2 : 1) + i}</div>
        <div class="suggestion-text">Increase <b>${esc(SECTOR_EN[s] || s)}</b>, underrepresented in your portfolio.</div></div>`).join("")}
      <div class="suggestion-item"><div class="suggestion-icon">i</div>
        <div class="suggestion-text">Educational goal: keep every sector under <b>${a.threshold} %</b> of the invested portfolio.</div></div>`
      : `<div class="empty-state" style="padding:18px;">Place a first order to get an analysis.</div>`;
  } catch (e) {
    $("#agent-suggestions").innerHTML = `<div class="empty-state" style="padding:18px;">Analysis unavailable.</div>`;
  }
}

/* --- conversation management: archives in localStorage, per user --- */
function archiveKey() { return "finwise-chats-" + (State.user ? State.user.id : "anon"); }
function loadArchives() {
  try { return JSON.parse(localStorage.getItem(archiveKey()) || "[]"); } catch (e) { return []; }
}
function saveArchives(list) {
  try { localStorage.setItem(archiveKey(), JSON.stringify(list.slice(0, 20))); } catch (e) { /* quota */ }
}
function welcomeMessage() {
  return {
    role: "assistant",
    content: `Hello ${State.user.name} 👋 I am the Finwise Agent. I monitor your portfolio and can explain: risk, diversification, DCA, compound interest, ETFs, bonds, crypto-assets, life insurance, dividends, retirement accounts… Ask me anything!`,
  };
}
function resetChat() { State.chat = [welcomeMessage()]; }
function newConversation() {
  // archives current conversation if it contains at least one exchange
  if (State.chat.some(m => m.role === "user")) {
    const archives = loadArchives();
    const firstUser = State.chat.find(m => m.role === "user");
    archives.unshift({
      at: Date.now(),
      title: firstUser ? firstUser.content.slice(0, 60) : "Conversation",
      messages: State.chat,
    });
    saveArchives(archives);
    toast("Conversation archived ✓", "success");
  }
  resetChat();
  drawChat();
  drawArchives();
}
function drawArchives() {
  const el = $("#chat-archives");
  if (!el) return;
  const archives = loadArchives();
  if (!archives.length) {
    el.innerHTML = `<div class="empty-state" style="padding:16px;">No archives. "+ New" archives the current conversation and starts a new one.</div>`;
    return;
  }
  el.innerHTML = archives.map((a, i) => `
    <div class="deposit-row">
      <div style="min-width:0;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title)}</div>
        <div class="when">${new Date(a.at).toLocaleDateString("en-US")} · ${a.messages.length} messages</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="filter-chip" data-arch-open="${i}">Resume</button>
        <button class="filter-chip" data-arch-del="${i}" style="color:var(--negative);">✕</button>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-arch-open]").forEach(b =>
    b.addEventListener("click", () => {
      const archives2 = loadArchives();
      const a = archives2[+b.dataset.archOpen];
      if (!a) return;
      // current conversation is archived before resuming the old one
      if (State.chat.some(m => m.role === "user")) newConversation();
      const idx = loadArchives().findIndex(x => x.at === a.at);
      const list = loadArchives();
      if (idx >= 0) list.splice(idx, 1);
      saveArchives(list);
      State.chat = a.messages;
      drawChat();
      drawArchives();
    }));
  el.querySelectorAll("[data-arch-del]").forEach(b =>
    b.addEventListener("click", async () => {
      const ok = await confirmModal({ title: "Delete archive", body: "This archived conversation will be permanently deleted.", confirmText: "Delete" });
      if (!ok) return;
      const list = loadArchives();
      list.splice(+b.dataset.archDel, 1);
      saveArchives(list);
      drawArchives();
    }));
}

function drawChat(typing = false) {
  const thread = $("#chat-thread");
  if (!thread) return;
  thread.innerHTML = State.chat.map(m => `
    <div class="chat-msg ${m.role}">
      <div class="chat-avatar ${m.role}">${m.role === "assistant" ? "F" : esc((State.user.name || "?").slice(0, 2).toUpperCase())}</div>
      <div class="chat-bubble">${esc(m.content)}</div>
    </div>`).join("") + (typing ? `
    <div class="chat-msg assistant">
      <div class="chat-avatar assistant">F</div>
      <div class="chat-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>
    </div>` : "");
  thread.scrollTop = thread.scrollHeight;
}

async function sendChat() {
  const input = $("#chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  State.chat.push({ role: "user", content: msg });
  drawChat(true);
  $("#chat-send").disabled = true;
  try {
    const history = State.chat.slice(0, -1).slice(-8).map(m => ({ role: m.role, content: m.content }));
    const res = await API.post("/api/agent/chat", { message: msg, history });
    State.chat.push({ role: "assistant", content: res.reply });
  } catch (e) {
    State.chat.push({ role: "assistant", content: "Sorry, I couldn't answer. Please try again in a moment." });
  }
  $("#chat-send").disabled = false;
  drawChat();
}

/* ================================================================= RISK = */
const CONCEPTS = [
  {
    t: "Diversification", s: "Don't put all your eggs in one basket.",
    d: "Spread your capital across assets that don't react the same way to identical events: multiple sectors, multiple countries, multiple asset classes (stocks, bonds, ETFs…). This is the foundational idea of modern portfolio theory (Markowitz, 1952, Nobel Prize): by combining assets with low correlation, you achieve a better risk/reward balance than with any single asset. Concrete example: a 100% tech portfolio can lose 30% when the sector corrects; a portfolio of stocks + bonds + multiple sectors absorbs the same shock with a much smaller loss."
  },
  {
    t: "Concentration", s: "When a single sector or country weighs too heavily.",
    d: "If 70% of your portfolio depends on technology, a single bad news item in that sector impacts 70% of your capital. The same applies by country: investing only in one country exposes you to local economic shocks. The Dashboard gauge monitors your largest exposure and translates it into euros: above 50% in a sector, the agent alerts you and quantifies what a -20% correction would cost."
  },
  {
    t: "The 10% Rule", s: "A warning, not a restriction.",
    d: "Allocating more than 10% of your monthly income to investments reduces your safety margin for unforeseen events (repairs, job loss, medical expenses). Finwise does not forbid it: the server simply requires explicit confirmation (a checkbox) when you exceed this threshold — during onboarding, when editing your budget, or on a one-time deposit. The principle: the choice is yours, but it must be made knowingly."
  },
  {
    t: "Volatility", s: "The amplitude of an asset's price swings.",
    d: "A government bond moves ±0.2% per day, a large-cap stock ±1-3%, a crypto-asset ±5-10%. The higher the volatility, the more severe short-term gains AND losses can be — and the longer time horizon you need to smooth out the dips. Key point: a diversified portfolio has lower volatility than the average of its individual components because declines in some are cushioned by others."
  },
  {
    t: "Compound Interest", s: "Earning interest on your interest.",
    d: "When your gains are reinvested, they generate their own gains: growth becomes exponential. €100 per month at 5%/year = €24,000 deposited in 20 years, but ~€41,000 in total final capital. Einstein reportedly called this 'the eighth wonder of the world.' The two levers: start early (time does most of the work) and keep compounding uninterrupted. Test your own numbers with the projector below."
  },
  {
    t: "Stocks, ETFs, Bonds, Crypto", s: "Major asset classes.",
    d: "Stock: an ownership share in a company — high potential return, high volatility. ETF: a basket that tracks an index (e.g., MSCI World = ~1,500 companies) — instant diversification in a single purchase, with very low fees. Bond: a loan to a government or corporation in exchange for regular interest (the coupon) — low volatility, acts as a portfolio cushion. Crypto-asset: highly volatile, not backed by corporate revenues — common rule: no more than 5-10% of your portfolio. You can buy each of these classes in the Invest tab."
  },
  {
    t: "Life Insurance & Automated Savings", s: "Deposit monthly, project over 20 years.",
    d: "Life insurance is an investment wrapper: inside, you choose between guaranteed euro funds (~2.5-3%/year) and unit-linked assets (ETFs, stocks… non-guaranteed). Its real strength comes from automated deposits: €100-200 deducted each month, compounded over 15-20 years with favorable tax treatment after 8 years. A basic savings account remains emergency savings: guaranteed and liquid, but capped. The projector below simulates this exact monthly deposit scenario."
  },
  {
    t: "Risk of Capital Loss", s: "No guarantees in financial markets.",
    d: "Unlike a regulated bank savings account, a stock portfolio offers no guarantee: its value can fall — and remain for a long time — below your initial investment. Historically, stock markets have experienced drops of -30 to -50% (2000, 2008, 2020) before recovering, sometimes taking several years. This is why horizon matters: money needed within 2 years → secure savings; 8 years and beyond → stocks have historically always come out ahead over such durations."
  },
];

const GLOSSARY = [
  { q: "Price / Quote", a: "The current price at which an asset trades, continuously set by supply and demand. On stock pages (like Yahoo Finance): 'Previous close' = previous day's closing price, 'Open' = first price of the trading session." },
  { q: "Market Capitalization", a: "The total market value of a company: stock price × total number of shares. Referred to as large caps (> €10B), mid caps, and small caps — the smaller the capitalization, the more volatile and less liquid the stock generally is." },
  { q: "P/E Ratio (Price-to-Earnings)", a: "Stock price ÷ earnings per share: the number of years of profits you are 'paying' for. P/E < 10: undervalued or troubled; 15-25: average; > 30: market expects strong growth. Always compare within the same sector." },
  { q: "EPS (Earnings Per Share)", a: "Net income divided by the number of outstanding shares. It is the 'E' in P/E ratio, and the core metric analysts scrutinize during quarterly earnings releases." },
  { q: "Dividend & Yield", a: "The portion of profits distributed to shareholders. Yield = annual dividend ÷ stock price (a €3 dividend on a €100 stock = 3%). Be cautious if a yield looks too good to be true: it often hides a collapsing stock price." },
  { q: "Volume", a: "The total number of shares traded over a given period. High volume = high liquidity = more reliable pricing and easier resale." },
  { q: "Spread", a: "The difference between the highest buy price (bid) and the lowest sell price (ask). The tighter the spread, the higher the liquidity. On small caps or exotic cryptos, the spread alone can cost several percent." },
  { q: "Beta", a: "A measure of a stock's volatility relative to the overall market. Beta = 1: moves with the market; > 1: amplifies movements (tech, luxury); < 1: buffers movements (healthcare, consumer staples)." },
  { q: "Market Order vs. Limit Order", a: "Market order: executed immediately at the best available current price. Limit order: executed only if the price reaches your set target — you control price, not execution. This simulator executes market orders at server price." },
  { q: "Bond, Coupon, Maturity", a: "A bond is a loan to a government or corporation. The coupon is the regular interest paid; maturity is the payback date for the principal. Bond yields rise when bond prices fall, and vice versa." },
  { q: "Government Bonds (OAT / Bund / Treasury)", a: "Benchmark government bonds: OAT for France, Bund for Germany, Treasury for the US. Their 10-year yield serves as the 'risk-free' reference rate to value all other assets." },
  { q: "ETF / Index Tracker", a: "A fund traded on an exchange that tracks an index (MSCI World, S&P 500, Nasdaq…). Provides instant diversification at very low expense ratios (often TER < 0.3%/year). The core building block for beginner investors." },
  { q: "Crypto-Asset & Stablecoin", a: "A digital asset on a blockchain (Bitcoin, Ethereum…). Highly volatile and not backed by corporate revenues. A stablecoin is a crypto designed to track a fiat currency (1 USDT ≈ $1) — useful for transfers, not for yield." },
  { q: "Compound Interest", a: "Interest generating its own interest whenever it is reinvested. The exponential force of long-term investing: at 7%/year, capital doubles approximately every 10 years (Rule of 72: 72 ÷ rate = years to double)." },
  { q: "Inflation & Real Return", a: "The general increase in prices that erodes purchasing power. Real Return = Nominal Return − Inflation. A savings account yielding 2% with 3% inflation loses 1% of purchasing power per year." },
  { q: "Liquidity", a: "How easily an asset can be converted into cash quickly without losing value. Major index stocks sell in a second; real estate takes months. Always ask: 'At what price can I realistically get this money back tomorrow?'" },
  { q: "Account Types (PEA / Brokerage / Life Insurance)", a: "Common tax wrappers: PEA (European stocks, tax exempt after 5 years), Brokerage/CTO (unrestricted access, flat tax), Life insurance (tax advantages after 8 years, flexible automated plans). Choosing the right wrapper is as crucial as selecting the right assets." },
  { q: "DCA (Dollar-Cost Averaging)", a: "Investing a fixed amount of money at regular intervals regardless of market performance. Smooths out entry prices and removes the stress of timing the market. This is the default mode for your plan in the Budget tab." },
];

function projectionSeries(monthly, ratePct, years) {
  const r = ratePct / 100 / 12;
  let capital = 0;
  const pts = [{ y: 0, versed: 0, total: 0 }];
  for (let m = 1; m <= years * 12; m++) {
    capital = capital * (1 + r) + monthly;
    if (m % 12 === 0) pts.push({ y: m / 12, versed: monthly * m, total: capital });
  }
  return pts;
}

function projectorSvg(pts) {
  const W = 560, H = 200, PADL = 8, PADB = 18;
  const maxV = Math.max(...pts.map(p => p.total), 1);
  const x = i => PADL + (i / (pts.length - 1)) * (W - PADL * 2);
  const y = v => (H - PADB) - (v / maxV) * (H - PADB - 8);
  const line = key => pts.map((p, i) => (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(p[key]).toFixed(1)).join(" ");
  const area = key => line(key) + ` L${x(pts.length - 1)},${H - PADB} L${x(0)},${H - PADB} Z`;
  const labels = pts.filter((p, i) => i > 0 && (pts.length <= 11 || i % Math.ceil(pts.length / 8) === 0 || i === pts.length - 1))
    .map(p => {
      const i = pts.indexOf(p);
      const isLast = i === pts.length - 1;
      // The rightmost label sits at the edge of the viewBox; centering it ("middle")
      // pushes half its width past x=W and the SVG clips it, cutting off the final
      // character (e.g. "20yrs" rendering as "20yr"). Anchor it to "end" instead so
      // it grows leftward from the point, staying fully inside the viewBox.
      return `<text x="${x(i)}" y="${H - 4}" text-anchor="${isLast ? "end" : "middle"}" font-size="9.5" fill="#6b6d80">${p.y} yr${p.y > 1 ? "s" : ""}</text>`;
    }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">
    <path d="${area("total")}" fill="#e3b567" opacity="0.18"/>
    <path d="${area("versed")}" fill="#6fb8b0" opacity="0.30"/>
    <path d="${line("total")}" fill="none" stroke="#e3b567" stroke-width="2"/>
    <path d="${line("versed")}" fill="none" stroke="#6fb8b0" stroke-width="2" stroke-dasharray="4 3"/>
    ${labels}
  </svg>`;
}

function riskPortfolioAlertHtml(top) {
  if (!top) return "";
  return `<div class="budget-alert" style="margin:0 0 20px;">${icon.warn}<div>Illustrated with <b>your</b> portfolio: your largest exposure is <b>${esc(SECTOR_EN[top.label] || top.label)}</b> at <b>${top.pct} %</b> (${fmtEur(top.value)}). A -20% correction in this allocation would cost you roughly <b>${fmtEur(top.value * 0.2)}</b>.</div></div>`;
}

async function renderRisk() {
  const a = State.insights;
  const top = a && a.sectorBreakdown && a.sectorBreakdown[0];
  const proj = { monthly: 150, rate: 5, years: 20 };

  $("#view-root").innerHTML = `<div class="view">
    <div class="risk-intro"><p>Before investing a single real euro, understand what the numbers on your dashboard mean. Click each card for details, project your monthly contributions with the compound interest simulator, and consult the glossary below for terms you will see on stock listings (Yahoo Finance, Bloomberg…).</p></div>

    <div id="risk-portfolio-alert">${riskPortfolioAlertHtml(top)}</div>

    <div class="section-label">Concepts to Know — click for details</div>
    <div class="concept-grid">
      ${CONCEPTS.map((c, i) => `
      <div class="concept-card clickable" data-concept="${i}">
        <div class="concept-icon">${i + 1}</div>
        <div class="concept-title">${c.t} <span class="chev">+</span></div>
        <div class="concept-text">${c.s}</div>
        <div class="concept-more">${c.d}</div>
      </div>`).join("")}
    </div>

    <div class="section-label">Compound Interest Projector — Monthly Contributions</div>
    <div class="card">
      <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">
        A typical long-term investment scenario: a fixed amount deposited every month, compounding year after year. The <b style="color:var(--teal)">blue</b> area = total deposits made; the <b style="color:var(--accent)">gold</b> area = your total portfolio value. The gap between them represents the total return generated.</p>
      <div class="field-row" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="field"><label>Monthly deposit: <span id="pj-m-val" class="mono">${proj.monthly} €</span></label>
          <input id="pj-m" class="budget-slider" type="range" min="10" max="1000" step="10" value="${proj.monthly}"></div>
        <div class="field"><label>Annual return: <span id="pj-r-val" class="mono">${proj.rate} %</span></label>
          <input id="pj-r" class="budget-slider" type="range" min="0" max="12" step="0.5" value="${proj.rate}"></div>
        <div class="field"><label>Duration: <span id="pj-y-val" class="mono">${proj.years} years</span></label>
          <input id="pj-y" class="budget-slider" type="range" min="1" max="40" step="1" value="${proj.years}"></div>
      </div>
      <div id="pj-chart"></div>
      <div class="budget-stat-row" style="border-bottom:none;margin-top:10px;padding-bottom:0;">
        <div><div class="tiny-label">Total Deposited</div><div class="mono budget-figure" style="color:var(--teal);" id="pj-versed">—</div></div>
        <div><div class="tiny-label">Total Return</div><div class="mono budget-figure" style="color:var(--accent);" id="pj-interest">—</div></div>
        <div><div class="tiny-label">Final Capital</div><div class="mono budget-figure" id="pj-total">—</div></div>
      </div>
      <div class="hint" style="margin-top:10px;color:var(--text-tertiary);font-size:11px;">Educational benchmarks: High-yield savings ~2-3%, government bonds ~3-4%, global equities ~10%/year historical average — without guarantee and subject to significant yearly fluctuations.</div>
    </div>

    <div class="section-label">Stock Listings Glossary</div>
    <div class="card">
      ${GLOSSARY.map((g, i) => `
      <div class="glossary-item" data-gl="${i}">
        <div class="glossary-q"><span>${g.q}</span><span class="chev">+</span></div>
        <div class="glossary-a">${g.a}</div>
      </div>`).join("")}
    </div>

    <div class="risk-disclaimer"><b>Reminder:</b> Finwise is an educational simulator. Scenarios, projections, alerts, and suggestions displayed here and throughout the application do not constitute actual investment advice. Past performance is no guarantee of future results.</div>
  </div>`;

  /* clickable cards + glossary (accordions, in-place updates) */
  document.querySelectorAll("[data-concept]").forEach(card =>
    card.addEventListener("click", () => card.classList.toggle("open")));
  document.querySelectorAll("[data-gl]").forEach(item =>
    item.addEventListener("click", () => item.classList.toggle("open")));

  /* projector: recalculate in place on slider input */
  const redraw = () => {
    const pts = projectionSeries(proj.monthly, proj.rate, proj.years);
    const last = pts[pts.length - 1];
    $("#pj-chart").innerHTML = projectorSvg(pts);
    $("#pj-versed").textContent = fmtEur(last.versed);
    $("#pj-interest").textContent = fmtEur(Math.max(0, last.total - last.versed));
    $("#pj-total").textContent = fmtEur(last.total);
  };
  const bindSlider = (id, key, suffix) => {
    const s = $(id);
    s.addEventListener("input", () => {
      proj[key] = +s.value;
      $(id + "-val").textContent = s.value + suffix;
      redraw();
    });
  };
  bindSlider("#pj-m", "monthly", " €");
  bindSlider("#pj-r", "rate", " %");
  bindSlider("#pj-y", "years", " years");
  redraw();

  // Insights are only otherwise fetched from the AI Agent tab. If the user lands
  // here first, or holdings just changed (State.insights was invalidated), fetch
  // now and patch the alert in-place rather than showing a stale/empty box.
  if (!State.insights) {
    try {
      State.insights = await API.get("/api/agent/insights");
      const freshTop = State.insights.sectorBreakdown && State.insights.sectorBreakdown[0];
      const host = $("#risk-portfolio-alert");
      if (host && State.view === "risk") host.innerHTML = riskPortfolioAlertHtml(freshTop);
    } catch (e) { /* non-blocking */ }
  }
}

/* ============================================================== ACCOUNT == */
function renderAccount() {
  const u = State.user;
  $("#view-root").innerHTML = `<div class="view">
    <div class="budget-grid">
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">Profile</div>
          <div class="field"><label>First Name</label><input id="ac-name" type="text" value="${esc(u.name)}" maxlength="60"></div>
          <div class="field"><label>Email</label><input id="ac-email" type="email" value="${esc(u.email)}"></div>
          <div class="hint" style="margin-bottom:12px;">Account created on ${esc((u.created_at || "").slice(0, 10))}${u.role === "admin" ? ' · <span class="tag warning">Administrator</span>' : ""}</div>
          <button class="btn-primary" id="ac-save-profile">Save Profile</button>
        </div>
        <div class="card">
          <div class="card-title">Password</div>
          <div class="field"><label>Current Password</label><input id="ac-cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label>New Password</label><input id="ac-new" type="password" autocomplete="new-password"><div class="hint">8 characters minimum.</div></div>
          <button class="btn-primary" id="ac-save-pass">Change Password</button>
        </div>
      </div>
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">My Data</div>
          <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.65;">
            Your data is stored server-side in a SQL database (user, budget, DCA plan, deposits, positions, transactions). Passwords are never stored in plaintext — only a bcrypt hash is kept. The session relies on an httpOnly cookie inaccessible to JavaScript.</p>
          <div class="budget-stat-row" style="margin-top:14px;border-bottom:none;padding-bottom:0;">
            <div><div class="tiny-label">Positions</div><div class="mono budget-figure">${State.portfolio ? State.portfolio.positions.length : 0}</div></div>
            <div><div class="tiny-label">Transactions</div><div class="mono budget-figure">${State.portfolio ? State.portfolio.transactions.length : 0}</div></div>
            <div><div class="tiny-label">Deposits</div><div class="mono budget-figure">${State.deposits.length}</div></div>
          </div>
        </div>
        <div class="card" style="border-color:#e0645a55;">
          <div class="card-title" style="color:var(--negative);">Danger Zone</div>
          <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
            Deleting your account permanently erases all your data: budget, plan, deposits, positions, and history. This action is irreversible.</p>
          <div class="field"><label>Confirm your password</label><input id="ac-del-pass" type="password" autocomplete="current-password"></div>
          <button class="btn-ghost" id="ac-delete" style="border-color:#e0645a55;color:var(--negative);">Delete My Account</button>
        </div>
      </div>
    </div>
  </div>`;

  $("#ac-save-profile").addEventListener("click", async () => {
    try {
      const res = await API.put("/api/account/profile", {
        name: $("#ac-name").value.trim(), email: $("#ac-email").value.trim(),
      });
      State.user = res.user;
      toast("Profile updated ✓", "success");
      renderAccount();
    } catch (e) {
      const map = { EMAIL_TAKEN: "This email is already in use.", INVALID_EMAIL: "Invalid email.", INVALID_NAME: "Invalid first name." };
      toast(map[e.code] || "Error updating profile.", "error");
    }
  });

  $("#ac-save-pass").addEventListener("click", async () => {
    try {
      await API.put("/api/account/password", {
        currentPassword: $("#ac-cur").value, newPassword: $("#ac-new").value,
      });
      $("#ac-cur").value = ""; $("#ac-new").value = "";
      toast("Password changed ✓", "success");
    } catch (e) {
      const map = { WRONG_PASSWORD: "Incorrect current password.", PASSWORD_TOO_SHORT: "8 characters minimum." };
      toast(map[e.code] || "Error changing password.", "error");
    }
  });

  $("#ac-delete").addEventListener("click", async () => {
    const password = $("#ac-del-pass").value;
    if (!password) { toast("Confirm your password.", "error"); return; }
    const ok = await confirmModal({
      title: "Permanently Delete Account",
      body: `All data for <b>${esc(State.user.email)}</b> will be erased: budget, DCA plan, deposits, positions, transactions.`,
      warning: "This action is <b>irreversible</b>.",
      checkLabel: "I understand that all my data will be permanently deleted.",
      confirmText: "Delete My Account",
    });
    if (!ok) return;
    try {
      await API.request("DELETE", "/api/account", { password });
      stopPolling();
      State.user = null; State.portfolio = null; State.chat = [];
      toast("Account deleted.", "success");
      renderAuth("login");
    } catch (e) {
      toast(e.code === "WRONG_PASSWORD" ? "Incorrect password." : "Error deleting account.", "error");
    }
  });
}

/* =============================================================== ADMIN == */
async function renderAdmin() {
  $("#view-root").innerHTML = `<div class="view"><div class="card">
    <div class="card-title">Users</div>
    <div id="admin-users"><div class="empty-state">Loading…</div></div>
  </div></div>`;
  try {
    const res = await API.get("/api/admin/users");
    drawAdminUsers(res.users);
  } catch (e) {
    $("#admin-users").innerHTML = `<div class="empty-state"><b>Access denied.</b> This page is reserved for administrators.</div>`;
  }
}

function drawAdminUsers(users) {
  const el = $("#admin-users");
  if (!el) return;
  el.innerHTML = `
    <table class="holdings-table">
      <thead><tr><th>#</th><th>User</th><th>Role</th><th>Cash</th><th>Deposited</th><th>Positions</th><th>Orders</th><th>Created On</th><th></th></tr></thead>
      <tbody>
        ${users.map(u => `
        <tr>
          <td class="mono">${u.id}</td>
          <td><div class="stock-cell">
            <div class="avatar" style="width:28px;height:28px;font-size:11px;">${esc((u.name || "?").slice(0, 2).toUpperCase())}</div>
            <div><div class="stock-name">${esc(u.name)}</div><div class="stock-ticker">${esc(u.email)}</div></div>
          </div></td>
          <td>${u.role === "admin" ? '<span class="tag warning">admin</span>' : '<span class="tag" style="background:var(--surface-2);color:var(--text-secondary);">user</span>'}</td>
          <td class="mono">${fmtEur(u.cash, 2)}</td>
          <td class="mono">${fmtEur(u.deposited)}</td>
          <td class="mono">${u.positions}</td>
          <td class="mono">${u.trades}</td>
          <td style="font-size:12px;color:var(--text-secondary);">${esc((u.created_at || "").slice(0, 10))}</td>
          <td>${u.id !== State.user.id && u.role !== "admin"
      ? `<button class="filter-chip" data-admin-del="${u.id}" style="color:var(--negative);">Delete</button>` : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <div class="hint" style="margin-top:12px;color:var(--text-tertiary);font-size:11px;">
      ${users.length} account(s). The first account created is an administrator; another email can be promoted via the ADMIN_EMAIL environment variable. Deleting a user cascades to erase all their data (budget, deposits, positions, transactions).</div>`;

  el.querySelectorAll("[data-admin-del]").forEach(b =>
    b.addEventListener("click", async () => {
      const id = +b.dataset.adminDel;
      const u = users.find(x => x.id === id);
      const ok = await confirmModal({
        title: "Delete this user",
        body: `The account <b>${esc(u.email)}</b> and all associated data (budget, ${u.positions} position(s), ${u.trades} order(s), ${fmtEur(u.deposited)} deposited) will be permanently deleted.`,
        warning: "This action is <b>irreversible</b>.",
        checkLabel: "I confirm the permanent deletion of this account.",
        confirmText: "Delete",
      });
      if (!ok) return;
      try {
        const res = await API.request("DELETE", "/api/admin/users/" + id);
        toast("User deleted ✓", "success");
        drawAdminUsers(res.users);
      } catch (e) {
        toast("Unable to delete user.", "error");
      }
    }));
}

/* ================================================================= BOOT = */
window.App = {
  onUnauthorized() {
    stopPolling();
    State.user = null;
    renderAuth("login");
  },
};

(async function boot() {
  try {
    const me = await API.get("/api/auth/me");
    State.user = me.user;
    State.budget = me.budget;
    if (!State.user.onboarded) renderOnboarding();
    else await enterApp();
  } catch (e) {
    renderLanding();
  }
})();