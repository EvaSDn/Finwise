import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

import bcrypt from "bcryptjs";
import { findUserByEmail, insertUser, setUserRole } from "./db.js";
import authRoutes from "./routes/auth.js";
import budgetRoutes from "./routes/budget.js";
import portfolioRoutes from "./routes/portfolio.js";
import marketRoutes from "./routes/market.js";
import miscRoutes from "./routes/misc.js";
import accountRoutes from "./routes/account.js";
import adminRoutes from "./routes/admin.js";
import { DEMO_MODE } from "./services/market.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Sanity check : sans ces fichiers, la page serait blanche. On échoue fort et clair.
import fs from "fs";
for (const f of ["index.html", "css/app.css", "js/api.js", "js/app.js"]) {
  if (!fs.existsSync(path.join(PUBLIC_DIR, f))) {
    console.error(`✗ Fichier frontend manquant : public/${f}`);
    console.error("  Structure attendue : finwise/{package.json, server/, public/{index.html, css/app.css, js/api.js, js/app.js}}");
    console.error("  Lancez `npm start` depuis le dossier qui contient package.json, après avoir extrait TOUT le zip.");
    process.exit(1);
  }
}

/* Compte administrateur par défaut (démo / soutenance).
   ⚠ En production : changez ce mot de passe depuis « Mon compte »
   ou désactivez la création avec SEED_ADMIN=false dans .env. */
if (process.env.SEED_ADMIN !== "false") {
  const SEED_EMAIL = "admin@admin.com";
  if (!findUserByEmail.get(SEED_EMAIL)) {
    const info = insertUser.run(SEED_EMAIL, bcrypt.hashSync("admin", 12), "Admin");
    setUserRole.run("admin", info.lastInsertRowid);
    console.log("✓ Compte admin créé : admin@admin.com / admin  (pensez à changer ce mot de passe)");
  }
}

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/budget", budgetRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", miscRoutes);

app.use(express.static(PUBLIC_DIR));
// SPA fallback : toute requête GET hors API sert la coquille —
// sauf pour les fichiers (.css, .js, images…) : un asset manquant doit renvoyer
// un 404 net, pas du HTML (sinon page blanche silencieuse côté navigateur).
app.get(/^\/(?!api\/).*/, (req, res) => {
  if (path.extname(req.path)) return res.status(404).send("Not found: " + req.path);
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Central error handler — no stack traces leak to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "INTERNAL" });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Finwise running on http://localhost:${PORT}`);
  console.log(DEMO_MODE
    ? "⚠ DEMO MODE: no FINNHUB_API_KEY set — simulated market data & news."
    : "✓ Live market data via Finnhub.");
  const engine = process.env.ANTHROPIC_API_KEY ? "Anthropic (Claude)"
    : process.env.GEMINI_API_KEY ? "Google Gemini"
    : null;
  console.log(engine
    ? `✓ Agent IA propulsé par ${engine}.`
    : "⚠ Aucune clé ANTHROPIC_API_KEY / GEMINI_API_KEY — agent en mode règles.");
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Le port ${PORT} est déjà utilisé — un autre serveur tourne dessus.`);
    console.error("  → macOS/Linux : lsof -ti :" + PORT + " | xargs kill    puis relancez npm start");
    console.error("  → ou changez de port : PORT=3001 npm start");
    process.exit(1);
  }
  throw err;
});
