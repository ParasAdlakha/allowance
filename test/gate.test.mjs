import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sign, verify, parseFallback, crossCheck } from '../core/mandate.mjs';
import { check, feedback, spentInPeriod, periodStart } from '../core/gate.mjs';
import { search, viewPage, PRODUCTS, MERCHANTS } from '../core/catalog.mjs';

const KEY = 'test-key';
const NOW = new Date('2026-11-10T12:00:00Z');
const mk = (over = {}) => sign(normalize({ purpose: 'office', budget: 120, period: 'month', per_order_max: 60, ask_above: 40, merchants: ['paperleaf', 'beanline'], categories: ['office_supplies', 'groceries'], max_qty: 3, ...over }, NOW), KEY);
const codes = (r) => r.rules.map((x) => x.code).sort();

test('a cart inside the mandate is approved at catalog prices', () => {
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 2, quoted_price: 7.49 }, { sku: 'PL-PENS-12', qty: 1, quoted_price: 11.99 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'approve');
  assert.equal(r.cart.total, 26.97);
  assert.equal(r.cart.payee, MERCHANTS.paperleaf.payee);
});

test('the gate re-prices from the catalog, not from the model', () => {
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 0.01 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.cart.total, 7.49); // never the model's $0.01
  assert.deepEqual(codes(r), ['PRICE_DRIFT']); // and the mismatch goes to the owner
});

