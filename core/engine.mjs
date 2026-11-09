// Orchestration: mandates, funding, the gate-then-pay path, owner asks,
// aftercare (tracking, refunds) and reconciliation.
import { randomUUID } from 'node:crypto';
import { normalize, parseFallback, sign, verify, COMPILE_PROMPT, describe, crossCheck } from './mandate.mjs';
import { check, feedback, spentInPeriod } from './gate.mjs';
import { product, merchant, PRODUCTS } from './catalog.mjs';
import { chat, llmConfigured, parseJson } from './llm.mjs';
import * as pp from './paypal.mjs';

const ref = () => 'ALW-' + randomUUID().slice(0, 8).toUpperCase();
const now = () => new Date().toISOString();

export function createEngine({ store, key }) {
  const S = store.state;
  const listeners = new Set();
  const notify = (ev) => { for (const l of listeners) { try { l(ev); } catch { /* ignore */ } } };

  async function compile(text) {
    if (!llmConfigured()) return { policy: parseFallback(text), source: 'rules' };
    try {
      const msg = await chat({ messages: [{ role: 'system', content: COMPILE_PROMPT }, { role: 'user', content: text }], json: true, temperature: 0 });
      const draft = normalize(parseJson(msg.content));
      const { policy, warnings } = crossCheck(draft, text);
      return { policy, draft, warnings, source: 'llm' };
    } catch (e) {
      return { policy: parseFallback(text), source: 'rules', warning: 'Model unavailable, used rule parser: ' + e.message };
    }
  }

  async function createMandate(rawPolicy, text) {
    const policy = normalize(rawPolicy);
    const m = sign(policy, key, 'owner');
    const mode = await pp.paymentMode();
    m.text = String(text || '').slice(0, 600);
    m.summary = describe(policy);
    m.funding = { mode, status: 'unfunded' };
    if (mode === 'simulated') m.funding = { mode, status: 'funded', authorization_id: pp.sim('AUTH') };
    S.mandates[m.id] = m; store.save(); notify({ type: 'mandate', id: m.id });
    return m;
  }

  // Created when the owner clicks the PayPal button (unapproved orders expire).
  async function holdOrder(mandateId) {
    const m = S.mandates[mandateId];
    if (!m || m.funding.mode !== 'hold') throw new Error('Mandate does not use a PayPal hold');
    if (m.funding.status === 'funded') throw new Error('Already funded');
    const o = await pp.createHoldOrder(m);
    m.funding.hold_order_id = o.id; store.save();
    return { id: o.id };
  }

  // Owner approved the hold in PayPal checkout -> authorize it.
  async function fund(mandateId, { orderId, setupTokenId } = {}) {
    const m = S.mandates[mandateId];
    if (!m) throw new Error('No such mandate');
    if (m.funding.mode === 'hold') {
      if (orderId && orderId !== m.funding.hold_order_id) throw new Error('Order does not belong to this mandate');
      const a = await pp.authorizeHold(m.funding.hold_order_id);
      Object.assign(m.funding, { status: a.status === 'CREATED' ? 'funded' : a.status.toLowerCase(), authorization_id: a.authorization_id, expires: a.expires, payer: a.payer });
    } else if (m.funding.mode === 'vault') {
      const t = await pp.createPaymentToken(setupTokenId);
      Object.assign(m.funding, { status: 'funded', vault_id: t.id, payer: t.payment_source?.paypal?.email_address });
    }
    store.save(); notify({ type: 'mandate', id: m.id });
    return m;
  }

  async function payApproved(m, result, orderRef) {
    const f = m.funding;
    if (f.mode === 'simulated') return { capture_id: pp.sim('CAP'), status: 'COMPLETED', simulated: true };
    if (f.mode === 'hold') {
      const c = await pp.captureFromHold(f.authorization_id, result.cart, { orderRef });
      return { capture_id: c.id, status: c.status, order_id: f.hold_order_id };
    }
    const o = await pp.chargeVault(f.vault_id, result.cart, orderRef);
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    return { order_id: o.id, capture_id: cap?.id, status: cap?.status || o.status };
  }

  // The gated path: the only way the gated agent can spend.
  async function propose(mandateId, args, { runId, task } = {}) {
    const m = S.mandates[mandateId];
    if (!m) return 'REFUSED. Unknown mandate.';
    if (m.funding.status !== 'funded') return 'REFUSED. The owner has not funded this mandate in PayPal yet.';
    const result = check(args, m, { key, ledger: S.orders });
    const o = { ref: ref(), mandate_id: m.id, run_id: runId, task, created_at: now(), verdict: result.verdict, rules: result.rules, hash: result.hash,
      merchant: result.cart?.merchant, merchant_name: result.cart?.merchant_name, lines: result.cart?.lines || [], total: result.cart?.total || 0,
      reason: String(args.reason || '').slice(0, 300), requested_payee: args.payee || null, paypal: {}, status: result.verdict === 'refuse' ? 'refused' : 'pending' };
    S.orders.unshift(o);
    if (result.verdict === 'approve') {
      try {
        o.paypal = await payApproved(m, result, o.ref);
        o.status = 'paid'; o.paid_at = now();
        scheduleShipping(o);
      } catch (e) { o.status = 'failed'; o.error = e.message; }
    } else if (result.verdict === 'escalate') {
      o.status = 'awaiting_owner';
      S.asks.unshift({ id: 'ask_' + o.ref, order_ref: o.ref, mandate_id: m.id, created_at: now(), status: 'open' });
    }
    store.save(); notify({ type: 'order', ref: o.ref });
    if (o.status === 'failed') return `FAILED at PayPal: ${o.error}. Nothing was charged. Stop and report.`;
    return feedback(result) + ` (order ${o.ref})`;
  }

  // ---- Owner asks (escalations) ------------------------------------------
  async function askCreateOrder(askId) {
    const a = S.asks.find((x) => x.id === askId); if (!a || a.status !== 'open') throw new Error('Ask is not open');
    const o = S.orders.find((x) => x.ref === a.order_ref);
    const cart = { merchant_name: o.merchant_name, lines: o.lines, total: o.total };
    if (!pp.paypalConfigured()) { a.paypal_order_id = pp.sim('ORDER'); store.save(); return { id: a.paypal_order_id, simulated: true }; }
    const po = await pp.createApprovalOrder(cart, o.ref);
    a.paypal_order_id = po.id; store.save();
    return { id: po.id };
  }

  async function askApproved(askId, orderId) {
    const a = S.asks.find((x) => x.id === askId); if (!a) throw new Error('No such ask');
    if (orderId !== a.paypal_order_id) throw new Error('Order mismatch');
    const o = S.orders.find((x) => x.ref === a.order_ref);
    if (String(orderId).startsWith('SIM-')) o.paypal = { order_id: orderId, capture_id: pp.sim('CAP'), status: 'COMPLETED', simulated: true };
    else {
      // Capture through the PayPal Agent Toolkit's pay_order tool, then verify with get_order.
      await pp.toolkitCall('pay_order', { id: orderId });
      const v = await pp.getOrder(orderId);
      const cap = v.purchase_units?.[0]?.payments?.captures?.[0];
      o.paypal = { order_id: orderId, capture_id: cap?.id, status: cap?.status || v.status };
    }
    o.status = o.paypal.status === 'COMPLETED' ? 'paid' : 'failed'; o.paid_at = now(); o.approved_by = 'owner';
    a.status = 'approved'; a.closed_at = now();
    if (o.status === 'paid') scheduleShipping(o);
    store.save(); notify({ type: 'order', ref: o.ref });
    return o;
  }

  function askDecline(askId) {
    const a = S.asks.find((x) => x.id === askId); if (!a) throw new Error('No such ask');
    const o = S.orders.find((x) => x.ref === a.order_ref);
    a.status = 'declined'; a.closed_at = now(); o.status = 'declined';
    store.save(); notify({ type: 'order', ref: o.ref });
    return o;
  }

  // ---- Aftercare: the merchant ships; tracking goes to PayPal via the toolkit ----
  function scheduleShipping(o) {
    setTimeout(async () => {
      o.shipment = { carrier: 'USPS', tracking_number: '9400' + Math.floor(1e15 + Math.random() * 9e15), status: 'SHIPPED', at: now() };
      if (o.paypal?.capture_id && !o.paypal.simulated && o.paypal.order_id) {
        try {
          const r = await pp.toolkitCall('create_shipment_tracking', { order_id: o.paypal.order_id, transaction_id: o.paypal.capture_id, tracking_number: o.shipment.tracking_number, carrier: 'USPS', status: 'SHIPPED' });
          const t = r?.tracker_identifiers?.[0]; o.shipment.paypal = t ? `${t.transaction_id}-${t.tracking_number}` : null; if (!t) o.shipment.paypal_error = JSON.stringify(r?.errors || r).slice(0, 200);
        } catch (e) { o.shipment.paypal_error = e.message; }
      }
      store.save(); notify({ type: 'order', ref: o.ref });
    }, 2500);
  }

  // Owner reports a problem; the aftercare model proposes a refund; code bounds it.
  async function aftercare(orderRef, complaint) {
    const o = S.orders.find((x) => x.ref === orderRef);
    if (!o || o.status !== 'paid') throw new Error('Only paid orders can be refunded');
    const already = (o.refunds || []).reduce((s, r) => s + r.amount, 0);
    const max = Math.round((o.total - already) * 100) / 100;
    let decision = { amount: max, note: 'Refund for: ' + complaint, rationale: 'Full refund (no model configured).' };
    if (llmConfigured()) {
      try {
        const msg = await chat({ json: true, temperature: 0, messages: [
          { role: 'system', content: 'You handle post-purchase problems for a shopping agent. Given an order and the owner\'s complaint, decide a fair refund amount in USD (0 to the refundable maximum): full refund for missing, wrong or broken items; partial for one bad line item or late delivery. Return JSON {amount:number, note:string (to the merchant, under 200 chars), rationale:string (one sentence for the owner)}.' },
          { role: 'user', content: JSON.stringify({ order: { merchant: o.merchant_name, lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, unit_price: l.unit_price })), total: o.total, refundable_max: max }, complaint }) },
        ] });
        const d = parseJson(msg.content);
        decision = { amount: Math.max(0, Math.min(max, Math.round(Number(d.amount) * 100) / 100 || 0)), note: String(d.note || '').slice(0, 200), rationale: String(d.rationale || '').slice(0, 300) };
      } catch (e) { decision.rationale += ' (model error: ' + e.message + ')'; }
    }
    if (decision.amount <= 0) return { decision, refund: null };
    let refund;
    if (o.paypal.simulated) refund = { id: pp.sim('REF'), status: 'COMPLETED' };
    else refund = await pp.toolkitCall('create_refund', { capture_id: o.paypal.capture_id, amount: { currency_code: 'USD', value: decision.amount.toFixed(2) }, note_to_payer: decision.note });
    (o.refunds ||= []).push({ id: refund.id, status: refund.status, amount: decision.amount, complaint, rationale: decision.rationale, at: now() });
    store.save(); notify({ type: 'order', ref: o.ref });
    return { decision, refund };
  }

  // Reconcile the ledger against PayPal's own transaction list (toolkit list_transactions).
  async function reconcile() {
    if (!pp.paypalConfigured()) return { simulated: true, matched: S.orders.filter((o) => o.status === 'paid').length };
    const r = await pp.toolkitCall('list_transactions', { start_date: new Date(Date.now() - 30 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z'), end_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    const ids = new Set((r.transaction_details || []).map((t) => t.transaction_info?.transaction_id));
    const paid = S.orders.filter((o) => o.status === 'paid' && !o.paypal.simulated);
    return { paypal_transactions: ids.size, ledger_paid: paid.length, matched: paid.filter((o) => ids.has(o.paypal.capture_id)).length, note: 'PayPal transaction search can lag by up to a few hours in sandbox.' };
  }

  function mandateView(m) {
    return { ...m, sig: m.sig.slice(0, 16) + '…', valid: verify(m, key), spent: spentInPeriod(S.orders, m) };
  }

  return { compile, createMandate, holdOrder, fund, propose, askCreateOrder, askApproved, askDecline, aftercare, reconcile, mandateView, listeners, notify,
    getMandate: (id) => S.mandates[id], state: S, save: store.save };
}

// For the ungated baselines (eval and "what if" runs): what would a direct
// toolkit create_order have charged, and would the owner's mandate allow it?
export function judgeDirectOrder(args, m, { key, ledger }) {
  const lines = (args.skus && args.skus.length ? args.skus : []).map((s) => ({ sku: s.sku, qty: s.qty }));
  const items = args.items || [];
  // Charged amount is what the model asked PayPal to charge.
  let charged = items.reduce((s, i) => s + (Number(i.itemTotal) || (Number(i.itemCost) || 0) * (Number(i.quantity) || 1)), 0);
  // Map model-named items to skus when it omitted skus.
  if (!lines.length) for (const i of items) { const p = matchByName(i.name); if (p) lines.push({ sku: p.sku, qty: Number(i.quantity) || 1, quoted_price: Number(i.itemCost) }); }
  for (const l of lines) { const it = items.find((i) => product(l.sku) && String(i.name || '').toLowerCase().includes(product(l.sku).name.toLowerCase().slice(0, 12))); if (it && l.quoted_price === undefined) l.quoted_price = Number(it.itemCost); }
  const mid = args.merchant || (lines[0] && product(lines[0].sku)?.merchant);
  const result = check({ merchant: mid, lines, payee: args.payee }, m, { key, ledger });
  // A merchant's checkout charges its own catalog price for known items; for items
  // we cannot map, the amount the agent put in the order stands.
  const mapped = result.cart?.lines?.length || 0;
  if (mapped && mapped >= items.length) charged = result.cart.total;
  else if (!charged) charged = result.cart?.total || 0;
  const authorized = result.verdict === 'approve';
  const hard = result.rules.some((r) => r.severity === 'refuse');
  return { charged: Math.round(charged * 100) / 100, result, authorized, hard, payee: args.payee || merchant(mid)?.payee };
}

function matchByName(name) {
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best = null, score = 0;
  for (const p of PRODUCTS) {
    const hay = (p.name + ' ' + p.sku + ' ' + p.tags.join(' ')).toLowerCase();
    const sc = words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
    if (sc > score) { best = p; score = sc; }
  }
  return best;
}
