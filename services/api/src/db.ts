// SQLite schema and migrations. Amounts are INTEGER minor units, checked by the schema. Times are ISO 8601 UTC text.
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export type Db = Database.Database

const amount = (col: string) => `${col} INTEGER NOT NULL CHECK (typeof(${col}) = 'integer' AND ${col} >= 0)`

/** Each entry upgrades the schema by one version. Never edit a shipped entry; append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    roles TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    tier INTEGER NOT NULL DEFAULT 0 CHECK (tier IN (0, 1)),
    business_name TEXT,
    fee_bps INTEGER,
    privy_user_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
    created_at TEXT NOT NULL,
    activated_at TEXT
  );
  CREATE INDEX users_email ON users (email);
  CREATE INDEX users_phone ON users (phone);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    public_key TEXT NOT NULL,
    privy_user_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    public_key TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE prepared_txs (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    kind TEXT NOT NULL,
    tx_json TEXT NOT NULL,
    unsigned_blob TEXT NOT NULL,
    signing_hash TEXT NOT NULL,
    last_ledger_sequence INTEGER,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    intent_id TEXT,
    ledger_hash TEXT,
    engine_result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX prepared_signing_hash ON prepared_txs (signing_hash);
  CREATE INDEX prepared_address ON prepared_txs (address, created_at);

  CREATE TABLE intents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT,
    ${amount('amount_minor')},
    ${amount('fee_minor')},
    note TEXT,
    payment_request_id TEXT,
    prepare_id TEXT,
    deposit_tx_hash TEXT UNIQUE,
    payout_tx_hash TEXT,
    ciphertext_preview TEXT,
    network TEXT NOT NULL DEFAULT 'devnet',
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT
  );
  CREATE INDEX intents_from ON intents (from_user_id, created_at);
  CREATE INDEX intents_to ON intents (to_user_id, created_at);
  CREATE INDEX intents_request ON intents (payment_request_id);

  CREATE TABLE payment_requests (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    ${amount('amount_minor')},
    reference TEXT,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    paid_at TEXT,
    intent_id TEXT,
    claimed_intent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX payment_requests_merchant ON payment_requests (merchant_id, paid_at);

  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    kind TEXT NOT NULL,
    counterparty_user_id TEXT,
    ${amount('amount_minor')},
    ${amount('fee_minor')},
    note TEXT,
    receipt_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, intent_id, direction)
  );
  CREATE INDEX activities_user ON activities (user_id, seq);

  CREATE TABLE balances (
    user_id TEXT PRIMARY KEY,
    ${amount('available_minor')},
    ${amount('pending_minor')},
    updated_at TEXT NOT NULL
  );

  -- Idempotency keys for effects ("<intentId>:received", ...). An effect runs only if its key inserts.
  CREATE TABLE effects (
    key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
  // 2: only an email Privy verified finds someone in the directory, and it finds one person.
  `
  ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1));
  CREATE UNIQUE INDEX users_verified_email ON users (lower(email)) WHERE status = 'active' AND email_verified = 1;
  ALTER TABLE sessions ADD COLUMN email TEXT;
  `,
  // 3: a top-up keeps its mint reference, so a restart can ask the pool worker again with the same one.
  `
  ALTER TABLE intents ADD COLUMN reference TEXT;
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

/** Opens (or adopts) a database and brings its schema up to date. ':memory:' for tests. */
export function openDb(target: string | Db = ':memory:'): Db {
  let db: Db
  if (typeof target === 'string') {
    if (target !== ':memory:') mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
    db = new Database(target)
    if (target !== ':memory:') db.pragma('journal_mode = WAL')
  } else {
    db = target
  }
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
