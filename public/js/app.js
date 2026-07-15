/* ============================================================================
   FINWISE — frontend SPA (vanilla JS, CSP-safe : aucun handler inline)
   - Le budget se met à jour EN PLACE (plus de "saut" de page au clic/slider)
   - La recherche d'actions est branchée sur /api/market/search (debounce)
   - Les cours sont pollés toutes les 15s et patchés dans le DOM (tick-flash)
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
  newsFilter: "all",
  newsItems: [],
  chat: [],                 // { role:'user'|'assistant', content }
  insights: null,
  pollTimer: null,
};

const SECTOR_COLORS = {
  Technology: "#e3b567", Healthcare: "#6fb8b0", Finance: "#8f8fd9",
  Energy: "#7fb88f", Consumer: "#d98fb8", Industrials: "#c9a06a", Other: "#6b6d80",
};
const SECTOR_FR = {
  Technology: "Technologie", Healthcare: "Santé", Finance: "Finance",
  Energy: "Énergie", Consumer: "Consommation", Industrials: "Industrie",
  Obligations: "Obligations", Crypto: "Crypto", "Diversifié": "Diversifié", Other: "Autre",
};
const CLASS_FR = { stock: "Action", etf: "ETF", crypto: "Crypto", bond: "Obligation" };
const CLASS_COLORS = { stock: "#e3b567", etf: "#6fb8b0", crypto: "#8f8fd9", bond: "#7fb88f" };
const classTag = cls => cls ? `<span class="tag" style="background:${(CLASS_COLORS[cls] || "#6b6d80")}22;color:${CLASS_COLORS[cls] || "#6b6d80"};">${CLASS_FR[cls] || cls}</span>` : "";

/* -------------------------------------------------------------- helpers -- */
const $ = sel => document.querySelector(sel);
const root = () => $("#root");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmtEur = (n, d = 0) =>
  (n ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }) + " €";
const fmtPct = n => (n >= 0 ? "+" : "") + (n ?? 0).toFixed(1) + " %";
/* quantités fractionnaires : jusqu'à 6 décimales, zéros superflus retirés */
const fmtQty = n => (+n).toLocaleString("fr-FR", { maximumFractionDigits: 6 });
function timeAgo(ts) {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return Math.round(s / 3600) + " h";
  return Math.round(s / 86400) + " j";
}

let toastTimer = null;
function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

/* Modale de confirmation — retourne une Promise<boolean>. Avec checkLabel,
   le bouton Confirmer reste désactivé tant que la case n'est pas cochée. */
function confirmModal({ title, body, warning = "", checkLabel = "", confirmText = "Confirmer" }) {
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

/* Sankey "façon Finary" : Salaire → Budget → catégories. */
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
  const left = { x: cols[0], y: PAD, h: usable, color: "#8f8fd9", label: "Salaire", value: income };
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
};

/* ============================================================== AUTH ==== */
function renderAuth(mode = "login") {
  root().innerHTML = `
  <div class="auth-screen">
    <div class="auth-card">
      <div class="auth-brand">
        <div class="brand-mark">F</div>
        <div>
          <div class="auth-brand-name">Finwise</div>
          <div class="auth-brand-tag">Simulateur pédagogique</div>
        </div>
      </div>
      <div class="auth-title">${mode === "login" ? "Connexion" : "Créer un compte"}</div>
      <div class="auth-sub">Portefeuille 100 % virtuel : apprenez à investir sans risquer un centime.</div>
      <div class="form-error" id="auth-error"></div>
      ${mode === "register" ? `
      <div class="field"><label>Prénom</label><input id="f-name" type="text" autocomplete="name" placeholder="Clara"></div>` : ""}
      <div class="field"><label>E-mail</label><input id="f-email" type="email" autocomplete="email" placeholder="vous@exemple.fr"></div>
      <div class="field"><label>Mot de passe</label><input id="f-pass" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}">
        ${mode === "register" ? `<div class="hint">8 caractères minimum.</div>` : ""}</div>
      <button class="btn-primary" id="auth-submit">${mode === "login" ? "Se connecter" : "Créer mon compte"}</button>
      <div class="auth-switch">
        ${mode === "login" ? "Pas encore de compte ?" : "Déjà inscrit ?"}
        <button id="auth-switch-btn">${mode === "login" ? "S'inscrire" : "Se connecter"}</button>
      </div>
    </div>
  </div>`;

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
        INVALID_CREDENTIALS: "E-mail ou mot de passe incorrect.",
        EMAIL_TAKEN: "Cet e-mail est déjà utilisé.",
        PASSWORD_TOO_SHORT: "Le mot de passe doit contenir au moins 8 caractères.",
        INVALID_EMAIL: "Adresse e-mail invalide.",
        INVALID_NAME: "Prénom invalide.",
      };
      errEl.textContent = map[e.code] || "Une erreur est survenue. Réessayez.";
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
          <div><div class="auth-brand-name">Bienvenue, ${esc(State.user.name)}</div>
          <div class="auth-brand-tag">Configuration du budget</div></div>
        </div>
        <div class="onboard-steps">
          <div class="onboard-step done"></div>
          <div class="onboard-step ${step >= 2 ? "done" : ""}"></div>
        </div>
        <div class="form-error" id="ob-error"></div>
        ${step === 1 ? `
        <div class="auth-title">Votre budget mensuel</div>
        <div class="auth-sub">Comme sur Finary : on part de votre salaire, on soustrait vos dépenses fixes, et on voit ce qui peut aller vers l'investissement.</div>
        <div class="field"><label>Salaire net mensuel (€)</label><input id="ob-income" type="number" min="0" value="${data.monthlyIncome}"></div>
        <div class="field-row">
          <div class="field"><label>Logement (loyer + charges)</label><input id="ob-housing" type="number" min="0" value="${data.housing}"></div>
          <div class="field"><label>Vie quotidienne</label><input id="ob-daily" type="number" min="0" value="${data.dailyLife}"></div>
        </div>
        <div class="field"><label>Abonnements</label><input id="ob-subs" type="number" min="0" value="${data.subscriptions}"></div>
        <button class="btn-primary" id="ob-next">Continuer</button>
        ` : `
        <div class="auth-title">Combien investir chaque mois ?</div>
        <div class="auth-sub">C'est vous qui décidez du pourcentage. Au-delà de <b>10 %</b> de vos revenus, nous vous demanderons une confirmation explicite — simple prudence, pas une interdiction.</div>
        <div class="field">
          <label>Part du salaire à investir</label>
          <input id="ob-pct" class="budget-slider" type="range" min="0" max="40" step="1" value="${data.investPct}">
          <div class="budget-slider-readout">
            <span class="mono" style="font-size:22px;" id="ob-pct-val">${data.investPct} %</span>
            <span style="color:var(--text-tertiary); font-size:12px;" id="ob-pct-eur">≈ ${fmtEur(monthly)} / mois</span>
          </div>
          <div class="budget-alert" id="ob-alert" style="display:${data.investPct > 10 ? "flex" : "none"};">
            ${icon.warn}<div>Vous dépassez le seuil de prudence de <b>10 %</b> de vos revenus. C'est votre choix — une confirmation vous sera demandée.</div>
          </div>
        </div>
        <div class="field">
          <label>Mode de versement</label>
          <div class="mode-toggle">
            <button type="button" data-mode="dca" class="${data.dcaMode === "dca" ? "active" : ""}">DCA — tous les mois</button>
            <button type="button" data-mode="once" class="${data.dcaMode === "once" ? "active" : ""}">Versement unique</button>
          </div>
          <div class="hint">DCA (Dollar-Cost Averaging) : investir la même somme à intervalle régulier pour lisser le prix d'entrée.</div>
        </div>
        <label class="confirm-check">
          <input type="checkbox" id="ob-firstnow" ${data.firstDepositNow ? "checked" : ""}>
          <span>Effectuer le premier versement maintenant (${fmtEur(monthly)}) pour pouvoir passer mes premiers ordres virtuels.</span>
        </label>
        <button class="btn-primary" id="ob-finish">Terminer la configuration</button>
        <button class="btn-ghost" id="ob-back">Retour</button>
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
        if (data.monthlyIncome <= 0) { err.textContent = "Indiquez un salaire mensuel valide."; err.classList.add("visible"); return; }
        if (data.housing + data.dailyLife + data.subscriptions > data.monthlyIncome) {
          err.textContent = "Vos dépenses fixes dépassent votre salaire — vérifiez les montants."; err.classList.add("visible"); return;
        }
        step = 2; draw();
      });
    } else {
      const slider = $("#ob-pct");
      slider.addEventListener("input", () => {          // mise à jour EN PLACE
        data.investPct = +slider.value;
        $("#ob-pct-val").textContent = data.investPct + " %";
        $("#ob-pct-eur").textContent = "≈ " + fmtEur(data.monthlyIncome * data.investPct / 100) + " / mois";
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
          title: "Au-delà du seuil de prudence",
          body: `Vous avez choisi d'investir <b>${data.investPct} %</b> de vos revenus mensuels, soit <b>${fmtEur(data.monthlyIncome * data.investPct / 100)}</b> par mois.`,
          warning: `Le seuil de prudence est fixé à <b>10 %</b>. Investir davantage réduit votre marge de sécurité en cas d'imprévu. La décision vous appartient.`,
          checkLabel: "Je comprends le risque et je confirme ce pourcentage.",
          confirmText: "Confirmer " + data.investPct + " %",
        });
        if (ok) return submitOnboarding(true);
        return;
      }
      State.user = res.user;
      State.budget = res.budget;
      toast("Budget configuré ✓", "success");
      await enterApp();
    } catch (e) {
      const err = $("#ob-error");
      err.textContent = e.code === "COSTS_EXCEED_INCOME"
        ? "Vos dépenses fixes dépassent votre salaire."
        : "Erreur lors de l'enregistrement. Réessayez.";
      err.classList.add("visible");
    }
  };

  draw();
}

