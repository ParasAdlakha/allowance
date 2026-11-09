// The spend gate. Plain code, outside the model. The agent proposes a cart;
// the gate re-prices it from the merchant's authoritative catalog, checks it
// against the signed mandate and the ledger, and returns one verdict:
//   approve  -> Allowance pays via PayPal with no human in the loop
//   escalate -> the person approves (or not) in PayPal checkout
//   refuse   -> nothing is paid; the agent is told which rule fired
import { createHash } from 'node:crypto';
import { product, merchant } from './catalog.mjs';
import { verify } from './mandate.mjs';

export const RULES = {
  MANDATE_SIGNATURE: 'Mandate signature does not match: the policy was altered after signing.',
  MANDATE_EXPIRED: 'Mandate has expired.',
  EMPTY_CART: 'Cart has no items.',
  UNKNOWN_SKU: 'Item is not in the merchant catalog.',
  MIXED_MERCHANT: 'All items in one order must come from the declared merchant.',
  MERCHANT_NOT_ALLOWED: 'Merchant is not on the mandate allowlist.',
  CATEGORY_NOT_ALLOWED: 'Category is not allowed by the mandate.',
  PAYEE_MISMATCH: 'Requested payee is not the merchant\'s registered PayPal payee.',
  RECURRING_NOT_ALLOWED: 'Subscriptions are not allowed by the mandate.',
  QTY_LIMIT: 'Quantity exceeds the per-item limit.',
  PRICE_DRIFT: 'Checkout price is higher than the price the agent saw.',
  PER_ORDER_MAX: 'Order total exceeds the per-order maximum.',
  BUDGET_EXCEEDED: 'Order would exceed the remaining budget for this period.',
  ASK_ABOVE: 'Order total is above the owner\'s ask-me threshold.',
  DUPLICATE: 'An identical order was placed in the last 10 minutes.',
};
const SEVERITY = { PRICE_DRIFT: 'escalate', ASK_ABOVE: 'escalate', DUPLICATE: 'escalate' }; // everything else refuses

const r2 = (n) => Math.round(n * 100) / 100;

export function periodStart(period, now = new Date()) {
  const d = new Date(now);
  if (period === 'week') { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); d.setUTCHours(0, 0, 0, 0); return d; }
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return new Date(0);
}

// ledger: [{mandate_id, total, status, created_at, hash}] of money already committed
export function spentInPeriod(ledger, m, now = new Date()) {
  const from = periodStart(m.policy.period, now).getTime();
  return r2(ledger.filter((o) => o.mandate_id === m.id && ['paid', 'approved', 'pending_capture'].includes(o.status) && new Date(o.created_at).getTime() >= from)
    .reduce((s, o) => s + o.total, 0));
}

export function check(proposal, m, { key, ledger = [], now = new Date() } = {}) {
  const hits = [];
  const hit = (code, detail) => hits.push({ code, severity: SEVERITY[code] || 'refuse', message: RULES[code], detail });
  const p = m?.policy;

  if (!verify(m, key)) hit('MANDATE_SIGNATURE');
  if (p && new Date(p.expires_at) < now) hit('MANDATE_EXPIRED');

  const declared = merchant(proposal?.merchant);
  const lines = [];
  for (const l of proposal?.lines || []) {
    const prod = product(l.sku);
    if (!prod) { hit('UNKNOWN_SKU', String(l.sku)); continue; }
    const qty = Math.max(1, parseInt(l.qty, 10) || 1);
    lines.push({ sku: prod.sku, name: prod.name, merchant: prod.merchant, qty, unit_price: prod.price, quoted_price: Number(l.quoted_price ?? prod.listed), recurring: !!prod.recurring });
  }
  if (!lines.length && !hits.some((h) => h.code === 'UNKNOWN_SKU')) hit('EMPTY_CART');

  const mid = declared?.id || lines[0]?.merchant;
  const mer = merchant(mid);
  if (lines.some((l) => l.merchant !== mid)) hit('MIXED_MERCHANT', [...new Set(lines.map((l) => l.merchant))].join(', '));
  if (p && mer && !p.merchants.includes(mer.id)) hit('MERCHANT_NOT_ALLOWED', mer.name);
  if (p && mer && p.categories.length && !p.categories.includes(mer.category)) hit('CATEGORY_NOT_ALLOWED', mer.category);
  if (proposal?.payee && mer && String(proposal.payee).toLowerCase() !== mer.payee) hit('PAYEE_MISMATCH', String(proposal.payee));

  for (const l of lines) {
    if (l.recurring && !p?.allow_recurring) hit('RECURRING_NOT_ALLOWED', l.sku);
    if (p && l.qty > p.max_qty) hit('QTY_LIMIT', `${l.sku} x${l.qty} > ${p.max_qty}`);
    const tol = 1 + (p?.price_tolerance_pct ?? 5) / 100;
    if (Number.isFinite(l.quoted_price) && l.unit_price > r2(l.quoted_price * tol)) hit('PRICE_DRIFT', `${l.sku}: saw $${l.quoted_price.toFixed(2)}, charged $${l.unit_price.toFixed(2)}`);
  }

  const total = r2(lines.reduce((s, l) => s + l.unit_price * l.qty, 0));
  const spent = m ? spentInPeriod(ledger, m, now) : 0;
  if (p && total > p.per_order_max) hit('PER_ORDER_MAX', `$${total.toFixed(2)} > $${p.per_order_max.toFixed(2)}`);
  if (p && r2(spent + total) > p.budget) hit('BUDGET_EXCEEDED', `spent $${spent.toFixed(2)} + $${total.toFixed(2)} > $${p.budget.toFixed(2)}`);
  if (p && total > p.ask_above) hit('ASK_ABOVE', `$${total.toFixed(2)} > $${p.ask_above.toFixed(2)}`);

  const hash = createHash('sha256').update(JSON.stringify([mid, lines.map((l) => [l.sku, l.qty])])).digest('hex').slice(0, 16);
  const tenMin = now.getTime() - 10 * 60e3;
  if (ledger.some((o) => o.hash === hash && o.mandate_id === m?.id && ['paid', 'approved', 'pending_capture'].includes(o.status) && new Date(o.created_at).getTime() > tenMin)) hit('DUPLICATE');

  const verdict = hits.some((h) => h.severity === 'refuse') ? 'refuse' : hits.length ? 'escalate' : 'approve';
  return {
    verdict,
    rules: hits,
    cart: mer ? { merchant: mer.id, merchant_name: mer.name, payee: mer.payee, lines, total, currency: 'USD' } : null,
    budget: p ? { budget: p.budget, spent, remaining: r2(p.budget - spent) } : null,
    hash,
  };
}

// What the agent is told. Rule codes and short reasons, so it can revise.
export function feedback(result) {
  if (result.verdict === 'approve') return `APPROVED. Charged total $${result.cart.total.toFixed(2)}.`;
  const lines = result.rules.map((r) => `- ${r.code}: ${r.message}${r.detail ? ` (${r.detail})` : ''}`).join('\n');
  return result.verdict === 'escalate'
    ? `ESCALATED to the owner for approval. Do not retry this cart. Reasons:\n${lines}`
    : `REFUSED. Nothing was paid. You may propose one revised cart that satisfies the mandate, or stop and explain. Reasons:\n${lines}`;
}
