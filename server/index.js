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

// Sanity check: without these files, the page would be blank. Fail loudly and clearly.
import fs from "fs";
for (const f of ["index.html", "css/app.css", "js/api.js", "js/app.js"]) {
  if (!fs.existsSync(path.join(PUBLIC_DIR, f))) {
    console.error(`✗ Missing frontend file: public/${f}`);
    console.error("  Expected structure: finwise/{package.json, server/, public/{index.html, css/app.css, js/api.js, js/app.js}}");
    console.error("  Run `npm start` from the folder containing package.json, after extracting the full zip.");
    process.exit(1);
  }
}

/* Default admin account (demo / presentation).
   ⚠ In production: change this password from "My Account"
   or disable creation with SEED_ADMIN=false in .env. */
if (process.env.SEED_ADMIN !== "false") {
  const SEED_EMAIL = "admin@admin.com";
  if (!findUserByEmail.get(SEED_EMAIL)) {
    const info = insertUser.run(SEED_EMAIL, bcrypt.hashSync("admin", 12), "Admin");
    setUserRole.run("admin", info.lastInsertRowid);
    console.log("✓ Admin account created: admin@admin.com / admin  (remember to change this password)");
  }
}

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      // https: is required for news thumbnails (images from various third-party
      // sources — press, agencies); a fixed domain cannot be whitelisted.
      imgSrc: ["'self'", "data:", "https:"],
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
// SPA fallback: any GET request outside /api serves the shell —
// except for files (.css, .js, images…): a missing asset must return
// a clean 404, not HTML (otherwise a silent blank page in the browser).
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
    : "✓ Live market data via Finnhub." + (process.env.TWELVEDATA_API_KEY ? " + Twelve Data (Europe/Asie)." : ""));
  const engine = process.env.ANTHROPIC_API_KEY ? "Anthropic (Claude)"
    : process.env.GEMINI_API_KEY ? "Google Gemini"
      : null;
  console.log(engine
    ? `✓ AI Agent powered by ${engine}.`
    : "⚠ No ANTHROPIC_API_KEY / GEMINI_API_KEY — agent running in rules mode.");
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} is already in use — another server is running on it.`);
    console.error("  → macOS/Linux: lsof -ti :" + PORT + " | xargs kill    then restart npm start");
    console.error("  → or change the port: PORT=3001 npm start");
    process.exit(1);
  }
  throw err;
});