/* ============================================================ APP SHELL = */
const VIEWS = [
  { id: "dashboard", label: "Dashboard", eyebrow: "Vue d'ensemble", title: "Dashboard", subtitle: "Votre patrimoine simulé — secteur par secteur, pays par pays.", icon: icon.home },
  { id: "budget", label: "Budget", eyebrow: "Revenus & versements", title: "Budget", subtitle: "D'où vient l'argent, où il va — et ce que vous investissez.", icon: icon.budget },
  { id: "trading", label: "Investir", eyebrow: "Passer un ordre", title: "Trading", subtitle: "Achetez et vendez sur des cours réels, sans risquer un centime.", icon: icon.trade },
  { id: "news", label: "Actualités", eyebrow: "Flux filtré", title: "Actualités", subtitle: "Uniquement les nouvelles qui concernent vos positions.", icon: icon.news },
  { id: "agent", label: "Agent IA", eyebrow: "Assistant", title: "Agent IA", subtitle: "Votre copilote qui traduit le risque en euros.", icon: icon.agent },
  { id: "risk", label: "Risques", eyebrow: "Avant d'investir", title: "Comprendre les risques", subtitle: "Les concepts clés, illustrés avec votre propre portefeuille.", icon: icon.shield },
  { id: "account", label: "Mon compte", eyebrow: "Paramètres", title: "Mon compte", subtitle: "Profil, mot de passe et données personnelles.", icon: icon.user },
  { id: "admin", label: "Admin", eyebrow: "Administration", title: "Gestion des utilisateurs", subtitle: "Comptes, activité et suppression — réservé aux administrateurs.", icon: icon.admin, adminOnly: true },
];
const visibleViews = () => VIEWS.filter(v => !v.adminOnly || (State.user && State.user.role === "admin"));

