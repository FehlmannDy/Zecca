// A disposable inbox on the public mail.tm API, for a throwaway Privy login (never a real or shared account).
// Network: run Node with -r scripts/dev/dnsfix.cjs, unsandboxed. mail.tm rate-limits (429): every call backs off.
const API = 'https://api.mail.tm'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(path, what, init = {}) {
  for (let attempt = 0, wait = 4000; ; attempt += 1, wait *= 2) {
    const res = await fetch(`${API}${path}`, init)
    if (res.status === 429 && attempt < 5) {
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`mail.tm ${what}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }
}

/** Creates a fresh address and returns it with a bearer token. The password stays in memory and is never printed. */
export async function createInbox(prefix = 'zecca') {
  const domains = await req('/domains', 'domains')
  const domain = domains['hydra:member'].find((d) => d.isActive && !d.isPrivate)?.domain
  if (!domain) throw new Error('mail.tm has no public domain right now')
  const address = `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}@${domain}`
  const password = crypto.randomUUID()
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }) }
  await req('/accounts', 'account', init)
  const { token } = await req('/token', 'token', init)
  return { address, token }
}

/** Polls the inbox for a message received after `since` and returns the first 6-digit code in it. */
export async function waitForCode(inbox, { since = 0, timeoutMs = 150_000, intervalMs = 4000 } = {}) {
  const init = { headers: { authorization: `Bearer ${inbox.token}` } }
  const seen = new Set()
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const list = await req('/messages', 'messages', init)
    for (const m of list['hydra:member'] ?? []) {
      if (seen.has(m.id) || Date.parse(m.createdAt) < since - 5000) continue
      seen.add(m.id)
      const full = await req(`/messages/${m.id}`, 'message', init)
      const text = [full.subject, full.intro, full.text, ...(Array.isArray(full.html) ? full.html : [full.html ?? ''])].join('\n').replace(/<[^>]+>/g, ' ')
      const code = text.match(/(?<![\d#])(\d{6})(?!\d)/)?.[1]
      if (code) return { code, from: full.from?.address, subject: full.subject }
    }
    await sleep(intervalMs)
  }
  throw new Error('No login code arrived in time')
}
