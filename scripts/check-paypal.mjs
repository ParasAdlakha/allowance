// Quick sandbox check: credentials, Orders v2, and which funding mode the app supports.
import { readFileSync, existsSync } from 'node:fs';
for (const l of (existsSync('.env') ? readFileSync('.env', 'utf8') : '').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const pp = await import('../core/paypal.mjs');
if (!pp.paypalConfigured()) { console.log('No PayPal credentials: Allowance will run in simulated mode.'); process.exit(0); }
const o = await pp.api('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] });
console.log('Orders v2 OK:', o.id, o.status);
console.log('Funding mode:', await pp.paymentMode(), '(hold = authorization + partial captures; set PAYMENT_MODE=vault to use Vault)');
console.log('Vault v3 available on this app:', await pp.vaultAvailable());
console.log('Agent Toolkit tools available:', pp.toolkitTools().map((t) => t.function.name).join(', '));