async function enterApp() {
  root().innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" style="width:30px;height:30px;border-radius:9px;font-size:16px;">F</div>
        <div><div class="brand-name">Finwise</div><div class="brand-tag">Simulateur</div></div>
      </div>
      <nav class="nav" id="nav"></nav>
      <div class="sidebar-footer">
        <div class="disclaimer-pill"><b>Outil pédagogique.</b> Portefeuille virtuel — rien ici ne constitue un conseil en investissement réel.</div>
        <button class="logout-btn" id="logout-btn">Se déconnecter</button>
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
          <span class="demo-chip" id="demo-chip" style="display:none;">Données simulées</span>
          <div class="cash-chip">Liquidités · <b id="cash-chip-value">—</b></div>
          <div class="avatar" id="avatar-btn" style="cursor:pointer;" title="Mon compte">${esc((State.user.name || "?").slice(0, 2).toUpperCase())}</div>
        </div>
      </div>
      <div id="view-root"></div>
    </main>
  </div>`;

  $("#avatar-btn").addEventListener("click", () => navigate("account"));
  $("#logout-btn").addEventListener("click", async () => {
    await API.post("/api/auth/logout");
    stopPolling();
    State.user = null;
    renderAuth("login");
  });

  try {
    const st = await API.get("/api/market/status");
    State.demoMode = !!st.demoMode;
    $("#demo-chip").style.display = State.demoMode ? "inline-block" : "none";
  } catch (e) { /* non bloquant */ }

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
function stopPolling() { clearInterval(State.pollTimer); State.pollTimer = null; }

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
    /* patch du DOM en place — pas de re-render : pas de scroll perdu */
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
  } catch (e) { /* le prochain tick réessaiera */ }
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
    label: by === "sector" ? (SECTOR_FR[key] || key) : key,
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
          <div class="hero-label">Valeur totale du portefeuille</div>
          <div class="hero-number"><span data-live-total>${fmtEur(pf.total)}</span> <small>virtuel</small></div>
          <div class="hero-sub">Total versé : ${fmtEur(deposited)} · liquidités disponibles : ${fmtEur(pf.cash, 2)}</div>
        </div>
        <div class="empty-state" style="display:flex;flex-direction:column;justify-content:center;gap:14px;">
          <div><b>Aucune position pour l'instant.</b><br>
          Alimentez votre compte dans <b>Budget</b>, puis passez votre premier ordre.</div>
          <button class="btn-primary" id="dash-go-invest" style="max-width:260px;margin:0 auto;">+ Ajouter une position</button>
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
        <div class="hero-label">Valeur totale du portefeuille</div>
        <div class="hero-number"><span data-live-total>${fmtEur(pf.total)}</span> <small>virtuel</small></div>
        <div class="hero-delta">
          <span class="tag ${delta >= 0 ? "positive" : "negative"}">${fmtPct(deltaPct)}</span>
          <span class="mono" style="color:var(--text-secondary)">${delta >= 0 ? "+" : ""}${fmtEur(delta)} vs total versé</span>
        </div>
        <div class="hero-sub"><span class="live-dot"></span>Cours actualisés toutes les 15 s · Total versé : ${fmtEur(deposited)}</div>
      </div>
      <div class="card gauge-card" style="min-height:auto;">
        <div class="card-title">Investi vs liquidités</div>
        <div class="budget-stat-row">
          <div><div class="tiny-label">Investi</div><div class="mono budget-figure" data-live-invested>${fmtEur(pf.invested)}</div></div>
          <div><div class="tiny-label">Liquidités</div><div class="mono budget-figure">${fmtEur(pf.cash, 2)}</div></div>
          <div><div class="tiny-label">Positions</div><div class="mono budget-figure">${pf.positions.length}</div></div>
        </div>
        <div style="flex:1; min-height:120px;">${sparklineSvg(spark, { w: 500, h: 130, stroke: delta >= 0 ? "#7fb88f" : "#e0645a", fill: true, cls: "chart-svg" })}</div>
      </div>
    </div>

    <div class="risk-gauge-row">
      <div class="card gauge-card">
        <div class="card-title">${State.breakdownView === "country" ? "Exposition géographique" : "Exposition sectorielle"}</div>
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
            <div class="warning-head">${icon.warn}<span class="warning-title">Concentration élevée</span></div>
            <div class="warning-figure">−${fmtEur(riskEuros)}</div>
            <div class="warning-text">Perte estimée si cette exposition corrige de <b>20 %</b> — voilà ce qu'un pourcentage veut dire en euros.</div>
          </div>` : `
          <div class="warning-half ok">
            <div class="warning-head">${icon.check}<span class="warning-title">Allocation équilibrée</span></div>
            <div class="warning-text">Aucune alerte de concentration pour le moment. Gardez un œil sur cette jauge au fil de vos ordres.</div>
          </div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Répartition ${State.breakdownView === "country" ? "par pays" : "par secteur"}
          <div class="segmented">
            <button data-bd="sector" class="${State.breakdownView === "sector" ? "active" : ""}">Secteur</button>
            <button data-bd="country" class="${State.breakdownView === "country" ? "active" : ""}">Pays</button>
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
        <button class="filter-chip" id="dash-add-pos">+ Ajouter une position</button>
      </div>
      <table class="holdings-table">
        <thead><tr><th>Actif</th><th>Secteur</th><th>Pays</th><th>Cours</th><th>Var.</th><th>Tendance</th><th>Valeur</th><th>+/- value</th></tr></thead>
        <tbody>
          ${pf.positions.map(h => `
          <tr>
            <td><div class="stock-cell">
              <div class="stock-logo">${esc(h.symbol.slice(0, 2))}</div>
              <div><div class="stock-name">${esc(h.name || h.symbol)}</div>
              <div class="stock-ticker">${esc(h.symbol)} · ${fmtQty(h.shares)} titre(s)</div></div>
            </div></td>
            <td><span class="tag" style="background:${(SECTOR_COLORS[h.sector] || "#6b6d80")}22;color:${SECTOR_COLORS[h.sector] || "#6b6d80"};">${esc(SECTOR_FR[h.sector] || h.sector || "—")}</span></td>
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
    $("#view-root").innerHTML = `<div class="view"><div class="empty-state"><b>Budget non configuré.</b></div></div>`;
    return;
  }
  const local = { investPct: b.invest_pct, dcaMode: b.dca_mode }; // état local du formulaire
  const income = b.monthly_income;
  const monthlyOf = pct => income * pct / 100;
  const rest = () => Math.max(0, income - b.housing - b.daily_life - b.subscriptions - monthlyOf(local.investPct));

  const sankey = () => sankeySvg(income, [
    { label: "Investissements mensuels", value: monthlyOf(local.investPct), color: "#e3b567" },
    { label: "Logement", value: b.housing, color: "#8f8fd9" },
    { label: "Vie quotidienne", value: b.daily_life, color: "#6fb8b0" },
    { label: "Abonnements", value: b.subscriptions, color: "#7fb88f" },
    { label: "Reste à vivre", value: rest(), color: "#9a9cae" },
  ]);

  $("#view-root").innerHTML = `<div class="view">
    <div class="budget-intro"><p>Le flux ci-dessous se lit comme sur Finary : votre salaire alimente le budget, qui se répartit entre dépenses fixes, investissements et reste à vivre. Déplacez le curseur pour voir l'effet d'un changement de pourcentage — rien n'est enregistré tant que vous ne confirmez pas.</p></div>

    <div class="card">
      <div class="card-title">Flux mensuel — ${fmtEur(income)}</div>
      <div class="sankey-wrap" id="sankey-wrap">${sankey()}</div>
    </div>

    <div class="budget-grid">
      <div class="card">
        <div class="card-title">Part investie chaque mois</div>
        <div class="budget-stat-row">
          <div><div class="tiny-label">Salaire</div><div class="mono budget-figure">${fmtEur(income)}</div></div>
          <div><div class="tiny-label">Dépenses fixes</div><div class="mono budget-figure">${fmtEur(b.housing + b.daily_life + b.subscriptions)}</div></div>
          <div><div class="tiny-label">Reste à vivre</div><div class="mono budget-figure" id="bg-rest">${fmtEur(rest())}</div></div>
        </div>
        <label class="tiny-label">Pourcentage du salaire investi</label>
        <input id="bg-pct" class="budget-slider" type="range" min="0" max="40" step="1" value="${local.investPct}">
        <div class="budget-slider-readout">
          <span class="mono" style="font-size:22px;" id="bg-pct-val">${local.investPct} %</span>
          <span style="color:var(--text-tertiary);font-size:12px;" id="bg-pct-eur">≈ ${fmtEur(monthlyOf(local.investPct))} / mois</span>
        </div>
        <div class="budget-alert" id="bg-alert" style="display:${local.investPct > State.thresholdPct ? "flex" : "none"};">
          ${icon.warn}<div>Au-delà de <b>${State.thresholdPct} %</b> de vos revenus : une confirmation explicite vous sera demandée à l'enregistrement. La décision reste la vôtre.</div>
        </div>
        <div class="mode-toggle" style="margin-top:14px;">
          <button type="button" data-mode="dca" class="${local.dcaMode === "dca" ? "active" : ""}">DCA — tous les mois</button>
          <button type="button" data-mode="once" class="${local.dcaMode === "once" ? "active" : ""}">Versement unique</button>
        </div>
        <button class="btn-primary" id="bg-save" style="margin-top:14px;">Enregistrer le budget</button>
        ${State.plan && State.plan.active ? `
        <div class="budget-alert ok" style="margin-top:14px;">
          ${icon.check}<div>Plan DCA actif : <b>${fmtEur(State.plan.monthly_amount, 2)}</b> / mois.
          ${State.plan.last_executed_at ? `Dernier versement : ${esc(State.plan.last_executed_at.slice(0, 10))}.` : "Aucun versement exécuté pour l'instant."}</div>
        </div>
        <button class="btn-ghost" id="bg-exec">Exécuter le versement de ce mois (${fmtEur(State.plan.monthly_amount, 2)})</button>` : ""}
      </div>

      <div class="card">
        <div class="card-title">Ajouter de l'argent en cours de route</div>
        <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
          Un versement ponctuel s'ajoute à votre plan. S'il dépasse <b>${State.thresholdPct} %</b> de votre salaire mensuel, un avertissement s'affiche et votre confirmation est obligatoire.</p>
        <div class="field"><label>Montant (€)</label><input id="dep-amount" type="number" min="1" placeholder="200"></div>
        <button class="btn-primary" id="dep-btn">Verser sur mon compte virtuel</button>

        <div class="card-title" style="margin-top:22px;">Historique des versements</div>
        <div class="deposit-history" id="dep-history">${depositHistoryHtml()}</div>
      </div>
    </div>
  </div>`;

  /* --- interactions EN PLACE : le slider ne re-rend jamais toute la page --- */
  const slider = $("#bg-pct");
  slider.addEventListener("input", () => {
    local.investPct = +slider.value;
    $("#bg-pct-val").textContent = local.investPct + " %";
    $("#bg-pct-eur").textContent = "≈ " + fmtEur(monthlyOf(local.investPct)) + " / mois";
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
          title: "Au-delà du seuil de prudence",
          body: `Vous souhaitez investir <b>${local.investPct} %</b> de vos revenus, soit <b>${fmtEur(monthlyOf(local.investPct))}</b> par mois.`,
          warning: `Le seuil de prudence est fixé à <b>${State.thresholdPct} %</b> de vos revenus mensuels. C'est votre décision — nous voulons seulement qu'elle soit prise en connaissance de cause.`,
          checkLabel: "Je comprends le risque et je confirme ce pourcentage.",
          confirmText: "Confirmer " + local.investPct + " %",
        });
        if (ok) return saveBudget(true);
        return;
      }
      State.budget = res.budget; State.plan = res.plan;
      toast("Budget enregistré ✓", "success");
      renderBudget();
    } catch (e) { toast("Erreur lors de l'enregistrement.", "error"); }
  };
  $("#bg-save").addEventListener("click", () => saveBudget(false));

  const execBtn = $("#bg-exec");
  if (execBtn) execBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Versement mensuel",
      body: `Exécuter le versement DCA de ce mois : <b>${fmtEur(State.plan.monthly_amount, 2)}</b> seront ajoutés à vos liquidités virtuelles.`,
    });
    if (!ok) return;
    try {
      const res = await API.post("/api/budget/plan/execute");
      State.user = res.user;
      await Promise.all([refreshPortfolio(), refreshBudget()]);
      toast(`Versement de ${fmtEur(res.executed, 2)} effectué ✓`, "success");
      renderBudget();
    } catch (e) {
      toast(e.code === "NO_ACTIVE_PLAN" ? "Aucun plan actif." : "Erreur lors du versement.", "error");
    }
  });

  const doDeposit = async confirmed => {
    const amount = +$("#dep-amount").value;
    if (!amount || amount <= 0) { toast("Indiquez un montant valide.", "error"); return; }
    try {
      const res = await API.post("/api/budget/deposit", { amount, confirmedOverThreshold: confirmed });
      if (res.confirmationRequired) {
        const ok = await confirmModal({
          title: "Versement au-dessus du seuil",
          body: `Vous êtes sur le point de verser <b>${fmtEur(amount, 2)}</b>, soit <b>${res.pctOfIncome} %</b> de votre salaire mensuel.`,
          warning: `Ce montant dépasse le seuil de prudence de <b>${res.threshold} %</b>. Vous restez libre de continuer — confirmez simplement que c'est un choix assumé.`,
          checkLabel: "Je comprends et je confirme ce versement.",
          confirmText: "Verser " + fmtEur(amount, 2),
        });
        if (ok) return doDeposit(true);
        return;
      }
      State.user = res.user;
      await Promise.all([refreshPortfolio(), refreshBudget()]);
      toast(`Versement de ${fmtEur(amount, 2)} effectué ✓`, "success");
      $("#dep-history").innerHTML = depositHistoryHtml();
      $("#dep-amount").value = "";
      updateCashChip();
    } catch (e) { toast("Erreur lors du versement.", "error"); }
  };
  $("#dep-btn").addEventListener("click", () => doDeposit(false));
}

