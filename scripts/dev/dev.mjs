#!/usr/bin/env node
// One command for local work: API (with the pool worker) on :8800 and the web on :3100.
// Loads .env if present. The DNS preload (dnsfix.cjs) is a workaround for this laptop only and is never in product code.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dnsfix = path.join(root, 'scripts/dev/dnsfix.cjs')
const envFile = path.join(root, '.env')
const envArgs = existsSync(envFile) ? [`--env-file=${envFile}`] : []
const nodeOpts = `--require=${dnsfix}`

const procs = [
  {
    name: 'api',
    cmd: process.execPath,
    args: [...envArgs, path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', path.join(root, 'services/api/src/server.ts')],
    // tsx runs the file in a child process: a -r on the wrapper does not reach it, NODE_OPTIONS does (and the pool thread inherits it).
    env: { NODE_OPTIONS: nodeOpts },
  },
  {
    name: 'web',
    cmd: process.execPath,
    args: [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--port', process.env.WEB_PORT ?? '3100'],
    cwd: path.join(root, 'apps/web'),
    env: { NODE_OPTIONS: nodeOpts },
  },
]

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: p.cwd ?? root, env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = `[${p.name}]`.padEnd(6)
  for (const s of [child.stdout, child.stderr]) s.on('data', (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag + ' ')))
  child.on('exit', (code) => {
    console.log(`${tag} exited with ${code}`)
    shutdown(code ?? 1)
  })
  return child
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
