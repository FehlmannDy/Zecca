// Starts a cloudflared quick tunnel to localhost:<port>, detached, and prints its https URL.
// Files: .data/tunnel-<port>.log, .url, .pid. --stop stops only the tunnel named in our pid file.
// Run from zecca/ (unsandboxed): node node_modules/tsx/dist/cli.mjs scripts/tunnel.ts [--port 8800] [--stop]
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLOUDFLARED, cloudflaredArgs, extractTunnelUrl, isTunnelProcess, tunnelFiles } from './lib/tunnel'

const ZECCA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ZECCA, '.data')
const WAIT_MS = 60_000

const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const port = Number(portArg >= 0 ? argv[portArg + 1] : 8800)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('usage: tunnel.ts [--port <port>] [--stop]')
  process.exit(2)
}
const files = tunnelFiles(DATA, port)
const rel = (p: string) => path.relative(ZECCA, p)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The pid in our pid file, if it is still our cloudflared for this port. */
function runningPid(): number | null {
  if (!existsSync(files.pid)) return null
  const pid = Number(readFileSync(files.pid, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    return isTunnelProcess(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), port) ? pid : null
  } catch {
    return null
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stop(pid: number) {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s) // its own session and process group (setsid)
    } catch {
      try {
        process.kill(pid, s)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100)
  if (alive(pid)) signal('SIGKILL')
}

async function main() {
  mkdirSync(DATA, { recursive: true, mode: 0o700 })
  const existing = runningPid()

  if (argv.includes('--stop')) {
    if (existing) {
      await stop(existing)
      console.log(`stopped tunnel to localhost:${port} (pid ${existing})`)
    } else console.log(`no tunnel to localhost:${port} running`)
    rmSync(files.pid, { force: true })
    rmSync(files.url, { force: true })
    return
  }

  if (existing) {
    const url = existsSync(files.url) ? readFileSync(files.url, 'utf8').trim() : extractTunnelUrl(readFileSync(files.log, 'utf8'))
    if (url) {
      console.log(url)
      return
    }
    await stop(existing)
  }
  rmSync(files.url, { force: true })

  const log = openSync(files.log, 'w', 0o600)
  // setsid: own session, so it outlives this script and the terminal; nohup: ignores SIGHUP.
  const child = spawn('setsid', ['nohup', CLOUDFLARED, ...cloudflaredArgs(port)], { stdio: ['ignore', log, log] })
  closeSync(log)
  let exited: number | null | undefined
  child.on('exit', (code) => (exited = code))
  child.unref()
  if (!child.pid) throw new Error('could not start cloudflared')
  writeFileSync(files.pid, String(child.pid), { mode: 0o600 })

  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    const url = extractTunnelUrl(readFileSync(files.log, 'utf8'))
    if (url) {
      writeFileSync(files.url, url + '\n', { mode: 0o600 })
      console.log(url)
      return
    }
    if (exited !== undefined) {
      rmSync(files.pid, { force: true })
      throw new Error(`cloudflared exited (${exited}) before giving a URL; see ${rel(files.log)}`)
    }
    await sleep(250)
  }
  await stop(child.pid)
  rmSync(files.pid, { force: true })
  throw new Error(`no tunnel URL after ${WAIT_MS / 1000} s; see ${rel(files.log)}`)
}

main().catch((e) => {
  console.error(`tunnel: ${(e as Error).message}`)
  process.exit(1)
})
