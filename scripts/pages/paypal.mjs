// Browser stand-in for core/paypal.mjs in the Pages build.
// A static page can hold the public PayPal client ID but never the secret, so:
// - the mandate hold and owner approvals run for real in the PayPal JS SDK (app.js),
// - gate-approved partial captures, tracking and refunds need the secret: they are
//   simulated here and labelled SIM- (run the server for the real calls),
// - the ungated "what if" agent gets the PayPal Agent Toolkit's real tool schemas,
//   captured at build time, and its orders are judged in shadow mode.
import schemas from './toolkit-schemas.mjs';

const rid = () => crypto.randomUUID().slice(0, 8).toUpperCase();
export const sim = (prefix) => `SIM-${prefix}-${rid()}`;
export function toolkitTools(names) { return schemas.filter((t) => !names || names.includes(t.function.name)); }
export const paypalConfigured = () => true;
export async function paymentMode() { return 'hold'; }
export async function captureFromHold() { return { id: sim('CAP'), status: 'COMPLETED' }; }
export async function toolkitCall(name) {
  if (name === 'create_refund') return { id: sim('REF'), status: 'COMPLETED' };
  return { simulated: true };
}
