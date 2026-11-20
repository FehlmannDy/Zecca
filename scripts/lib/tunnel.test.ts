import { describe, expect, it } from 'vitest'
import { cloudflaredArgs, extractTunnelUrl, isTunnelProcess, tunnelFiles } from './tunnel'

// Shape of a real cloudflared quick-tunnel log (URL replaced by a made-up one).
const LOG = `2026-11-20T17:31:56Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
2026-11-20T17:31:56Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-20T17:32:02Z INF +--------------------------------------------------------------------------------------------+
2026-11-20T17:32:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-20T17:32:02Z INF |  https://made-up-words-for-tests.trycloudflare.com                                          |
2026-11-20T17:32:02Z INF +--------------------------------------------------------------------------------------------+
2026-11-20T17:32:02Z INF Version 2026.10.0
2026-11-20T17:32:02Z INF Settings: map[ha-connections:1 no-autoupdate:true protocol:http2 url:http://localhost:8800]
`

describe('tunnel helpers', () => {
  it('extracts the quick-tunnel URL from the log', () => {
    expect(extractTunnelUrl(LOG)).toBe('https://made-up-words-for-tests.trycloudflare.com')
  })
  it('returns null until the URL is in the log, and ignores the API host', () => {
    expect(extractTunnelUrl(LOG.split('\n').slice(0, 3).join('\n'))).toBeNull()
    expect(extractTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBeNull()
    expect(extractTunnelUrl('')).toBeNull()
  })
  it('builds the cloudflared arguments (http2, no autoupdate)', () => {
    expect(cloudflaredArgs(8800)).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://localhost:8800'])
  })
  it('recognises only our own tunnel process for that port', () => {
    const cmd = (...a: string[]) => a.join('\0') + '\0'
    expect(isTunnelProcess(cmd('/usr/local/bin/cloudflared', ...cloudflaredArgs(8800)), 8800)).toBe(true)
    expect(isTunnelProcess(cmd('/usr/local/bin/cloudflared', ...cloudflaredArgs(3001)), 8800)).toBe(false)
    expect(isTunnelProcess(cmd('/usr/bin/node', 'server.js', '--url', 'http://localhost:8800'), 8800)).toBe(false)
    expect(isTunnelProcess('', 8800)).toBe(false)
  })
  it('names the per-port files under the data folder', () => {
    expect(tunnelFiles('/x/.data', 8800)).toEqual({ log: '/x/.data/tunnel-8800.log', url: '/x/.data/tunnel-8800.url', pid: '/x/.data/tunnel-8800.pid' })
  })
})
