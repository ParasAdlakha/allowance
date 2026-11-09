// Builds docs/app: the full Allowance app running in the browser, for GitHub Pages.
//   node scripts/build-pages.mjs              build docs/app
//   node scripts/build-pages.mjs --snapshot   first refresh data/demo-session.json from
//                                             the local server's recorded sandbox session
// The engine, gate, mandate, agent and shop modules are copied unchanged except for
// their node:crypto import. Model calls use the visitor's own key; the PayPal hold and
// owner approvals use the PayPal JS SDK with the public client ID; anything that needs
// the client secret (partial captures, tracking, refunds) is simulated and labelled.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { shopPage } from '../core/shop.mjs';
import { MERCHANTS } from '../core/catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}docs/app/`;
const env = Object.fromEntries((existsSync(`${root}.env`) ? readFileSync(`${root}.env`, 'utf8') : '').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const clientId = process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID || '';

if (process.argv.includes('--snapshot')) {
  // Recorded session -> data/demo-session.json, without the buyer's email and with only the
  // latest what-if run per task.
  const s = JSON.parse(readFileSync(`${root}data/runtime/state.json`, 'utf8'));
  for (const m of Object.values(s.mandates)) { delete m.funding.payer; m.recorded = true; }
  const runs = Object.values(s.runs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const keep = {};
  for (const r of runs) { r.recorded = true; keep[r.condition === 'gated' ? r.id : `${r.condition}:${r.task}`] = r; }
  s.runs = Object.fromEntries(Object.values(keep).map((r) => [r.id, r]));
  writeFileSync(`${root}data/demo-session.json`, JSON.stringify(s, null, 1));
  console.log('wrote data/demo-session.json:', Object.keys(s.runs).length, 'runs,', s.orders.length, 'orders');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}core`, { recursive: true });
mkdirSync(`${out}data`, { recursive: true });
mkdirSync(`${out}shop`, { recursive: true });
cpSync(`${root}public`, out, { recursive: true });

for (const f of ['catalog', 'mandate', 'gate', 'agent', 'engine', 'shop']) {
  const src = readFileSync(`${root}core/${f}.mjs`, 'utf8').replace("from 'node:crypto'", "from './crypto.mjs'");
  writeFileSync(`${out}core/${f}.mjs`, src);
}
for (const f of ['crypto', 'llm', 'paypal']) cpSync(`${root}scripts/pages/${f}.mjs`, `${out}core/${f}.mjs`);
cpSync(`${root}scripts/pages/static-api.mjs`, `${out}static-api.mjs`);

// The PayPal Agent Toolkit's real create_order / pay_order schemas, for the what-if agent.
const require = createRequire(import.meta.url);
const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');
const kit = new PayPalAgentToolkit({ clientId: 'schema-only', clientSecret: 'schema-only', configuration: { actions: { orders: { create: true, capture: true } }, context: { sandbox: true } } });
const schemas = kit.getTools().filter((t) => ['create_order', 'pay_order'].includes(t.function.name));
writeFileSync(`${out}core/toolkit-schemas.mjs`, `// Captured from @paypal/agent-toolkit at build time.\nexport default ${JSON.stringify(schemas)};\n`);

// Public PayPal client ID only (it is in every PayPal button's script URL). Never the secret.
writeFileSync(`${out}config.mjs`, `export default ${JSON.stringify({ paypal_client_id: clientId })};\n`);

cpSync(`${root}data/eval-results.json`, `${out}data/eval-results.json`);
if (existsSync(`${root}data/demo-session.json`)) cpSync(`${root}data/demo-session.json`, `${out}data/demo-session.json`);
for (const id of Object.keys(MERCHANTS)) writeFileSync(`${out}shop/${id}.html`, shopPage(id, '../'));

const banner = `<div style="background:#15130f;color:#d9d4c6;font:500 13px/1.45 'Inter Tight',system-ui,sans-serif;padding:8px 16px;text-align:center">Live on GitHub Pages: the gate, mandates and agent run in your browser. The PayPal hold and your approvals are real sandbox payments; automatic captures and refunds need the server's secret, so they are simulated here and marked SIM. Click <b>model ⚙</b> to use your own Gemini key, or replay the recorded sandbox session under 02 Errand. <a style="color:#9be3b8" href="https://github.com/ParasAdlakha/allowance#run-it-yourself">Run the full version</a></div>`;
const html = readFileSync(`${out}index.html`, 'utf8')
  .replace('<script src="app.js"></script>', '<script>window.ALLOWANCE_STATIC = true;</script>\n<script src="app.js"></script>')
  .replace('<body>', `<body>\n${banner}`);
if (!html.includes('ALLOWANCE_STATIC')) throw new Error('index.html script tag not found');
writeFileSync(`${out}index.html`, html);
console.log('built docs/app', clientId ? '(PayPal client ID set)' : '(no PayPal client ID: buttons will not render)');