function depositHistoryHtml() {
  if (!State.deposits.length) return `<div class="empty-state" style="padding:18px;">Aucun versement pour l'instant.</div>`;
  return State.deposits.map(d => `
    <div class="deposit-row">
      <div>
        <div>${d.type === "monthly" ? "Versement mensuel (DCA)" : "Versement ponctuel"}
          ${d.over_threshold ? `<span class="tag warning" style="margin-left:6px;">&gt; ${State.thresholdPct}% confirmé</span>` : ""}</div>
        <div class="when">${esc((d.created_at || "").slice(0, 16))}${d.pct_of_income != null ? ` · ${(+d.pct_of_income).toFixed(1)} % du salaire` : ""}</div>
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
        <input id="tr-search" type="text" placeholder="Rechercher une action, un ETF, une crypto…" autocomplete="off">
        <div class="search-results" id="tr-results"></div>
      </div>
      <div class="card-title" style="margin-bottom:8px;">Mes positions</div>
      <div id="tr-watchlist">
        ${pf.positions.length ? pf.positions.map(h => `
        <div class="watchlist-item ${h.symbol === State.trade.symbol ? "active" : ""}" data-sym="${esc(h.symbol)}">
          <div class="watchlist-left">
            <div class="stock-logo" style="width:26px;height:26px;font-size:9.5px;">${esc(h.symbol.slice(0, 2))}</div>
            <div><div style="font-weight:600;font-size:12.5px;">${esc(h.symbol)}</div>
            <div style="font-size:10.5px;color:var(--text-tertiary);">${esc(h.name || "")}</div></div>
          </div>
          <div class="mono" style="font-size:12px;color:${h.changePct >= 0 ? "var(--positive)" : "var(--negative)"}">${fmtPct(h.changePct)}</div>
        </div>`).join("") : `<div class="empty-state" style="padding:18px;">Aucune position. Cherchez un actif ci-dessus pour commencer.</div>`}
      </div>
      <div class="card-title" style="margin:18px 0 8px;">Populaires</div>
      <div id="tr-popular">
        ${[["AAPL","Apple","stock"],["MC.PA","LVMH","stock"],["CW8.PA","ETF Monde","etf"],["BTC","Bitcoin","crypto"],["ETH","Ethereum","crypto"],["OAT10","OAT 10 ans","bond"]].map(p => `
        <div class="watchlist-item" data-sym="${p[0]}">
          <div class="watchlist-left">
            <div class="stock-logo" style="width:26px;height:26px;font-size:9.5px;background:${CLASS_COLORS[p[2]]};">${p[0].slice(0, 2)}</div>
            <div><div style="font-weight:600;font-size:12.5px;">${p[0]}</div>
            <div style="font-size:10.5px;color:var(--text-tertiary);">${p[1]}</div></div>
          </div>
          <span class="tag" style="background:${CLASS_COLORS[p[2]]}22;color:${CLASS_COLORS[p[2]]};font-size:10px;">${CLASS_FR[p[2]]}</span>
        </div>`).join("")}
      </div>
    </div>
    <div class="card" id="tr-detail"><div class="empty-state">Sélectionnez une action ou utilisez la recherche.</div></div>
    <div class="card" id="tr-order"></div>
  </div></div>`;

  /* --- recherche : debounce 250 ms sur /api/market/search --- */
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
              <span class="sym">${esc(r.symbol)} ${r.assetClass && r.assetClass !== "stock" ? `<span class="tag" style="background:${CLASS_COLORS[r.assetClass]}22;color:${CLASS_COLORS[r.assetClass]};font-size:9.5px;margin-left:5px;">${CLASS_FR[r.assetClass]}</span>` : ""}</span>
              <span class="desc">${esc(r.description || "")}</span>
            </div>`).join("")
          : `<div class="search-empty">Aucun résultat pour « ${esc(q)} ».</div>`;
        resultsEl.classList.add("open");
        resultsEl.querySelectorAll("[data-sym]").forEach(el =>
          el.addEventListener("click", () => {
            resultsEl.classList.remove("open");
            input.value = "";
            selectSymbol(el.dataset.sym);
          }));
      } catch (e) { /* silencieux */ }
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
  detailEl.innerHTML = `<div class="empty-state">Chargement de ${esc(symbol)}…</div>`;
  try {
    const d = await API.get("/api/market/stock/" + encodeURIComponent(symbol));
    State.trade.detail = d;
    const held = State.portfolio.positions.find(p => p.symbol === symbol);
    detailEl.innerHTML = `
      <div class="stock-detail-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="stock-logo">${esc(symbol.slice(0, 2))}</div>
          <div><div style="font-weight:700;font-size:15px;">${esc(d.name || symbol)}</div>
          <div class="stock-ticker">${esc(symbol)} · ${esc(SECTOR_FR[d.sector] || d.sector || "—")} · ${esc(d.country || "—")} ${classTag(d.assetClass)}</div></div>
        </div>
        <div style="text-align:right;">
          <div class="stock-detail-price" data-live="price:${esc(symbol)}">${fmtEur(d.price, 2)}</div>
          <span class="tag ${d.changePct >= 0 ? "positive" : "negative"}" data-live="chg:${esc(symbol)}">${fmtPct(d.changePct)}</span>
          ${d.simulated && !State.demoMode ? `<div style="margin-top:6px;"><span class="tag warning">cours simulé (hors couverture API)</span></div>` : ""}
          ${d.yieldPct ? `<div style="margin-top:6px;"><span class="tag positive">rendement ~${d.yieldPct}%/an</span></div>` : ""}
        </div>
      </div>
      <div class="chart-area">${sparklineSvg(d.sparkline, { w: 520, h: 180, stroke: d.changePct >= 0 ? "#7fb88f" : "#e0645a", fill: true })}</div>
      ${held ? `
      <div style="display:flex;justify-content:space-between;padding-top:14px;border-top:1px solid var(--border);">
        <div><div class="tiny-label">Position actuelle</div><div class="mono" style="font-size:14px;margin-top:4px;">${fmtQty(held.shares)} titre(s) · <span data-live="value:${esc(symbol)}">${fmtEur(held.value)}</span></div></div>
        <div><div class="tiny-label">Prix de revient</div><div class="mono" style="font-size:14px;margin-top:4px;">${fmtEur(held.avg_cost, 2)}</div></div>
        <div><div class="tiny-label">+/- value latente</div><div class="mono" style="font-size:14px;margin-top:4px;color:${held.pnl >= 0 ? "var(--positive)" : "var(--negative)"}">${held.pnl >= 0 ? "+" : ""}${fmtEur(held.pnl)}</div></div>
      </div>` : ""}`;
  } catch (e) {
    detailEl.innerHTML = `<div class="empty-state"><b>Symbole introuvable.</b> Essayez une autre recherche.</div>`;
    State.trade.detail = null;
  }
  renderOrderForm();
}

function renderOrderForm() {
  const el = $("#tr-order");
  if (!el) return;
  const d = State.trade.detail;
  if (!d) { el.innerHTML = `<div class="card-title">Passer un ordre</div><div class="empty-state" style="padding:18px;">Sélectionnez d'abord un actif.</div>`; return; }
  const t = State.trade;
  el.innerHTML = `
    <div class="card-title">Passer un ordre</div>
    <div class="buysell-toggle">
      <button type="button" class="buy ${t.side === "buy" ? "active" : ""}" data-side="buy">Acheter</button>
      <button type="button" class="sell ${t.side === "sell" ? "active" : ""}" data-side="sell">Vendre</button>
    </div>
    <div class="order-form">
      <label>Saisie de l'ordre</label>
      <div class="mode-toggle" style="margin-bottom:10px;">
        <button type="button" data-imode="qty" class="${t.inputMode === "qty" ? "active" : ""}">En quantité</button>
        <button type="button" data-imode="eur" class="${t.inputMode === "eur" ? "active" : ""}">En euros</button>
      </div>
      <div id="order-input-zone"></div>
      <div id="order-summary"></div>
      <button class="btn-primary" id="order-btn" style="margin-top:14px;"></button>
      <div class="hint" style="margin-top:8px;color:var(--text-tertiary);font-size:11px;">Fractions autorisées (jusqu'à 6 décimales) — comme sur les courtiers modernes, vous pouvez acheter 0,001 Bitcoin ou 0,5 action.</div>
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

/* zone de saisie : quantité (avec +/− et Max) ou montant en euros */
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
      <button type="button" class="btn-ghost" id="qty-max" style="margin-top:8px;padding:8px;font-size:12px;">${t.side === "buy" ? "Max (toutes mes liquidités)" : "Tout vendre"}</button>`;
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
      <button type="button" class="btn-ghost" id="amount-max" style="margin-top:8px;padding:8px;font-size:12px;">${t.side === "buy" ? "Max (toutes mes liquidités)" : "Tout vendre"}</button>`;
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

/* "0,001" ou "0.001" → 0.001 */
function parseDecimal(v) {
  return parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
}

/* boutons +/− : pas de 0,5 avec plancher à 0,5 (la saisie libre au clavier
   reste possible jusqu'à 0,000001 pour la crypto) */
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

/* quantité réellement envoyée au serveur selon le mode de saisie */
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
    <div class="order-summary-row"><span>Cours actuel</span><b>${fmtEur(d.price, 2)}</b></div>
    <div class="order-summary-row"><span>Quantité</span><b>${fmtQty(qty)}</b></div>
    <div class="order-summary-row"><span>Montant estimé</span><b>${fmtEur(est, 2)}</b></div>
    <div class="order-summary-row"><span>Liquidités après ordre</span><b style="color:${after < 0 ? "var(--negative)" : "inherit"}">${fmtEur(after, 2)}</b></div>`;
  const btn = $("#order-btn");
  if (btn) {
    btn.textContent = State.trade.side === "buy" ? "Confirmer l'achat" : "Confirmer la vente";
    btn.disabled = qty <= 0;
  }
}

async function placeOrder() {
  const d = State.trade.detail;
  if (!d) return;
  const side = State.trade.side;
  const qty = effectiveQty();
  if (qty <= 0) { toast("Quantité invalide.", "error"); return; }
  const est = d.price * qty;
  const ok = await confirmModal({
    title: side === "buy" ? "Confirmer l'achat" : "Confirmer la vente",
    body: `${side === "buy" ? "Acheter" : "Vendre"} <b>${fmtQty(qty)} × ${esc(d.symbol)}</b> au cours du marché (~${fmtEur(d.price, 2)} / titre), soit environ <b>${fmtEur(est, 2)}</b>.<br><br>Le prix exécuté sera le cours serveur au moment de l'ordre.`,
  });
  if (!ok) return;
  try {
    const res = await API.post("/api/portfolio/order", { symbol: d.symbol, side, qty });
    await refreshPortfolio();
    State.newsItems = [];
    toast(`Ordre exécuté : ${fmtQty(res.qty ?? qty)} × ${fmtEur(res.executedPrice, 2)} — total ${fmtEur(res.total, 2)} ✓`, "success");
    renderTrading();
  } catch (e) {
    const map = { INSUFFICIENT_CASH: "Liquidités insuffisantes — alimentez votre compte dans Budget.", INSUFFICIENT_SHARES: "Vous ne détenez pas assez de titres.", SYMBOL_NOT_FOUND: "Symbole introuvable.", INVALID_QTY: "Quantité invalide." };
    toast(map[e.code] || "Erreur lors de l'ordre.", "error");
  }
}

/* ================================================================= NEWS = */
async function renderNews() {
  const held = State.portfolio.positions.map(p => p.symbol);
  $("#view-root").innerHTML = `<div class="view">
    <div class="news-filters" id="news-filters">
      <button class="filter-chip ${State.newsFilter === "all" ? "active" : ""}" data-nf="all">Toutes mes positions</button>
      ${held.map(s => `<button class="filter-chip ${State.newsFilter === s ? "active" : ""}" data-nf="${esc(s)}">${esc(s)}</button>`).join("")}
    </div>
    <div class="news-list" id="news-list"><div class="empty-state">Chargement des actualités…</div></div>
  </div>`;
  $("#news-filters").querySelectorAll("[data-nf]").forEach(b =>
    b.addEventListener("click", () => { State.newsFilter = b.dataset.nf; renderNews(); }));

  if (!held.length) {
    $("#news-list").innerHTML = `<div class="empty-state"><b>Aucune position, donc aucune actualité filtrée.</b><br>Le flux n'affiche que les nouvelles des actions que vous détenez.</div>`;
    return;
  }
  try {
    if (!State.newsItems.length) {
      const res = await API.get("/api/news");
      State.newsItems = res.items || [];
    }
    const items = State.newsItems.filter(n => State.newsFilter === "all" || n.symbol === State.newsFilter);
    $("#news-list").innerHTML = items.length ? items.map(n => `
      <div class="news-card">
        <div style="flex:1;">
          <div class="news-meta">
            <span class="news-stock-badge">${esc(n.symbol)}</span>
            <span class="news-source">${esc(n.source || "")}</span>
            <span class="news-time">· il y a ${timeAgo(n.datetime)}</span>
          </div>
          <div class="news-headline">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>` : esc(n.headline)}</div>
          <div class="news-summary">${esc(n.summary || "")}</div>
        </div>
      </div>`).join("")
      : `<div class="empty-state">Aucune actualité récente pour ce filtre.</div>`;
  } catch (e) {
    $("#news-list").innerHTML = `<div class="empty-state">Impossible de charger les actualités pour le moment.</div>`;
  }
}

/* ================================================================ AGENT = */
async function renderAgent() {
  $("#view-root").innerHTML = `<div class="view"><div class="agent-layout">
    <div>
      <div id="agent-alerts"></div>
      <div class="card">
        <div class="card-title">Conversation avec l'agent
          <div style="display:flex;gap:6px;">
            <button class="filter-chip" id="chat-new">+ Nouvelle</button>
            <button class="filter-chip" id="chat-clear">Supprimer</button>
          </div>
        </div>
        <div class="chat-thread" id="chat-thread"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Écrire à l'agent… (ex : quel est mon risque ?)" maxlength="2000">
          <button id="chat-send">${icon.send}</button>
        </div>
      </div>
    </div>
    <div>
      <div class="card" style="margin-bottom:16px;"><div class="card-title">Suggestions de rééquilibrage</div><div id="agent-suggestions"><div class="empty-state" style="padding:18px;">Analyse en cours…</div></div></div>
      <div class="card"><div class="card-title">Conversations archivées</div><div id="chat-archives"></div></div>
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
      title: "Supprimer la conversation",
      body: "La conversation en cours sera définitivement supprimée (sans archivage). Continuer ?",
      confirmText: "Supprimer",
    });
    if (!ok) return;
    resetChat();
    drawChat();
    toast("Conversation supprimée", "success");
  });

  try {
    State.insights = await API.get("/api/agent/insights");
    const a = State.insights;
    $("#agent-alerts").innerHTML = a.alerts.length ? a.alerts.map(al => `
      <div class="alert-card">
        <div class="alert-icon">${icon.warn}</div>
        <div><div class="alert-title">${al.type === "SECTOR_CONCENTRATION" ? "Sur-exposition détectée · " + esc(SECTOR_FR[al.label] || al.label) : "Concentration géographique · " + esc(al.label)}</div>
        <div class="alert-body">${esc(al.message)}</div></div>
      </div>`).join("") : `
      <div class="budget-alert ok" style="margin:0 0 14px;">${icon.check}<div><b>Aucune alerte de concentration.</b> Votre allocation reste sous les seuils de vigilance — l'agent continue de surveiller.</div></div>`;

    const top = a.sectorBreakdown[0];
    const under = a.underRepresented.slice(0, 3);
    $("#agent-suggestions").innerHTML = a.sectorBreakdown.length ? `
      ${top && top.pct > a.threshold ? `
      <div class="suggestion-item"><div class="suggestion-icon">1</div>
        <div class="suggestion-text">Alléger légèrement <b>${esc(SECTOR_FR[top.label] || top.label)}</b>, votre secteur dominant (${top.pct} %).</div></div>` : ""}
      ${under.map((s, i) => `
      <div class="suggestion-item"><div class="suggestion-icon">${(top && top.pct > a.threshold ? 2 : 1) + i}</div>
        <div class="suggestion-text">Renforcer <b>${esc(SECTOR_FR[s] || s)}</b>, sous-représenté dans votre portefeuille.</div></div>`).join("")}
      <div class="suggestion-item"><div class="suggestion-icon">i</div>
        <div class="suggestion-text">Objectif pédagogique : qu'aucun secteur ne dépasse <b>${a.threshold} %</b> du portefeuille investi.</div></div>`
      : `<div class="empty-state" style="padding:18px;">Passez un premier ordre pour obtenir une analyse.</div>`;
  } catch (e) {
    $("#agent-suggestions").innerHTML = `<div class="empty-state" style="padding:18px;">Analyse indisponible.</div>`;
  }
}

