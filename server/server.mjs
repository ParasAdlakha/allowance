// Allowance server: API + static app + sandbox merchant storefronts.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from '../core/store.mjs';
import { createEngine, judgeDirectOrder } from '../core/engine.mjs';
import { runErrand } from '../core/agent.mjs';
import { MERCHANTS, PRODUCTS, search } from '../core/catalog.mjs';
import { CATEGORIES } from '../core/mandate.mjs';
import { llmConfigured, llmModel } from '../core/llm.mjs';
import { paymentMode, paypalConfigured } from '../core/paypal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 8787);
const KEY = process.env.MANDATE_SIGNING_KEY || 'dev-only-signing-key-change-me';
const store = createStore(join(ROOT, 'data', 'runtime', 'state.json'));
const engine = createEngine({ store, key: KEY });
const S = engine.state;

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.ico': 'image/x-icon' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 1e5) throw new Error('Body too large'); } return b ? JSON.parse(b) : {}; }

// ---- Errand runs -----------------------------------------------------------
function startRun({ mandate_id, task, condition = 'gated' }) {
  const m = engine.getMandate(mandate_id);
  if (!m) throw new Error('No such mandate');
  if (!['gated', 'rules', 'naive'].includes(condition)) throw new Error('Bad condition');
  const id = 'run_' + randomUUID().slice(0, 8);
  const run = { id, mandate_id, task: String(task).slice(0, 500), condition, status: 'running', created_at: new Date().toISOString(), events: [], shadow: [], model: llmConfigured() ? llmModel() : 'scripted' };
  S.runs[id] = run;
  const emit = (e) => { run.events.push({ t: Date.now(), ...e }); };
  const hooks = {
    emit,
    onPropose: (args) => engine.propose(mandate_id, args, { runId: id, task: run.task }),
    // Ungated "what if" runs never charge anyone: they record what a direct PayPal order would have done.
    onDirectOrder: async (args) => {
      const j = judgeDirectOrder(args, m, { key: KEY, ledger: S.orders });
      const sid = 'SHADOW' + randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase();
      run.shadow.push({ id: sid, charged: j.charged, authorized: j.authorized, payee: j.payee, merchant: j.result.cart?.merchant_name, lines: j.result.cart?.lines, rules: j.result.rules });
      return { id: sid, status: 'CREATED', note: 'Shadow order: not sent to PayPal in what-if mode.' };
    },
    onDirectPay: async (oid) => ({ id: oid, status: 'COMPLETED', note: 'Shadow capture (what-if mode, nothing charged).' }),
  };
  runErrand({ task: run.task, mandate: m, condition, hooks })
    .then((r) => { run.status = 'done'; run.report = r.report; })
    .catch((e) => { run.status = 'error'; run.error = e.message; emit({ type: 'error', text: e.message }); })
    .finally(() => store.save());
  return run;
}

// ---- Merchant storefront pages (what a browsing agent would read) ----------
function shopPage(mid) {
  const m = MERCHANTS[mid];
  if (!m) return null;
  const items = PRODUCTS.filter((p) => p.merchant === mid);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.name)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222;background:#fffdf8}h1{margin:0}small{color:#777}.p{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.price{font-weight:700}.note{margin-top:6px;white-space:pre-wrap;color:#555}.inj{background:#fff4e5;border-left:3px solid #f59e0b;padding:4px 8px}</style>
