// Browser-only API for the GitHub Pages build: the server's routes, run in the page,
// on the same engine, gate, mandate and agent modules. State lives in localStorage,
// seeded with a real session recorded against the PayPal sandbox.
import { createEngine, judgeDirectOrder } from './core/engine.mjs';
import { runErrand } from './core/agent.mjs';
import { MERCHANTS, search } from './core/catalog.mjs';
import { CATEGORIES } from './core/mandate.mjs';
import { llmConfigured, llmModel, llmSettings, saveLlmSettings } from './core/llm.mjs';
import CONFIG from './config.mjs';

const STATE_KEY = 'allowance.state.v1';
const SIGN_KEY = 'allowance.signkey';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let api = null;
export async function handler() {
  if (api) return api;
  let S = null;
  try { S = JSON.parse(ls.get(STATE_KEY) || 'null'); } catch { S = null; }
  if (!S) S = await fetch('data/demo-session.json').then((r) => r.json()).catch(() => ({ mandates: {}, orders: [], asks: [], runs: {} }));
  for (const k of ['mandates', 'orders', 'asks', 'runs']) S[k] ||= k === 'mandates' || k === 'runs' ? {} : [];
  let key = ls.get(SIGN_KEY);
  if (!key) { key = crypto.randomUUID() + crypto.randomUUID(); ls.set(SIGN_KEY, key); }
  let t = null;
  const store = { state: S, save: () => { clearTimeout(t); t = setTimeout(() => ls.set(STATE_KEY, JSON.stringify(S)), 150); } };
  // Recorded mandates were signed by the server's key; re-sign them with this browser's key
  // so the replayed session stays usable here. Their PayPal ids are kept as recorded.
  const engine = createEngine({ store, key });
  const { sign } = await import('./core/mandate.mjs');
  for (const m of Object.values(S.mandates)) if (m.recorded && !m.resigned) { const s = sign(m.policy, key); m.sig = s.sig; m.resigned = true; }

  function startRun({ mandate_id, task, condition = 'gated' }) {
    const m = S.mandates[mandate_id];
    if (!m) throw new Error('No such mandate');
    const id = 'run_' + crypto.randomUUID().slice(0, 8);
    const run = { id, mandate_id, task: String(task).slice(0, 500), condition, status: 'running', created_at: new Date().toISOString(), events: [], shadow: [], model: llmConfigured() ? llmModel() : 'scripted' };
    S.runs[id] = run;
    const emit = (e) => { run.events.push({ t: Date.now(), ...e }); store.save(); };
    const shadowLedger = S.orders.filter((o) => new Date(o.created_at).getTime() < Date.now() - 10 * 60e3);
    const hooks = {
      emit,
      onPropose: async (args) => {
        const out = await engine.propose(mandate_id, args, { runId: id, task: run.task });
        const ref = (String(out).match(/order (ALW-\w+)/) || [])[1];
        const o = S.orders.find((x) => x.ref === ref);
        if (o?.paypal?.capture_id?.startsWith('SIM-')) o.paypal.simulated = true;
        return out;
      },
      onDirectOrder: async (args) => {
        const j = judgeDirectOrder(args, m, { key, ledger: shadowLedger });
        const sid = 'SHADOW' + crypto.randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase();
        shadowLedger.push({ mandate_id: m.id, total: j.charged, status: 'paid', created_at: new Date().toISOString(), hash: j.result.hash });
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

  const routes = [
    ['GET', /^\/config$/, () => ({ static: true, paypal_client_id: CONFIG.paypal_client_id, paypal_env: 'sandbox', paypal: true, mode: 'hold (Pages)', llm: llmConfigured(), model: llmConfigured() ? llmModel() : 'scripted (add your key)', merchants: Object.values(MERCHANTS), categories: CATEGORIES })],
    ['GET', /^\/llm$/, () => { const s = llmSettings(); return { configured: !!s.apiKey, model: llmModel(), baseURL: s.baseURL || '' }; }],
    ['POST', /^\/llm$/, (b) => { saveLlmSettings({ apiKey: String(b.apiKey || '').trim(), model: String(b.model || '').trim() || undefined, baseURL: String(b.baseURL || '').trim() || undefined }); return { ok: true }; }],
    ['POST', /^\/mandates\/compile$/, (b) => engine.compile(String(b.text || '').slice(0, 1200))],
    ['POST', /^\/mandates$/, async (b) => engine.mandateView(await engine.createMandate(b.policy, b.text))],
    ['GET', /^\/mandates$/, () => Object.values(S.mandates).map(engine.mandateView).reverse()],
    // Hold: created and authorized in the browser by the PayPal JS SDK (app.js); the page records it.
    ['POST', /^\/mandates\/(\w+)\/hold$/, (b, [, id]) => { const m = S.mandates[id]; return { client: true, amount: m.policy.budget.toFixed(2), reference_id: m.id, description: `Allowance mandate: ${m.policy.purpose}`.slice(0, 127) }; }],
    ['POST', /^\/mandates\/(\w+)\/fund$/, (b, [, id]) => {
      const m = S.mandates[id]; if (!m) throw new Error('No such mandate');
      Object.assign(m.funding, { mode: 'hold', status: 'funded', hold_order_id: b.order_id, authorization_id: b.authorization_id, expires: b.expires, client: true });
      store.save(); return engine.mandateView(m);
    }],
    ['POST', /^\/errands$/, (b) => ({ id: startRun(b).id })],
    ['GET', /^\/runs\/(\w+)$/, (b, [, id], q) => { const r = S.runs[id]; if (!r) throw new Error('No such run'); const since = Number(q.get('since') || 0); return { ...r, events: r.events.slice(since), next: r.events.length, orders: S.orders.filter((o) => o.run_id === id) }; }],
    ['GET', /^\/runs$/, () => Object.values(S.runs).map(({ events, ...r }) => r).sort((a, b) => b.created_at.localeCompare(a.created_at))],
    ['GET', /^\/orders$/, () => S.orders],
    ['GET', /^\/asks$/, () => S.asks.map((a) => ({ ...a, order: S.orders.find((o) => o.ref === a.order_ref) }))],
    ['POST', /^\/asks\/([\w-]+)\/order$/, (b, [, id]) => { const a = S.asks.find((x) => x.id === id); const o = S.orders.find((x) => x.ref === a.order_ref); return { client: true, reference_id: o.ref, total: o.total, lines: o.lines, merchant_name: o.merchant_name }; }],
    // Owner approved in PayPal Checkout; the JS SDK captured it in the browser.
    ['POST', /^\/asks\/([\w-]+)\/approved$/, (b, [, id]) => {
      const a = S.asks.find((x) => x.id === id); if (!a || a.status !== 'open') throw new Error('Ask is not open');
      const o = S.orders.find((x) => x.ref === a.order_ref);
      o.paypal = { order_id: b.order_id, capture_id: b.capture_id, status: b.status, client: true };
      o.status = b.status === 'COMPLETED' ? 'paid' : 'failed'; o.paid_at = new Date().toISOString(); o.approved_by = 'owner';
      a.status = 'approved'; a.paypal_order_id = b.order_id; a.closed_at = o.paid_at;
      store.save(); return o;
    }],
    ['POST', /^\/asks\/([\w-]+)\/decline$/, (b, [, id]) => engine.askDecline(id)],
    ['POST', /^\/orders\/([\w-]+)\/aftercare$/, (b, [, ref]) => engine.aftercare(ref, String(b.complaint || '').slice(0, 400))],
    ['GET', /^\/reconcile$/, () => ({ simulated: true, note: 'Reconciliation calls PayPal transaction search, which needs the server.' })],
    ['GET', /^\/search$/, (b, m, q) => search(q.get('q'))],
    ['GET', /^\/eval$/, () => fetch('data/eval-results.json').then((r) => r.json())],
    ['POST', /^\/reset$/, () => { try { localStorage.removeItem(STATE_KEY); } catch { /* ignore */ } return { ok: true }; }],
  ];

  api = async (method, path, body) => {
    const u = new URL(path, 'http://x');
    for (const [m, re, fn] of routes) {
      const hit = u.pathname.match(re);
      if (hit && m === method) return fn(body || {}, hit, u.searchParams);
    }
    throw new Error('Not found: ' + method + ' ' + path);
  };
  return api;
}
