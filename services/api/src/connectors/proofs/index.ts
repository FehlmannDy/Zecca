// Proofs connector (SPEC §4.10, §6.3): POST /v1/disclosures builds a signed statement of the caller's own activity,
// GET /v1/disclosures/:id serves it publicly to whoever holds the id. Behind FEATURE_PROOFS (mount() answers 404 feature_off).
import type { Hono } from 'hono'
import type { Activity, Statement } from '@zecca/contracts'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { mount } from '../../http'
import { activityById, toActivity, type ActivityRow } from '../../books'
import { proveLine } from './amount-proof'
import { signStatement, statementKeyFrom, type UnsignedStatement } from './statement'

export { verifyStatement, canonicalJson, payloadOf } from './statement'
export { verifyAmountProof, parseAmountProof } from './amount-proof'

const PROOF_CONCURRENCY = 8
type StatementLine = Statement['lines'][number]

/** Who the other side is when there is no Zecca user on it. */
const NO_COUNTERPARTY: Record<string, string> = {
  welcome: 'Zecca demo credit',
  topup: 'Top up',
  card_load: 'Zecca card',
  earn_deposit: 'Earn',
  market_buy: 'Metals market',
  withdraw: 'Withdrawal',
}

function ensureTables(core: Core): void {
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS proof_statements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      statement_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proof_statements_user ON proof_statements (user_id, created_at);
  `)
}

function lineOf(a: Activity): StatementLine {
  return {
    activityId: a.id,
    date: a.at,
    counterparty: a.counterparty?.displayName ?? NO_COUNTERPARTY[a.kind] ?? 'External account',
    direction: a.direction,
    amountMinor: a.amountMinor,
    feeMinor: a.feeMinor,
    ...(a.ledger.depositTxHash ? { depositTxHash: a.ledger.depositTxHash } : {}),
    ...(a.ledger.payoutTxHash ? { payoutTxHash: a.ledger.payoutTxHash } : {}),
    network: a.ledger.network,
  }
}

async function withAmountProofs(core: Core, holderAddress: string, lines: StatementLine[]): Promise<StatementLine[]> {
  const ks = core.keystore
  if (!ks.has('pool') || !ks.hasWallet('pool')) return lines
  const deps = { ledger: core.ledger, poolAddress: ks.getWallet('pool').address, poolKey: ks.getElGamal('pool'), holderAddress }
  const out: StatementLine[] = []
  for (let k = 0; k < lines.length; k += PROOF_CONCURRENCY) {
    const chunk = lines.slice(k, k + PROOF_CONCURRENCY)
    const proofs = await Promise.all(chunk.map((l) => proveLine(deps, l)))
    chunk.forEach((l, j) => out.push(proofs[j] ? { ...l, amountProof: proofs[j] } : l))
  }
  return out
}

function statementKey(core: Core) {
  if (!core.keystore.hasWallet('kycIssuer')) {
    core.log.error('[proofs] the key store has no kycIssuer wallet; statements cannot be signed')
    throw Err.internal('Statements are not available right now. Try again later.')
  }
  return statementKeyFrom(core.keystore.getWallet('kycIssuer'))
}

export function mountProofs(app: Hono, core: Core): void {
  ensureTables(core)

  mount(app, core, 'disclosureCreate', async ({ user, body }) => {
    const me = user!
    core.rateLimit(`disclosure:${me.id}`)
    const rows: ActivityRow[] = []
    for (const id of new Set(body.activityIds)) {
      const row = activityById(core, id)
      if (!row || row.userId !== me.id) throw Err.notFound("One of these items isn't in your activity.")
      rows.push(row)
    }
    const acts = rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq).map((r) => toActivity(core, r))
    if (acts.some((a) => a.status !== 'done')) throw Err.conflict('Only completed payments can go on a statement.')

    const key = statementKey(core)
    const lines = await withAmountProofs(core, me.address, acts.map(lineOf))
    const unsigned: UnsignedStatement = {
      id: core.id('stm'),
      createdAt: core.iso(),
      holder: { displayName: me.displayName, handle: me.handle, address: me.address },
      lines,
      attestation: lines.every((l) => l.amountProof) ? 'proof' : 'zecca',
    }
    const statement = signStatement(unsigned, key)
    core.db
      .prepare('INSERT INTO proof_statements (id, user_id, statement_json, created_at) VALUES (?, ?, ?, ?)')
      .run(statement.id, me.id, JSON.stringify(statement), statement.createdAt)
    return { id: statement.id, url: `${core.settings.webOrigin}/statement/${statement.id}` }
  })

  mount(app, core, 'disclosureGet', ({ params }) => {
    const r = core.db.prepare('SELECT statement_json FROM proof_statements WHERE id = ?').get(params.id) as { statement_json: string } | undefined
    if (!r) throw Err.notFound('This statement does not exist.')
    return JSON.parse(r.statement_json) as Statement
  })
}

/** Startup work: the table (no submit or received handlers: a statement moves no money). */
export function registerProofs(core: Core): void {
  ensureTables(core)
}
