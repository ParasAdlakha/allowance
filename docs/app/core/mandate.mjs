// A mandate is the human's signed instruction: what the agent may buy, where,
// and for how much. The model may draft it from plain English, but only the
// normalized, human-confirmed, HMAC-signed version is ever enforced.
import { createHmac, createHash } from './crypto.mjs';
import { MERCHANTS } from './catalog.mjs';

export const CATEGORIES = ['office_supplies', 'groceries', 'electronics', 'cleaning'];
const PERIODS = ['once', 'week', 'month'];
const HARD_CAP = 5000; // no mandate can exceed this, whatever the text says

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : d);

export function normalize(raw = {}, now = new Date()) {
  const budget = Math.min(num(raw.budget, 100), HARD_CAP);
  const perOrder = Math.min(num(raw.per_order_max, budget), budget);
  const askAbove = Math.min(num(raw.ask_above, perOrder), perOrder);
  const merchants = [...new Set((raw.merchants || []).map((m) => String(m).toLowerCase()).filter((m) => MERCHANTS[m]))];
  const categories = [...new Set((raw.categories || []).map((c) => String(c).toLowerCase()).filter((c) => CATEGORIES.includes(c)))];
  const days = Math.min(Math.max(parseInt(raw.valid_days ?? 30, 10) || 30, 1), 90);
  return {
    purpose: String(raw.purpose || 'Shopping errands').slice(0, 160),
    currency: 'USD',
    budget,
    period: PERIODS.includes(raw.period) ? raw.period : 'month',
    per_order_max: perOrder,
    ask_above: askAbove,
    merchants,
    categories,
    max_qty: Math.min(Math.max(parseInt(raw.max_qty ?? 5, 10) || 5, 1), 50),
    allow_recurring: raw.allow_recurring === true,
    price_tolerance_pct: Math.min(num(raw.price_tolerance_pct, 5), 20),
    valid_days: days,
    expires_at: raw.expires_at || new Date(now.getTime() + days * 864e5).toISOString(),
  };
}

const canonical = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));

export function sign(policy, key, signer = 'owner') {
  if (!key) throw new Error('MANDATE_SIGNING_KEY is not set');
  const body = canonical(policy);
  const sig = createHmac('sha256', key).update(body).digest('hex');
  const id = 'mdt_' + createHash('sha256').update(body + sig).digest('hex').slice(0, 12);
  return { id, policy, signer, signed_at: new Date().toISOString(), sig };
}

export function verify(m, key) {
  if (!m || !m.policy || !m.sig) return false;
  const sig = createHmac('sha256', key).update(canonical(m.policy)).digest('hex');
  return sig === m.sig;
}

// Plain-English summary shown before signing, so a human reads what is enforced.
export function describe(p) {
  const ms = p.merchants.map((m) => MERCHANTS[m]?.name || m).join(', ') || 'no merchants';
  return [
    `Spend at most $${p.budget.toFixed(2)} per ${p.period === 'once' ? 'mandate' : p.period}.`,
    `Each order at most $${p.per_order_max.toFixed(2)}; ask me before any order above $${p.ask_above.toFixed(2)}.`,
    `Only at: ${ms}.`,
    p.categories.length ? `Only these categories: ${p.categories.join(', ').replace(/_/g, ' ')}.` : 'Any category those merchants sell.',
    `No more than ${p.max_qty} of any one item. ${p.allow_recurring ? 'Subscriptions allowed.' : 'No subscriptions.'}`,
    `Expires ${p.expires_at.slice(0, 10)}.`,
  ];
}

// Deterministic fallback when no model is configured: pulls numbers and names
// out of the text. The LLM path does the same job better, then this module's
// normalize() clamps whatever it returns.
export function parseFallback(text = '') {
  const t = text.toLowerCase();
  const money = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : undefined; };
  const budget = money(/(?:under|budget|max(?:imum)?|up to|no more than|limit)[^$\d]{0,12}\$?\s?([\d,]+(?:\.\d+)?)/);
  const ask = money(/(?:ask|check with|confirm with|approve)[^$\d]{0,30}(?:above|over|more than|>)\s?\$?\s?([\d,]+(?:\.\d+)?)/);
  const perOrder = money(/(?:per order|each order|single order)[^$\d]{0,12}\$?\s?([\d,]+(?:\.\d+)?)/);
  const period = /week/.test(t) ? 'week' : /once|one[- ]off|single/.test(t) ? 'once' : 'month';
  const merchants = Object.values(MERCHANTS).filter((m) => t.includes(m.id) || t.includes(m.name.toLowerCase().split(' ')[0])).map((m) => m.id);
  const cats = [];
  if (/office|paper|pen|stationery/.test(t)) cats.push('office_supplies');
  if (/coffee|grocer|snack|tea/.test(t)) cats.push('groceries');
  if (/clean|soap|wipe|towel/.test(t)) cats.push('cleaning');
  if (/electronic|cable|gadget/.test(t)) cats.push('electronics');
  const qty = money(/(?:more than|max(?:imum)?|at most|up to)\s+(\d+)\s+(?:of|units|items|each|per)/);
  return normalize({ purpose: text.slice(0, 160), budget, per_order_max: perOrder, ask_above: ask, period, merchants, categories: cats, max_qty: qty });
}

// The model drafts; this code cross-checks the draft against the person's own
// words and reverts any permission the text never granted. Returns the safe
// policy plus warnings the UI shows before signing.
export function crossCheck(draft, text = '') {
  const t = text.toLowerCase();
  const literal = parseFallback(text);
  const p = { ...draft };
  const warnings = [];
  if (p.allow_recurring && !/subscri|recurring|membership|monthly plan|club/.test(t)) { p.allow_recurring = false; warnings.push('Model allowed subscriptions; your text did not. Reverted to no subscriptions.'); }
  const stated = (re) => re.test(t);
  if (stated(/\$\s?\d/) && p.budget > literal.budget && literal.budget !== 100) { warnings.push(`Model budget $${p.budget} is above the $${literal.budget} in your text. Using $${literal.budget}.`); p.budget = literal.budget; }
  const extra = p.merchants.filter((m) => !literal.merchants.includes(m));
  if (literal.merchants.length && extra.length) { warnings.push(`Model added merchants you did not name: ${extra.join(', ')}. Removed.`); p.merchants = p.merchants.filter((m) => literal.merchants.includes(m)); }
  if (!p.merchants.length) warnings.push('No merchants allowed yet: the agent cannot buy anything until you add one.');
  if (/more than \d+ of|at most \d+ of|max(?:imum)? \d+/.test(t) && p.max_qty > literal.max_qty) { warnings.push(`Model per-item limit ${p.max_qty} is above the ${literal.max_qty} in your text. Using ${literal.max_qty}.`); p.max_qty = literal.max_qty; }
  return { policy: normalize(p), warnings };
}

export const COMPILE_PROMPT = `You turn a person's plain-English spending instruction for their AI shopping agent into a JSON policy.
Return ONLY JSON with keys: purpose (short string), budget (number, USD, total per period), period ("once"|"week"|"month"),
per_order_max (number), ask_above (number: orders above this need the person's approval), merchants (array of merchant ids),
categories (array from ${JSON.stringify(CATEGORIES)}), max_qty (integer, max units of one item), allow_recurring (boolean), valid_days (integer).
Known merchants (id: name, category): ${Object.values(MERCHANTS).map((m) => `${m.id}: ${m.name} (${m.category})`).join('; ')}.
Rules: be conservative. Only include merchants the person named or clearly implied. If no approval threshold is given, use half of per_order_max.
If something is not stated, choose the safer (smaller) value. Never invent budget above what is stated.`;
