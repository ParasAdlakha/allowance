// PayPal: the REST calls Allowance makes itself (authorization hold, partial
// captures, Vault, refunds) plus the official PayPal Agent Toolkit for the
// order, capture, tracking and reporting tools the agents use.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Toolkit = null;
try { Toolkit = require('@paypal/agent-toolkit/openai'); } catch { /* optional in tests */ }

const BASE = () => (process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
export const paypalConfigured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let tok = { value: null, exp: 0 };
async function token() {
  if (tok.value && Date.now() < tok.exp) return tok.value;
  const res = await fetch(BASE() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d = await res.json();
  if (!res.ok) throw new Error('PayPal auth failed: ' + (d.error_description || res.status));
  tok = { value: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return tok.value;
}

export async function api(method, path, body, { requestId } = {}) {
  const res = await fetch(BASE() + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) { const e = new Error(`PayPal ${method} ${path} -> ${res.status} ${data.name || ''} ${data.details?.[0]?.issue || data.message || ''}`.trim()); e.status = res.status; e.data = data; throw e; }
  return data;
}

const money = (v) => ({ currency_code: 'USD', value: Number(v).toFixed(2) });

// ---- Mode detection -------------------------------------------------------
// vault:     owner saves PayPal once (Vault v3); each approved order charges the vault_id
// hold:      owner approves one PayPal authorization for the budget; each approved order is a partial capture
// simulated: no PayPal credentials; ids are clearly marked SIM-
let modeCache = null;
export async function paymentMode() {
  if (process.env.PAYMENT_MODE) return process.env.PAYMENT_MODE;
  if (!paypalConfigured()) return 'simulated';
  if (modeCache) return modeCache;
  try {
    await api('POST', '/v3/vault/setup-tokens', { payment_source: { paypal: { usage_type: 'MERCHANT', experience_context: { return_url: 'https://example.com/r', cancel_url: 'https://example.com/c' } } } }, { requestId: randomUUID() });
    modeCache = 'vault';
  } catch { modeCache = 'hold'; }
  return modeCache;
}

// ---- Mandate funding: authorization hold ---------------------------------
export async function createHoldOrder(mandate) {
  const p = mandate.policy;
  return api('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: mandate.id, custom_id: mandate.id, description: `Allowance mandate: ${p.purpose}`.slice(0, 127), soft_descriptor: 'ALLOWANCE', amount: money(p.budget) }],
    payment_source: { paypal: { experience_context: { brand_name: 'Allowance', user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING' } } },
  }, { requestId: 'hold-' + mandate.id + '-' + Date.now() });
}

export async function authorizeHold(orderId) {
  const d = await api('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, { requestId: 'auth-' + orderId });
  const a = d.purchase_units?.[0]?.payments?.authorizations?.[0];
  return { authorization_id: a?.id, status: a?.status, expires: a?.expiration_time, payer: d.payer?.email_address };
}

export async function captureFromHold(authorizationId, cart, { orderRef, final = false }) {
  return api('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
    amount: money(cart.total), final_capture: final, invoice_id: orderRef,
    note_to_payer: `${cart.merchant_name}: ${cart.lines.map((l) => `${l.qty}x ${l.name}`).join(', ')}`.slice(0, 255),
    soft_descriptor: 'ALLOWANCE',
  }, { requestId: 'cap-' + orderRef });
}

export async function voidHold(authorizationId) {
  return api('POST', `/v2/payments/authorizations/${authorizationId}/void`, {});
}

// ---- Mandate funding: Vault -----------------------------------------------
export async function createSetupToken(returnUrl, cancelUrl) {
  return api('POST', '/v3/vault/setup-tokens', {
    payment_source: { paypal: { usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true, description: 'Allowance: pays only within mandates you sign',
      experience_context: { brand_name: 'Allowance', return_url: returnUrl, cancel_url: cancelUrl, vault_instruction: 'ON_PAYER_APPROVAL' } } },
  }, { requestId: randomUUID() });
}

export async function createPaymentToken(setupTokenId) {
  return api('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }, { requestId: 'pt-' + setupTokenId });
}

function cartUnit(cart, orderRef) {
  const items = cart.lines.map((l) => ({ name: l.name.slice(0, 127), sku: l.sku, quantity: String(l.qty), unit_amount: money(l.unit_price), category: 'PHYSICAL_GOODS' }));
  return { reference_id: orderRef, invoice_id: orderRef, description: `Allowance order at ${cart.merchant_name}`.slice(0, 127), soft_descriptor: 'ALLOWANCE',
    amount: { ...money(cart.total), breakdown: { item_total: money(cart.total) } }, items };
}

export async function chargeVault(vaultId, cart, orderRef) {
  return api('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [cartUnit(cart, orderRef)], payment_source: { paypal: { vault_id: vaultId } } }, { requestId: 'vault-' + orderRef });
}

// ---- Escalation: person approves this one order in PayPal checkout ---------
export async function createApprovalOrder(cart, orderRef) {
  return api('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [cartUnit(cart, orderRef)],
    payment_source: { paypal: { experience_context: { brand_name: 'Allowance', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } } }, { requestId: 'ask-' + orderRef });
}
export const captureOrder = (orderId) => api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { requestId: 'capord-' + orderId });
export const getOrder = (orderId) => api('GET', `/v2/checkout/orders/${orderId}`);
export const refundCapture = (captureId, amount, note) => api('POST', `/v2/payments/captures/${captureId}/refund`, { amount: money(amount), note_to_payer: String(note || 'Refund via Allowance').slice(0, 255) }, { requestId: 'ref-' + captureId + '-' + amount });

// ---- PayPal Agent Toolkit --------------------------------------------------
let kit = null;
export function toolkit() {
  if (!Toolkit || !paypalConfigured()) return null;
  if (!kit) {
    kit = new Toolkit.PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      configuration: { actions: { orders: { create: true, get: true, capture: true }, shipment: { create: true, get: true }, payments: { createRefund: true, getRefunds: true, getRefund: true }, transactions: { list: true }, insights: { get: true } }, context: { sandbox: process.env.PAYPAL_ENV !== 'live' } },
    });
  }
  return kit;
}

export function toolkitTools(names) {
  const k = toolkit();
  if (!k) return [];
  return k.getTools().filter((t) => !names || names.includes(t.function.name));
}

export async function toolkitCall(name, args) {
  const k = toolkit();
  if (!k) return { simulated: true, note: 'PayPal not configured', name, args };
  const msg = await k.handleToolCall({ id: 'call_' + randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  try { return JSON.parse(msg.content); } catch { return { raw: msg.content }; }
}

export const sim = (prefix) => `SIM-${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
