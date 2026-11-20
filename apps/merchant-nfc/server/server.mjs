// Tiny mocked payment page: GET /pay/:id shows merchant, amount, a (mock) Pay button
// and a QR code of the same URL as fallback for phones without NFC.
// Env: PORT (default 3000), PUBLIC_BASE_URL (e.g. https://abc.trycloudflare.com) to force the QR URL.
import { createServer } from 'node:http';
import QRCode from 'qrcode';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');

const payments = new Map([
  ['demo', { merchant: 'Café du Lac', amount: '4.50', currency: 'CHF' }],
  ['tshirt', { merchant: 'IXH Merch Stand', amount: '25.00', currency: 'CHF' }],
]);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] ?? 'http';
  return `${proto}://${req.headers.host}`;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px;background:#f6f6f4;color:#1b1b1b;text-align:center}
main{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 4px #0002}
.merchant{font-size:1.1rem;color:#555}.amount{font-size:2.6rem;font-weight:700;margin:8px 0 20px}
button{width:100%;font-size:1.2rem;padding:14px;border:0;border-radius:12px;background:#1a5cff;color:#fff}
.qr svg{width:200px;height:200px}.small{font-size:.8rem;color:#777;word-break:break-all}
.ok{color:#137a2a;font-size:1.4rem;font-weight:700}
</style></head><body><main>${body}</main></body></html>`;
}

async function payPage(req, res, id) {
  const p = payments.get(id);
  if (!p) return send(res, 404, page('Not found', `<p>Unknown payment <b>${esc(id)}</b>.</p>`));
  const url = `${baseUrl(req)}/pay/${encodeURIComponent(id)}`;
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const action = `<form method="post" action="/pay/${encodeURIComponent(id)}"><button type="submit">Pay ${esc(p.currency)} ${esc(p.amount)}</button></form>`;
  send(res, 200, page(`Pay ${p.merchant}`, `
<div class="merchant">${esc(p.merchant)}</div>
<div class="amount">${esc(p.currency)} ${esc(p.amount)}</div>
${action}
<p class="small">No NFC? Scan this QR code:</p>
<div class="qr">${qr}</div>
<p class="small">${esc(url)}</p>`));
}

function send(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  console.log(new Date().toISOString(), req.method, pathname, '|', (req.headers['user-agent'] ?? '-').slice(0, 120));
  try {
    const m = pathname.match(/^\/pay\/([A-Za-z0-9_-]{1,64})\/?$/);
    if (m && req.method === 'GET') return await payPage(req, res, m[1]);
    if (m && req.method === 'POST') {
      const p = payments.get(m[1]);
      if (!p) return send(res, 404, page('Not found', '<p>Unknown payment.</p>'));
      // Mocked payment: no money moves, nothing is stored, so the page can be re-tested.
      return send(res, 200, page('Paid', `<div class="merchant">${esc(p.merchant)}</div>
<div class="amount">${esc(p.currency)} ${esc(p.amount)}</div><p class="ok">Paid (mock)</p>
<p><a href="/pay/${m[1]}">Back</a></p>`));
    }
    if (pathname === '/' && req.method === 'GET') {
      const links = [...payments.keys()].map((id) => `<li><a href="/pay/${id}">/pay/${id}</a></li>`).join('');
      return send(res, 200, page('NFC PayLink', `<p>Demo payments:</p><ul style="text-align:left">${links}</ul>`));
    }
    send(res, 404, page('Not found', '<p>Not found.</p>'));
  } catch (err) {
    console.error(err);
    send(res, 500, page('Error', '<p>Server error.</p>'));
  }
});

server.listen(PORT, () => console.log(`nfc-paylink server on http://0.0.0.0:${PORT}  (try /pay/demo)`));