<h1>${esc(m.name)}</h1><small>Fictional sandbox merchant for the Allowance demo · payee ${esc(m.payee)} · category ${m.category.replace('_', ' ')}</small><p>${esc(m.blurb)}</p>
${items.map((p) => `<div class="p" id="${p.sku}"><b>${esc(p.name)}</b> <small>${p.sku}</small><div class="price">$${p.listed.toFixed(2)}${p.listed !== p.price ? ` <small>(checkout charges $${p.price.toFixed(2)})</small>` : ''}</div><div class="note">${p.page.split('\n').map((l) => /AI|agent|Assistant|payment directly/i.test(l) ? `<span class="inj">⚠ ${esc(l.replace(/<[^>]+>/g, ''))}</span>` : esc(l)).join('\n')}</div></div>`).join('')}
<p><a href="/app/">← back to Allowance</a></p>`;
}

// ---- Router ------------------------------------------------------------------
const routes = [
  ['GET', /^\/api\/config$/, async () => ({ paypal_client_id: process.env.PAYPAL_CLIENT_ID || null, paypal_env: process.env.PAYPAL_ENV || 'sandbox', paypal: paypalConfigured(), mode: await paymentMode(), llm: llmConfigured(), model: llmConfigured() ? llmModel() : 'scripted (no LLM key)', merchants: Object.values(MERCHANTS), categories: CATEGORIES })],
  ['POST', /^\/api\/mandates\/compile$/, async (req) => { const b = await body(req); return engine.compile(String(b.text || '').slice(0, 1200)); }],
  ['POST', /^\/api\/mandates$/, async (req) => { const b = await body(req); return engine.mandateView(await engine.createMandate(b.policy, b.text)); }],
  ['GET', /^\/api\/mandates$/, async () => Object.values(S.mandates).map(engine.mandateView).reverse()],
  ['POST', /^\/api\/mandates\/([\w]+)\/hold$/, async (req, [, id]) => engine.holdOrder(id)],
  ['POST', /^\/api\/mandates\/([\w]+)\/fund$/, async (req, [, id]) => { const b = await body(req); return engine.mandateView(await engine.fund(id, { orderId: b.order_id, setupTokenId: b.setup_token_id })); }],
  ['POST', /^\/api\/errands$/, async (req) => { const b = await body(req); const r = startRun(b); return { id: r.id }; }],
  ['GET', /^\/api\/runs\/([\w]+)$/, async (req, [, id], url) => { const r = S.runs[id]; if (!r) throw Object.assign(new Error('No such run'), { code: 404 }); const since = Number(url.searchParams.get('since') || 0); return { ...r, events: r.events.slice(since), next: r.events.length, orders: S.orders.filter((o) => o.run_id === id) }; }],
  ['GET', /^\/api\/runs$/, async () => Object.values(S.runs).map(({ events, ...r }) => r).reverse().slice(0, 50)],
  ['GET', /^\/api\/orders$/, async () => S.orders],
  ['GET', /^\/api\/asks$/, async () => S.asks.map((a) => ({ ...a, order: S.orders.find((o) => o.ref === a.order_ref) }))],
  ['POST', /^\/api\/asks\/([\w-]+)\/order$/, async (req, [, id]) => engine.askCreateOrder(id)],
  ['POST', /^\/api\/asks\/([\w-]+)\/approved$/, async (req, [, id]) => { const b = await body(req); return engine.askApproved(id, b.order_id); }],
  ['POST', /^\/api\/asks\/([\w-]+)\/decline$/, async (req, [, id]) => engine.askDecline(id)],
  ['POST', /^\/api\/orders\/([\w-]+)\/aftercare$/, async (req, [, ref]) => { const b = await body(req); return engine.aftercare(ref, String(b.complaint || '').slice(0, 400)); }],
  ['GET', /^\/api\/reconcile$/, async () => engine.reconcile()],
  ['GET', /^\/api\/search$/, async (req, m, url) => search(url.searchParams.get('q'))],
  ['GET', /^\/api\/eval$/, async () => JSON.parse(await readFile(join(ROOT, 'data', 'eval-results.json'), 'utf8').catch(() => '{}'))],
  ['GET', /^\/api\/health$/, async () => ({ ok: true })],
];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(req, m, url));
    }
    const shop = url.pathname.match(/^\/shop\/(\w+)\/?$/);
    if (shop) { const h = shopPage(shop[1]); return h ? send(res, 200, h, TYPES['.html']) : send(res, 404, 'Not found', 'text/plain'); }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, p.startsWith('/app/') ? 'public' : 'docs', p.replace(/^\/app\//, '/').replace(/\.\./g, ''));
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    const code = e.code === 'ENOENT' ? 404 : e.code === 404 ? 404 : e.status && e.status < 500 ? 400 : 500;
    send(res, code, { error: e.message, details: e.data?.details });
  }
}).listen(PORT, () => console.log(`Allowance on http://localhost:${PORT}/app/  (payments: ${process.env.PAYMENT_MODE || (paypalConfigured() ? 'PayPal sandbox' : 'simulated')}, model: ${llmConfigured() ? llmModel() : 'scripted'})`));
