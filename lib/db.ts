import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const g = globalThis as unknown as { __db?: Database.Database };

function open() {
  mkdirSync('data', { recursive: true });
  const db = new Database(process.env.DB_PATH ?? 'data/zecca.db');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS terminals (
      key TEXT PRIMARY KEY, merchant TEXT NOT NULL, label TEXT);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, card_id INTEGER NOT NULL,
      terminal_key TEXT NOT NULL, merchant TEXT NOT NULL, drops INTEGER NOT NULL,
      status TEXT NOT NULL, hash TEXT, reason TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (flow_id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, name TEXT, expires INTEGER NOT NULL);
  `);
  try { db.exec('ALTER TABLE cards ADD COLUMN user_id TEXT'); } catch { /* column already there */ }
  // ponytail: no daily_spend table; the daily total is a SUM over payments (see spentToday). Add a table if payments grows huge.
  if (process.env.TERMINAL_KEY && process.env.MERCHANT_ADDRESS)
    db.prepare('INSERT OR REPLACE INTO terminals(key, merchant, label) VALUES (?, ?, ?)')
      .run(process.env.TERMINAL_KEY, process.env.MERCHANT_ADDRESS, 'default');
  return db;
}

export const db = () => (g.__db ??= open());

export type Card = { id: number; token: string; address: string; status: 'active' | 'revoked'; user_id: string | null };
export type Payment = { id: number; request_id: string; status: 'pending' | 'paid' | 'failed'; hash: string | null; reason: string | null; drops: number; merchant: string; created_at: number };

export const cardByToken = (t: string) => db().prepare('SELECT * FROM cards WHERE token = ?').get(t) as Card | undefined;
export const terminalByKey = (k: string) => db().prepare('SELECT * FROM terminals WHERE key = ?').get(k) as { key: string; merchant: string } | undefined;
export const paymentByRequest = (r: string) => db().prepare('SELECT * FROM payments WHERE request_id = ?').get(r) as Payment | undefined;

/** Paid + in-flight drops for this card since 00:00 UTC (pending counted so parallel charges can't dodge the cap). */
export function spentToday(cardId: number): bigint {
  const start = new Date().setUTCHours(0, 0, 0, 0);
  const r = db().prepare("SELECT COALESCE(SUM(drops),0) AS s FROM payments WHERE card_id = ? AND status IN ('paid','pending') AND created_at >= ?").get(cardId, start) as { s: number };
  return BigInt(r.s);
}
