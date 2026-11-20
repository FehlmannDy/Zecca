// Pure helpers for scripts/tunnel.ts (cloudflared quick tunnel).
import path from 'node:path'

export const CLOUDFLARED = '/usr/local/bin/cloudflared'

/** The quick-tunnel URL cloudflared prints once the tunnel exists, or null. api.trycloudflare.com is the control host, not a tunnel. */
export function extractTunnelUrl(log: string): string | null {
  for (const m of log.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) if (m[1] !== 'api') return m[0]
  return null
}

/** QUIC drops on the phone hotspot, so http2 (BUILD §7). */
export const cloudflaredArgs = (port: number) => ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${port}`]

/** True when a /proc/<pid>/cmdline (NUL-separated) is a cloudflared tunnel to this port; guards against killing a reused pid. */
export function isTunnelProcess(cmdline: string, port: number): boolean {
  const argv = cmdline.split('\0').filter(Boolean)
  if (!argv.length || path.basename(argv[0]) !== 'cloudflared') return false
  const i = argv.indexOf('--url')
  return i > 0 && argv[i + 1] === `http://localhost:${port}`
}

export const tunnelFiles = (dataDir: string, port: number) => ({
  log: path.join(dataDir, `tunnel-${port}.log`),
  url: path.join(dataDir, `tunnel-${port}.url`),
  pid: path.join(dataDir, `tunnel-${port}.pid`),
})
