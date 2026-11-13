// Utilidades para las pruebas en navegador: servidor local, Google simulado y ayudas.
// Ejecutar con: node tests/run.js   (necesita Playwright con Chromium)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, () => resolve({ srv, url: `http://localhost:${srv.address().port}/` }));
  });
}

/** Google simulado: inicio de sesión y Drive (carpeta de la app) por usuario. */
function fakeCloud(user = 'ana') {
  return { user, drives: {}, log: [], n: 0, failUserinfo: false, failDelete: 0, delayMs: 0 };
}

async function context(browser, app, cloud = null) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  if (!cloud) return ctx;
  await ctx.route(app + 'config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={googleClientId:'test-client'};" }));
  await ctx.route('https://accounts.google.com/**', (r) => {
    const u = new URL(r.request().url());
    cloud.log.push('auth ' + u.searchParams.get('prompt'));
    r.fulfill({ status: 302, headers: { location: u.searchParams.get('redirect_uri') + '#access_token=tok:' + cloud.user + '&expires_in=3600&state=' + u.searchParams.get('state') } });
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const api = async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const user = (req.headers().authorization || '').replace('Bearer tok:', '');
    const json = (o, status = 200) => r.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    cloud.log.push(`${req.method()} ${u.pathname}`);
    if (u.pathname === '/revoke') return json({});
    if (!user) return json({ error: 'unauth' }, 401);
    if (u.pathname === '/oauth2/v3/userinfo') return cloud.failUserinfo ? json({ error: 'x' }, 503) : json({ email: user + '@gmail.com' });
    const files = (cloud.drives[user] ||= []);
    if (u.pathname === '/drive/v3/files') {
      if (u.searchParams.get('spaces') !== 'appDataFolder') return json({ error: 'scope' }, 403);
      return json({ files: files.slice().reverse().map((f) => ({ id: f.id })) });
    }
    if (u.pathname.startsWith('/drive/v3/files/') && req.method() === 'DELETE') {
      if (cloud.failDelete) { cloud.failDelete--; return json({ error: 'fail' }, 500); }
      const id = decodeURIComponent(u.pathname.split('/').pop());
      cloud.drives[user] = files.filter((f) => f.id !== id);
      return r.fulfill({ status: 204, headers: cors });
    }
    if (u.pathname.startsWith('/drive/v3/files/')) {
      if (cloud.delayMs) await new Promise((res) => setTimeout(res, cloud.delayMs));
      const f = files.find((x) => x.id === decodeURIComponent(u.pathname.split('/').pop()));
      return f ? r.fulfill({ status: 200, headers: cors, body: f.content }) : json({ error: 'nf' }, 404);
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
      const boundary = req.headers()['content-type'].split('boundary=')[1];
      const parts = req.postData().split('--' + boundary);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      if (JSON.stringify(meta.parents) !== '["appDataFolder"]') return json({ error: 'parents' }, 400);
      const f = { id: 'f' + (++cloud.n), content: parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '') };
      files.push(f);
      return json({ id: f.id });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && req.method() === 'PATCH') {
      const f = files.find((x) => x.id === u.pathname.split('/').pop());
      f.content = req.postData();
      return json({ id: f.id });
    }
    return json({ error: 'unknown ' + u.pathname }, 404);
  };
  await ctx.route('https://www.googleapis.com/**', api);
  await ctx.route('https://oauth2.googleapis.com/**', api);
  return ctx;
}

async function open(ctx, app, opts = {}) {
  const p = await ctx.newPage(opts);
  p.errs = []; p.csp = []; p.dialogs = [];
  p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) p.csp.push(m.text()); else if (m.type() === 'error' && !/status of (4|5)\d\d/.test(m.text())) p.errs.push(m.text()); });
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.answer = () => true;
  p.on('dialog', (d) => { p.dialogs.push(d.message()); return p.answer(d.message()) ? d.accept() : d.dismiss(); });
  await p.goto(app);
  return p;
}

const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mis-finanzas-v1') || '{"transactions":[],"goals":[],"settings":{}}'));
const synced = (p) => p.waitForFunction(() => document.querySelector('#sync-pill').dataset.status === 'ok', null, { timeout: 15000 });
async function addTx(p, desc, amount = '5') {
  await p.click('[data-view=movimientos]');
  await p.fill('#tx-form [name=amount]', amount);
  await p.fill('#tx-form [name=description]', desc);
  await p.click('#tx-submit');
}
async function visitAll(p) {
  for (const v of ['resumen', 'anual', 'movimientos', 'ahorro', 'ajustes']) { await p.click(`[data-view=${v}]`); await p.waitForTimeout(120); }
}

module.exports = { pw, serve, fakeCloud, context, open, stored, synced, addTx, visitAll, ROOT };