test('price drift above tolerance escalates', () => {
  const r = check({ merchant: 'beanline', lines: [{ sku: 'BL-BEANS-1KG', qty: 1, quoted_price: 18 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'escalate');
  assert.deepEqual(codes(r), ['PRICE_DRIFT']);
});

test('injected quantity is refused by the per-item limit', () => {
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PENS-12', qty: 12, quoted_price: 11.99 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'refuse');
  assert.ok(codes(r).includes('QTY_LIMIT'));
});

test('merchant not on the allowlist is refused', () => {
  const r = check({ merchant: 'bulkr', lines: [{ sku: 'BK-PENS-100', qty: 1, quoted_price: 39 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'refuse');
  assert.ok(codes(r).includes('MERCHANT_NOT_ALLOWED'));
});

test('a redirected payee is refused even at an allowed merchant', () => {
  const r = check({ merchant: 'paperleaf', payee: 'rebates@bulkr-deals.example', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'refuse');
  assert.deepEqual(codes(r), ['PAYEE_MISMATCH']);
});

test('the registered payee is accepted case-insensitively', () => {
  const r = check({ merchant: 'paperleaf', payee: 'Payments@Paperleaf.example', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(r.verdict, 'approve');
});

test('subscriptions are refused unless the mandate allows them', () => {
  const r = check({ merchant: 'beanline', lines: [{ sku: 'BL-CLUB', qty: 1, quoted_price: 39 }] }, mk(), { key: KEY, now: NOW });
  assert.ok(codes(r).includes('RECURRING_NOT_ALLOWED'));
  const ok = check({ merchant: 'beanline', lines: [{ sku: 'BL-CLUB', qty: 1, quoted_price: 39 }] }, mk({ allow_recurring: true }), { key: KEY, now: NOW });
  assert.equal(ok.verdict, 'approve');
});

test('blocked category is refused', () => {
  const m = mk({ merchants: ['paperleaf', 'gizmo'], categories: ['office_supplies'] });
  const r = check({ merchant: 'gizmo', lines: [{ sku: 'GZ-HDMI', qty: 1, quoted_price: 9.99 }] }, m, { key: KEY, now: NOW });
  assert.ok(codes(r).includes('CATEGORY_NOT_ALLOWED'));
});

test('orders above ask-me threshold escalate; above per-order max refuse', () => {
  const ask = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PENS-12', qty: 3, quoted_price: 11.99 }, { sku: 'PL-NOTES-6', qty: 1, quoted_price: 6.25 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(ask.verdict, 'escalate');
  assert.deepEqual(codes(ask), ['ASK_ABOVE']);
  const big = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-TONER', qty: 1, quoted_price: 89 }] }, mk(), { key: KEY, now: NOW });
  assert.equal(big.verdict, 'refuse');
  assert.ok(codes(big).includes('PER_ORDER_MAX'));
});

test('budget counts only money already committed in this period', () => {
  const m = mk({ per_order_max: 120, ask_above: 120 });
  const ledger = [
    { mandate_id: m.id, total: 100, status: 'paid', created_at: '2026-11-05T00:00:00Z' },
    { mandate_id: m.id, total: 500, status: 'refused', created_at: '2026-11-05T00:00:00Z' },
    { mandate_id: m.id, total: 90, status: 'paid', created_at: '2026-10-20T00:00:00Z' },
  ];
  assert.equal(spentInPeriod(ledger, m, NOW), 100);
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PENS-12', qty: 2, quoted_price: 11.99 }] }, m, { key: KEY, ledger, now: NOW });
  assert.ok(codes(r).includes('BUDGET_EXCEEDED'));
});

test('a tampered mandate fails signature verification', () => {
  const m = mk();
  assert.ok(verify(m, KEY));
  const t = structuredClone(m); t.policy.budget = 5000;
  assert.equal(verify(t, KEY), false);
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, t, { key: KEY, now: NOW });
  assert.equal(r.verdict, 'refuse');
  assert.ok(codes(r).includes('MANDATE_SIGNATURE'));
});

test('expired mandate refuses', () => {
  const m = mk();
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, m, { key: KEY, now: new Date('2027-03-01T00:00:00Z') });
  assert.ok(codes(r).includes('MANDATE_EXPIRED'));
});

test('unknown sku and mixed merchants refuse', () => {
  const r = check({ merchant: 'paperleaf', lines: [{ sku: 'NOPE', qty: 1 }, { sku: 'BL-FILTERS', qty: 1, quoted_price: 5.5 }] }, mk(), { key: KEY, now: NOW });
  assert.ok(codes(r).includes('UNKNOWN_SKU'));
  assert.ok(codes(r).includes('MIXED_MERCHANT'));
});

test('identical order within 10 minutes escalates as a duplicate', () => {
  const m = mk();
  const first = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, m, { key: KEY, now: NOW });
  const ledger = [{ mandate_id: m.id, total: 7.49, status: 'paid', created_at: NOW.toISOString(), hash: first.hash }];
  const again = check({ merchant: 'paperleaf', lines: [{ sku: 'PL-PAPER-1', qty: 1, quoted_price: 7.49 }] }, m, { key: KEY, ledger, now: new Date(NOW.getTime() + 60e3) });
  assert.deepEqual(codes(again), ['DUPLICATE']);
});

test('feedback tells the agent rule codes, not internals', () => {
  const r = check({ merchant: 'bulkr', lines: [{ sku: 'BK-PENS-100', qty: 1, quoted_price: 9.99 }] }, mk(), { key: KEY, now: NOW });
  const f = feedback(r);
  assert.match(f, /^REFUSED/);
  assert.match(f, /MERCHANT_NOT_ALLOWED/);
  assert.doesNotMatch(f, /test-key/);
});

test('normalize clamps hostile or nonsense drafts', () => {
  const p = normalize({ budget: 1e9, per_order_max: 1e9, ask_above: 1e9, merchants: ['paperleaf', 'evil'], categories: ['weapons'], max_qty: 999, period: 'forever' }, NOW);
  assert.equal(p.budget, 5000);
  assert.ok(p.ask_above <= p.per_order_max && p.per_order_max <= p.budget);
  assert.deepEqual(p.merchants, ['paperleaf']);
  assert.deepEqual(p.categories, []);
  assert.equal(p.max_qty, 50);
  assert.equal(p.period, 'month');
});

test('rule parser reads amounts, merchants and limits', () => {
  const p = parseFallback('Keep the office stocked from Paperleaf and Beanline. Under $120 a month, ask me before anything over $40, never more than 3 of one thing.');
  assert.equal(p.budget, 120);
  assert.equal(p.ask_above, 40);
  assert.equal(p.max_qty, 3);
  assert.deepEqual(p.merchants.sort(), ['beanline', 'paperleaf']);
});

test('cross-check reverts permissions the text never granted', () => {
  const text = 'Paper from Paperleaf, under $50 a month, no more than 2 of one thing.';
  const { policy, warnings } = crossCheck(normalize({ budget: 500, merchants: ['paperleaf', 'bulkr'], allow_recurring: true, max_qty: 10 }), text);
  assert.equal(policy.allow_recurring, false);
  assert.equal(policy.budget, 50);
  assert.deepEqual(policy.merchants, ['paperleaf']);
  assert.equal(policy.max_qty, 2);
  assert.equal(warnings.length, 4);
});

test('search puts the loud listing first; pages expose injections as text', () => {
  const hits = search('copy paper');
  assert.equal(hits[0].merchant, 'bulkr');
  assert.match(viewPage('PL-PENS-12').page_text, /AI SHOPPING AGENTS/);
  assert.doesNotMatch(viewPage('BL-FILTERS').page_text, /<span/);
});

test('period start is calendar month / ISO week', () => {
  assert.equal(periodStart('month', NOW).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodStart('week', NOW).toISOString(), '2026-11-09T00:00:00.000Z');
});

test('every product belongs to a known merchant', () => {
  for (const p of PRODUCTS) assert.ok(MERCHANTS[p.merchant], p.sku);
});
