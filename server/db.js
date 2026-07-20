import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "finwise.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  cash          REAL NOT NULL DEFAULT 0,
  onboarded     INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_income REAL NOT NULL,
  housing        REAL NOT NULL DEFAULT 0,
  daily_life     REAL NOT NULL DEFAULT 0,
  subscriptions  REAL NOT NULL DEFAULT 0,
  invest_pct     REAL NOT NULL DEFAULT 0,
  dca_mode       TEXT NOT NULL DEFAULT 'dca',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_amount   REAL NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1,
  last_executed_at TEXT
);

CREATE TABLE IF NOT EXISTS deposits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount         REAL NOT NULL,
  type           TEXT NOT NULL,               -- 'monthly' | 'oneoff'
  pct_of_income  REAL,
  over_threshold INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol   TEXT NOT NULL,
  name     TEXT,
  sector   TEXT,
  country  TEXT,
  asset_class TEXT DEFAULT 'stock',
  shares   REAL NOT NULL,
  avg_cost REAL NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,                   -- 'buy' | 'sell'
  qty        REAL NOT NULL,
  price      REAL NOT NULL,
  total      REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* soft migration: adds asset_class to databases created before v1.1 */
try { db.exec("ALTER TABLE holdings ADD COLUMN asset_class TEXT DEFAULT 'stock'"); } catch { /* already present */ }
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch { /* already present */ }

/* ---------- users ---------- */
export const insertUser = db.prepare(
  "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)"
);
export const findUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
// never expose password_hash to the client
export const findUserById = db.prepare(
  "SELECT id, email, name, cash, onboarded, role, created_at FROM users WHERE id = ?"
);
export const setOnboarded = db.prepare("UPDATE users SET onboarded = 1 WHERE id = ?");
export const updateCash = db.prepare("UPDATE users SET cash = cash + ? WHERE id = ?");

/* ---------- account management ---------- */
export const findUserAuthById = db.prepare("SELECT * FROM users WHERE id = ?"); // internal use (hash included)
export const updateUserProfile = db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?");
export const updatePasswordHash = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
export const setUserRole = db.prepare("UPDATE users SET role = ? WHERE id = ?");
export const deleteUserById = db.prepare("DELETE FROM users WHERE id = ?"); // cascades across all related tables

/* ---------- admin ---------- */
export const listUsers = db.prepare(`
  SELECT u.id, u.email, u.name, u.cash, u.onboarded, u.role, u.created_at,
    (SELECT COUNT(*) FROM holdings h WHERE h.user_id = u.id)                 AS positions,
    (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id)             AS trades,
    (SELECT COALESCE(SUM(amount), 0) FROM deposits d WHERE d.user_id = u.id) AS deposited
  FROM users u ORDER BY u.id
`);
export const countUsers = db.prepare("SELECT COUNT(*) AS n FROM users");

/* ---------- budget ---------- */
export const getBudget = db.prepare("SELECT * FROM budgets WHERE user_id = ?");
export const upsertBudget = db.prepare(`
  INSERT INTO budgets (user_id, monthly_income, housing, daily_life, subscriptions, invest_pct, dca_mode, updated_at)
  VALUES (@user_id, @monthly_income, @housing, @daily_life, @subscriptions, @invest_pct, @dca_mode, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET
    monthly_income = excluded.monthly_income,
    housing        = excluded.housing,
    daily_life     = excluded.daily_life,
    subscriptions  = excluded.subscriptions,
    invest_pct     = excluded.invest_pct,
    dca_mode       = excluded.dca_mode,
    updated_at     = datetime('now')
`);

/* ---------- recurring plan ---------- */
export const getPlan = db.prepare("SELECT * FROM plans WHERE user_id = ?");
export const upsertPlan = db.prepare(`
  INSERT INTO plans (user_id, monthly_amount, active) VALUES (?, ?, 1)
  ON CONFLICT(user_id) DO UPDATE SET monthly_amount = excluded.monthly_amount, active = 1
`);
export const deactivatePlan = db.prepare("UPDATE plans SET active = 0 WHERE user_id = ?");
export const markPlanExecuted = db.prepare(
  "UPDATE plans SET last_executed_at = datetime('now') WHERE user_id = ?"
);

/* ---------- deposits ---------- */
export const insertDeposit = db.prepare(
  "INSERT INTO deposits (user_id, amount, type, pct_of_income, over_threshold) VALUES (?, ?, ?, ?, ?)"
);
export const getDeposits = db.prepare(
  "SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 30"
);

/* ---------- portfolio ---------- */
export const getHoldings = db.prepare(
  "SELECT * FROM holdings WHERE user_id = ? ORDER BY symbol"
);
export const getTransactions = db.prepare(
  "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50"
);

const getHolding = db.prepare("SELECT * FROM holdings WHERE user_id = ? AND symbol = ?");
const getUserRow = db.prepare("SELECT * FROM users WHERE id = ?");
const setCash = db.prepare("UPDATE users SET cash = ? WHERE id = ?");
const upsertHolding = db.prepare(`
  INSERT INTO holdings (user_id, symbol, name, sector, country, asset_class, shares, avg_cost)
  VALUES (@user_id, @symbol, @name, @sector, @country, @asset_class, @shares, @avg_cost)
  ON CONFLICT(user_id, symbol) DO UPDATE SET
    shares = excluded.shares, avg_cost = excluded.avg_cost,
    name = excluded.name, sector = excluded.sector, country = excluded.country,
    asset_class = excluded.asset_class
`);
const deleteHolding = db.prepare("DELETE FROM holdings WHERE user_id = ? AND symbol = ?");
const insertTx = db.prepare(
  "INSERT INTO transactions (user_id, symbol, side, qty, price, total) VALUES (?, ?, ?, ?, ?, ?)"
);

/**
 * Atomic order execution. Throws INSUFFICIENT_CASH / INSUFFICIENT_SHARES.
 * The price always comes from the server-side quote, never from the client.
 */
export const runOrderTx = db.transaction((userId, symbol, side, qty, price, meta) => {
  const user = getUserRow.get(userId);
  const total = +(price * qty).toFixed(2);
  const held = getHolding.get(userId, symbol);

  if (side === "buy") {
    if (user.cash < total) throw new Error("INSUFFICIENT_CASH");
    setCash.run(+(user.cash - total).toFixed(2), userId);
    const newShares = Math.round(((held?.shares || 0) + qty) * 1e6) / 1e6; // avoids float drift
    const newAvg = held
      ? ((held.avg_cost * held.shares) + total) / newShares
      : price;
    upsertHolding.run({
      user_id: userId, symbol,
      name: meta?.name || held?.name || symbol,
      sector: meta?.sector || held?.sector || "Other",
      country: meta?.country || held?.country || "—",
      asset_class: meta?.assetClass || held?.asset_class || "stock",
      shares: newShares, avg_cost: +newAvg.toFixed(4),
    });
  } else {
    if (!held || held.shares < qty) throw new Error("INSUFFICIENT_SHARES");
    setCash.run(+(user.cash + total).toFixed(2), userId);
    const remaining = +(held.shares - qty).toFixed(6);
    if (remaining <= 0) deleteHolding.run(userId, symbol);
    else upsertHolding.run({ ...held, user_id: userId, shares: remaining });
  }
  insertTx.run(userId, symbol, side, qty, price, total);
});

export default db;
