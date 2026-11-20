// Local resolver hangs/fails for some hosts on this machine; resolve via 8.8.8.8 / system stub / 1.1.1.1 first, then system.
const dns = require('node:dns')
const orig = dns.lookup
const r = new dns.Resolver({ timeout: 3000, tries: 2 }); r.setServers(['8.8.8.8', '127.0.0.53', '1.1.1.1'])
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  if (typeof opts === 'number') opts = { family: opts }
  r.resolve4(host, (e, addrs) => {
    if (e || !addrs?.length) return orig.call(dns, host, opts, cb)
    opts?.all ? cb(null, addrs.map(a => ({ address: a, family: 4 }))) : cb(null, addrs[0], 4)
  })
}