/* --- gestion des conversations : archives en localStorage, par utilisateur --- */
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
    content: `Bonjour ${State.user.name} 👋 Je suis l'agent Finwise. Je surveille votre portefeuille et je peux vous expliquer : le risque, la diversification, le DCA, les intérêts composés, les ETF, les obligations, les crypto-actifs, l'assurance vie, les dividendes, le PER… Posez-moi une question !`,
  };
}
function resetChat() { State.chat = [welcomeMessage()]; }
function newConversation() {
  // archive la conversation courante si elle contient au moins un échange
  if (State.chat.some(m => m.role === "user")) {
    const archives = loadArchives();
    const firstUser = State.chat.find(m => m.role === "user");
    archives.unshift({
      at: Date.now(),
      title: firstUser ? firstUser.content.slice(0, 60) : "Conversation",
      messages: State.chat,
    });
    saveArchives(archives);
    toast("Conversation archivée ✓", "success");
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
    el.innerHTML = `<div class="empty-state" style="padding:16px;">Aucune archive. « + Nouvelle » archive la conversation en cours et en démarre une autre.</div>`;
    return;
  }
  el.innerHTML = archives.map((a, i) => `
    <div class="deposit-row">
      <div style="min-width:0;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title)}</div>
        <div class="when">${new Date(a.at).toLocaleDateString("fr-FR")} · ${a.messages.length} messages</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="filter-chip" data-arch-open="${i}">Reprendre</button>
        <button class="filter-chip" data-arch-del="${i}" style="color:var(--negative);">✕</button>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-arch-open]").forEach(b =>
    b.addEventListener("click", () => {
      const archives2 = loadArchives();
      const a = archives2[+b.dataset.archOpen];
      if (!a) return;
      // la conversation courante est archivée avant de reprendre l'ancienne
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
      const ok = await confirmModal({ title: "Supprimer l'archive", body: "Cette conversation archivée sera définitivement supprimée.", confirmText: "Supprimer" });
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
    State.chat.push({ role: "assistant", content: "Désolé, je n'ai pas pu répondre. Réessayez dans un instant." });
  }
  $("#chat-send").disabled = false;
  drawChat();
}

/* ================================================================= RISK = */
const CONCEPTS = [
  { t: "Diversification", s: "Ne pas mettre tous ses œufs dans le même panier.",
    d: "Répartir son capital sur des actifs qui ne réagissent pas tous pareil aux mêmes événements : plusieurs secteurs, plusieurs pays, plusieurs classes d'actifs (actions, obligations, ETF…). C'est l'idée fondatrice de la théorie moderne du portefeuille (Markowitz, 1952, prix Nobel) : en combinant des actifs peu corrélés, on obtient un meilleur couple rendement/risque que chaque actif isolé. Exemple concret : un portefeuille 100% tech peut perdre 30% quand le secteur corrige ; un portefeuille actions + obligations + plusieurs secteurs encaisse le même choc avec une perte bien moindre." },
  { t: "Concentration", s: "Quand un seul secteur ou pays pèse trop lourd.",
    d: "Si 70% de votre portefeuille dépend de la technologie, une seule mauvaise nouvelle sur ce secteur touche 70% de votre capital. Idem par pays : être investi uniquement en France vous expose à un choc économique local. La jauge du Dashboard surveille votre plus grosse exposition et la traduit en euros : au-delà de 50% sur un secteur, l'agent vous alerte et chiffre ce que coûterait une correction de -20%." },
  { t: "La règle des 10 %", s: "Un avertissement, pas une interdiction.",
    d: "Verser plus de 10% de ses revenus mensuels dans l'investissement réduit la marge de sécurité en cas d'imprévu (panne, perte d'emploi, dépense de santé). Finwise ne l'interdit pas : le serveur exige simplement une confirmation explicite (case à cocher) quand vous dépassez ce seuil — à l'onboarding, en modifiant votre budget ou sur un versement ponctuel. Le principe : la décision vous appartient, mais elle doit être prise en connaissance de cause." },
  { t: "Volatilité", s: "L'amplitude des variations d'un actif.",
    d: "Une obligation d'État bouge de ±0,2% par jour, une grande action de ±1-3%, un crypto-actif de ±5-10%. Plus la volatilité est élevée, plus les gains ET les pertes de court terme peuvent être brutaux — et plus il faut un horizon long pour absorber les creux. Point clé : un portefeuille diversifié a une volatilité inférieure à la moyenne de ses composants, parce que les baisses des uns sont amorties par les autres." },
  { t: "Intérêts composés", s: "Gagner des intérêts sur les intérêts.",
    d: "Quand vos gains sont réinvestis, ils génèrent à leur tour des gains : la croissance devient exponentielle. 100 € par mois à 5%/an = 24 000 € versés en 20 ans, mais ~41 000 € de capital final. Einstein aurait appelé ça « la huitième merveille du monde ». Les deux leviers : commencer tôt (le temps fait l'essentiel du travail) et ne pas interrompre la capitalisation. Testez vos propres chiffres avec le projecteur ci-dessous." },
  { t: "Actions, ETF, obligations, crypto", s: "Les grandes classes d'actifs.",
    d: "Action : une part de propriété d'une entreprise — rendement potentiel élevé, volatilité élevée. ETF : un panier qui réplique un indice (ex : MSCI World = ~1 500 entreprises) — la diversification en un seul achat, avec des frais très bas. Obligation : un prêt à un État ou une entreprise contre un intérêt régulier (le coupon) — peu volatil, c'est l'amortisseur du portefeuille. Crypto-actif : très volatil, non adossé à des revenus — règle courante : pas plus de 5-10% du portefeuille. Vous pouvez acheter chacune de ces classes dans l'onglet Investir." },
  { t: "Assurance vie & épargne programmée", s: "Verser tous les mois, projeter sur 20 ans.",
    d: "L'assurance vie est une enveloppe : à l'intérieur, on choisit entre fonds en euros (capital garanti, ~2,5-3%/an) et unités de compte (ETF, actions… non garanties). Son vrai pouvoir vient des versements programmés : 100-200 € prélevés chaque mois, capitalisés sur 15-20 ans avec une fiscalité allégée après 8 ans. Le Livret A reste l'épargne de précaution : garanti et disponible, mais plafonné. Le projecteur ci-dessous simule exactement ce scénario de versements mensuels." },
  { t: "Risque de perte en capital", s: "Aucune garantie sur les marchés.",
    d: "Contrairement à un livret réglementé, un portefeuille d'actions n'offre aucune garantie : sa valeur peut passer — et rester longtemps — sous votre mise initiale. Historiquement, les marchés actions ont traversé des baisses de -30 à -50% (2000, 2008, 2020) avant de se reprendre, parfois en plusieurs années. C'est pour cela que l'horizon compte : argent nécessaire sous 2 ans → épargne sécurisée ; 8 ans et plus → les actions ont historiquement toujours fini gagnantes sur ces durées." },
];

const GLOSSARY = [
  { q: "Cours / Prix", a: "Le prix auquel un actif s'échange à l'instant T, fixé en continu par l'offre et la demande. Sur les fiches type Yahoo Finance : « Previous close » = clôture de la veille, « Open » = premier prix de la séance." },
  { q: "Capitalisation boursière", a: "La valeur totale d'une entreprise en bourse : cours de l'action × nombre d'actions. On parle de large caps (> 10 Md€), mid caps et small caps — plus la capitalisation est petite, plus le titre est en général volatil et peu liquide." },
  { q: "PER (Price/Earnings Ratio)", a: "Cours ÷ bénéfice par action : le nombre d'années de bénéfices que vous « payez ». PER < 10 : décoté ou en difficulté ; 15-25 : classique ; > 30 : le marché attend une forte croissance. À comparer toujours au secteur." },
  { q: "BPA / EPS", a: "Bénéfice Par Action (Earnings Per Share) : le bénéfice net divisé par le nombre d'actions. C'est le « E » du PER, et l'indicateur que les analystes scrutent à chaque publication trimestrielle." },
  { q: "Dividende & rendement", a: "Part du bénéfice reversée aux actionnaires. Rendement = dividende annuel ÷ cours (3 € sur une action à 100 € = 3%). Méfiance si le rendement paraît trop beau : il cache souvent un cours effondré." },
  { q: "Volume", a: "Le nombre de titres échangés sur une période. Un volume élevé = beaucoup d'acheteurs et de vendeurs = un prix plus fiable et une revente facile." },
  { q: "Spread", a: "L'écart entre le meilleur prix d'achat (bid) et le meilleur prix de vente (ask). Plus il est serré, plus l'actif est liquide. Sur les petites valeurs ou cryptos exotiques, le spread peut coûter plusieurs % à lui seul." },
  { q: "Bêta", a: "La sensibilité d'un titre aux mouvements du marché. Bêta = 1 : bouge comme le marché ; > 1 : amplifie (tech, luxe) ; < 1 : amortit (santé, consommation de base)." },
  { q: "Ordre au marché / à cours limité", a: "Au marché : exécuté immédiatement au meilleur prix disponible. À cours limité : exécuté seulement si le prix atteint votre limite — vous contrôlez le prix, pas l'exécution. Ce simulateur exécute au marché, au cours serveur." },
  { q: "Obligation, coupon, échéance", a: "Une obligation est un prêt à un État ou une entreprise. Le coupon est l'intérêt versé régulièrement ; l'échéance (maturité) est la date de remboursement. Le rendement obligataire monte quand le prix de l'obligation baisse, et inversement." },
  { q: "OAT / Bund / Treasury", a: "Les obligations d'État de référence : OAT pour la France, Bund pour l'Allemagne, Treasury pour les États-Unis. Leur taux à 10 ans sert de référence « sans risque » pour valoriser tous les autres actifs." },
  { q: "ETF / Tracker", a: "Fonds coté qui réplique un indice (MSCI World, S&P 500, Nasdaq…). Diversification instantanée, frais très bas (TER souvent < 0,3%/an). L'outil de base de l'investisseur débutant." },
  { q: "Crypto-actif & stablecoin", a: "Actif numérique sur blockchain (Bitcoin, Ethereum…). Très volatil et non adossé à des revenus d'entreprise. Un stablecoin est une crypto conçue pour suivre une monnaie (1 USDT ≈ 1 $) — utile pour les échanges, pas pour le rendement." },
  { q: "Intérêts composés", a: "Les intérêts produisent eux-mêmes des intérêts dès qu'ils sont réinvestis. C'est la force exponentielle du long terme : à 7%/an, un capital double environ tous les 10 ans (règle des 72 : 72 ÷ taux = années pour doubler)." },
  { q: "Inflation & rendement réel", a: "Hausse générale des prix qui érode le pouvoir d'achat. Rendement réel = rendement nominal − inflation. Un livret à 2% avec 3% d'inflation vous fait perdre 1% de pouvoir d'achat par an." },
  { q: "Liquidité", a: "La facilité à vendre rapidement sans perdre de valeur. Une action du CAC 40 se vend en une seconde ; l'immobilier prend des mois. Toujours se demander : « à quel prix pourrai-je réellement récupérer cet argent demain ? »" },
  { q: "PEA / CTO / Assurance vie", a: "Les trois enveloppes françaises : PEA (actions européennes, exonération après 5 ans, plafond 150 k€), CTO (tout accessible, flat tax 30%), assurance vie (fiscalité allégée après 8 ans, versements programmés). Le choix de l'enveloppe est aussi important que le choix des actifs." },
  { q: "DCA (Dollar-Cost Averaging)", a: "Investir la même somme à intervalle régulier, quel que soit le niveau du marché. Lisse le prix d'entrée et supprime le stress du « bon moment ». C'est le mode par défaut de votre plan dans l'onglet Budget." },
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
    .map(p => `<text x="${x(pts.indexOf(p))}" y="${H - 4}" text-anchor="middle" font-size="9.5" fill="#6b6d80">${p.y} an${p.y > 1 ? "s" : ""}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">
    <path d="${area("total")}" fill="#e3b567" opacity="0.18"/>
    <path d="${area("versed")}" fill="#6fb8b0" opacity="0.30"/>
    <path d="${line("total")}" fill="none" stroke="#e3b567" stroke-width="2"/>
    <path d="${line("versed")}" fill="none" stroke="#6fb8b0" stroke-width="2" stroke-dasharray="4 3"/>
    ${labels}
  </svg>`;
}

function renderRisk() {
  const a = State.insights;
  const top = a && a.sectorBreakdown && a.sectorBreakdown[0];
  const proj = { monthly: 150, rate: 5, years: 20 };

  $("#view-root").innerHTML = `<div class="view">
    <div class="risk-intro"><p>Avant d'investir un seul euro réel, il faut comprendre ce que racontent les chiffres de votre dashboard. Cliquez sur chaque fiche pour le détail, projetez vos versements mensuels avec le simulateur d'intérêts composés, et retrouvez en bas le glossaire des termes que vous croiserez sur les fiches valeurs (Yahoo Finance, Zone Bourse…).</p></div>

    ${top ? `<div class="budget-alert" style="margin:0 0 20px;">${icon.warn}<div>Illustration avec <b>votre</b> portefeuille : votre plus grosse exposition est <b>${esc(SECTOR_FR[top.label] || top.label)}</b> à <b>${top.pct} %</b> (${fmtEur(top.value)}). Une correction de -20 % de cette poche vous coûterait environ <b>${fmtEur(top.value * 0.2)}</b>.</div></div>` : ""}

    <div class="section-label">Concepts à connaître — cliquez pour le détail</div>
    <div class="concept-grid">
      ${CONCEPTS.map((c, i) => `
      <div class="concept-card clickable" data-concept="${i}">
        <div class="concept-icon">${i + 1}</div>
        <div class="concept-title">${c.t} <span class="chev">+</span></div>
        <div class="concept-text">${c.s}</div>
        <div class="concept-more">${c.d}</div>
      </div>`).join("")}
    </div>

    <div class="section-label">Projecteur d'intérêts composés — versements mensuels</div>
    <div class="card">
      <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">
        Le scénario type d'une assurance vie ou d'un plan DCA : une somme fixe versée chaque mois, capitalisée année après année. La zone <b style="color:var(--teal)">bleue</b> = ce que vous versez ; la zone <b style="color:var(--accent)">dorée</b> = votre capital total. L'écart entre les deux, ce sont les intérêts composés.</p>
      <div class="field-row" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="field"><label>Versement mensuel : <span id="pj-m-val" class="mono">${proj.monthly} €</span></label>
          <input id="pj-m" class="budget-slider" type="range" min="10" max="1000" step="10" value="${proj.monthly}"></div>
        <div class="field"><label>Rendement annuel : <span id="pj-r-val" class="mono">${proj.rate} %</span></label>
          <input id="pj-r" class="budget-slider" type="range" min="0" max="12" step="0.5" value="${proj.rate}"></div>
        <div class="field"><label>Durée : <span id="pj-y-val" class="mono">${proj.years} ans</span></label>
          <input id="pj-y" class="budget-slider" type="range" min="1" max="40" step="1" value="${proj.years}"></div>
      </div>
      <div id="pj-chart"></div>
      <div class="budget-stat-row" style="border-bottom:none;margin-top:10px;padding-bottom:0;">
        <div><div class="tiny-label">Total versé</div><div class="mono budget-figure" style="color:var(--teal);" id="pj-versed">—</div></div>
        <div><div class="tiny-label">Intérêts gagnés</div><div class="mono budget-figure" style="color:var(--accent);" id="pj-interest">—</div></div>
        <div><div class="tiny-label">Capital final</div><div class="mono budget-figure" id="pj-total">—</div></div>
      </div>
      <div class="hint" style="margin-top:10px;color:var(--text-tertiary);font-size:11px;">Repères pédagogiques : Livret A ~2-3 %, fonds euros ~2,5-3 %, obligations ~3-4 %, actions monde ~6-8 %/an en moyenne historique — sans garantie et avec de fortes variations d'une année à l'autre.</div>
    </div>

    <div class="section-label">Glossaire des fiches valeurs</div>
    <div class="card">
      ${GLOSSARY.map((g, i) => `
      <div class="glossary-item" data-gl="${i}">
        <div class="glossary-q"><span>${g.q}</span><span class="chev">+</span></div>
        <div class="glossary-a">${g.a}</div>
      </div>`).join("")}
    </div>

    <div class="risk-disclaimer"><b>Rappel :</b> Finwise est un simulateur pédagogique. Les scénarios, projections, alertes et suggestions affichés ici et dans toute l'application ne constituent en aucun cas un conseil en investissement réel. Les rendements passés ne préjugent pas des rendements futurs.</div>
  </div>`;

  /* fiches cliquables + glossaire (accordéons, mise à jour en place) */
  document.querySelectorAll("[data-concept]").forEach(card =>
    card.addEventListener("click", () => card.classList.toggle("open")));
  document.querySelectorAll("[data-gl]").forEach(item =>
    item.addEventListener("click", () => item.classList.toggle("open")));

  /* projecteur : recalcul en place à chaque slider */
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
  bindSlider("#pj-y", "years", " ans");
  redraw();
}

/* ============================================================== COMPTE == */
function renderAccount() {
  const u = State.user;
  $("#view-root").innerHTML = `<div class="view">
    <div class="budget-grid">
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">Profil</div>
          <div class="field"><label>Prénom</label><input id="ac-name" type="text" value="${esc(u.name)}" maxlength="60"></div>
          <div class="field"><label>E-mail</label><input id="ac-email" type="email" value="${esc(u.email)}"></div>
          <div class="hint" style="margin-bottom:12px;">Compte créé le ${esc((u.created_at || "").slice(0, 10))}${u.role === "admin" ? ' · <span class="tag warning">Administrateur</span>' : ""}</div>
          <button class="btn-primary" id="ac-save-profile">Enregistrer le profil</button>
        </div>
        <div class="card">
          <div class="card-title">Mot de passe</div>
          <div class="field"><label>Mot de passe actuel</label><input id="ac-cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label>Nouveau mot de passe</label><input id="ac-new" type="password" autocomplete="new-password"><div class="hint">8 caractères minimum.</div></div>
          <button class="btn-primary" id="ac-save-pass">Changer le mot de passe</button>
        </div>
      </div>
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">Mes données</div>
          <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.65;">
            Vos données sont stockées côté serveur dans une base SQL (utilisateur, budget, plan DCA, versements, positions, transactions). Le mot de passe n'est jamais conservé en clair — seule une empreinte bcrypt l'est. La session vit dans un cookie httpOnly inaccessible au JavaScript.</p>
          <div class="budget-stat-row" style="margin-top:14px;border-bottom:none;padding-bottom:0;">
            <div><div class="tiny-label">Positions</div><div class="mono budget-figure">${State.portfolio ? State.portfolio.positions.length : 0}</div></div>
            <div><div class="tiny-label">Transactions</div><div class="mono budget-figure">${State.portfolio ? State.portfolio.transactions.length : 0}</div></div>
            <div><div class="tiny-label">Versements</div><div class="mono budget-figure">${State.deposits.length}</div></div>
          </div>
        </div>
        <div class="card" style="border-color:#e0645a55;">
          <div class="card-title" style="color:var(--negative);">Zone de danger</div>
          <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
            Supprimer votre compte efface définitivement toutes vos données : budget, plan, versements, positions et historique. Cette action est irréversible.</p>
          <div class="field"><label>Confirmez votre mot de passe</label><input id="ac-del-pass" type="password" autocomplete="current-password"></div>
          <button class="btn-ghost" id="ac-delete" style="border-color:#e0645a55;color:var(--negative);">Supprimer mon compte</button>
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
      toast("Profil mis à jour ✓", "success");
      renderAccount();
    } catch (e) {
      const map = { EMAIL_TAKEN: "Cet e-mail est déjà utilisé.", INVALID_EMAIL: "E-mail invalide.", INVALID_NAME: "Prénom invalide." };
      toast(map[e.code] || "Erreur lors de la mise à jour.", "error");
    }
  });

  $("#ac-save-pass").addEventListener("click", async () => {
    try {
      await API.put("/api/account/password", {
        currentPassword: $("#ac-cur").value, newPassword: $("#ac-new").value,
      });
      $("#ac-cur").value = ""; $("#ac-new").value = "";
      toast("Mot de passe modifié ✓", "success");
    } catch (e) {
      const map = { WRONG_PASSWORD: "Mot de passe actuel incorrect.", PASSWORD_TOO_SHORT: "8 caractères minimum." };
      toast(map[e.code] || "Erreur lors du changement.", "error");
    }
  });

  $("#ac-delete").addEventListener("click", async () => {
    const password = $("#ac-del-pass").value;
    if (!password) { toast("Confirmez votre mot de passe.", "error"); return; }
    const ok = await confirmModal({
      title: "Supprimer définitivement le compte",
      body: `Toutes les données de <b>${esc(State.user.email)}</b> seront effacées : budget, plan DCA, versements, positions, transactions.`,
      warning: "Cette action est <b>irréversible</b>.",
      checkLabel: "Je comprends que toutes mes données seront définitivement supprimées.",
      confirmText: "Supprimer mon compte",
    });
    if (!ok) return;
    try {
      await API.request("DELETE", "/api/account", { password });
      stopPolling();
      State.user = null; State.portfolio = null; State.chat = [];
      toast("Compte supprimé.", "success");
      renderAuth("login");
    } catch (e) {
      toast(e.code === "WRONG_PASSWORD" ? "Mot de passe incorrect." : "Erreur lors de la suppression.", "error");
    }
  });
}

/* =============================================================== ADMIN == */
async function renderAdmin() {
  $("#view-root").innerHTML = `<div class="view"><div class="card">
    <div class="card-title">Utilisateurs</div>
    <div id="admin-users"><div class="empty-state">Chargement…</div></div>
  </div></div>`;
  try {
    const res = await API.get("/api/admin/users");
    drawAdminUsers(res.users);
  } catch (e) {
    $("#admin-users").innerHTML = `<div class="empty-state"><b>Accès refusé.</b> Cette page est réservée aux administrateurs.</div>`;
  }
}

function drawAdminUsers(users) {
  const el = $("#admin-users");
  if (!el) return;
  el.innerHTML = `
    <table class="holdings-table">
      <thead><tr><th>#</th><th>Utilisateur</th><th>Rôle</th><th>Liquidités</th><th>Versé</th><th>Positions</th><th>Ordres</th><th>Créé le</th><th></th></tr></thead>
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
            ? `<button class="filter-chip" data-admin-del="${u.id}" style="color:var(--negative);">Supprimer</button>` : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <div class="hint" style="margin-top:12px;color:var(--text-tertiary);font-size:11px;">
      ${users.length} compte(s). Le premier compte créé est administrateur ; un autre e-mail peut être promu via la variable d'environnement ADMIN_EMAIL. La suppression d'un utilisateur efface en cascade toutes ses données (budget, versements, positions, transactions).</div>`;

  el.querySelectorAll("[data-admin-del]").forEach(b =>
    b.addEventListener("click", async () => {
      const id = +b.dataset.adminDel;
      const u = users.find(x => x.id === id);
      const ok = await confirmModal({
        title: "Supprimer cet utilisateur",
        body: `Le compte <b>${esc(u.email)}</b> et toutes ses données (budget, ${u.positions} position(s), ${u.trades} ordre(s), ${fmtEur(u.deposited)} versés) seront définitivement supprimés.`,
        warning: "Cette action est <b>irréversible</b>.",
        checkLabel: "Je confirme la suppression définitive de ce compte.",
        confirmText: "Supprimer",
      });
      if (!ok) return;
      try {
        const res = await API.request("DELETE", "/api/admin/users/" + id);
        toast("Utilisateur supprimé ✓", "success");
        drawAdminUsers(res.users);
      } catch (e) {
        toast("Suppression impossible.", "error");
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
    renderAuth("login");
  }
})();
