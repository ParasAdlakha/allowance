// Records one real Allowance session against a running server, scene by scene.
//   node record.mjs <app url> <out dir>
// Needs PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD (sandbox personal account) in ../../.env
// to approve the PayPal popups. Each scene is its own .webm (puppeteer screencast).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

for (const l of fs.readFileSync('../../.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const [APP, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: process.env.HEADED ? false : true, protocolTimeout: 300000, args: ['--hide-scrollbars', '--window-size=1460,1000', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const W = 1440, H = 900;
const log = [];
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });

async function scene(name, fn, p = page) {
  const rec = await p.screencast({ path: `${OUT}/${name}.webm` });
  const t0 = Date.now();
  try { await fn(); } finally { await rec.stop(); }
  log.push({ name, seconds: (Date.now() - t0) / 1000 });
  console.log('scene', name, ((Date.now() - t0) / 1000).toFixed(1), 's');
}
const scrollTo = (sel, block = 'center') => page.evaluate((s, b) => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: b }), sel, block);
const clickText = (sel, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)); el?.click(); return !!el; }, sel, text);

// PayPal popup: log in with the sandbox buyer and approve.
async function approveInPopup(trigger, label) {
  const created = [];
  const onT = (t) => created.push(t);
  browser.on('targetcreated', onT);
  await trigger();
  // PayPal opens a transient window first; wait for the real checkout page.
  let pp = null;
  for (let i = 0; i < 60 && !pp; i++) {
    await wait(1000);
    for (const t of created) {
      if (t.type() !== 'page' || !/paypal\.com/.test(t.url())) continue;
      const p = await t.page().catch(() => null);
      const ready = p && !p.isClosed() && await p.evaluate(() => !!document.querySelector('#email') || [...document.querySelectorAll('button')].some((b) => /complete purchase|continue|pay now|agree/i.test(b.textContent) && b.offsetParent)).catch(() => false);
      if (ready) { pp = p; break; }
    }
  }
  browser.off('targetcreated', onT);
  if (!pp) throw new Error('PayPal popup not found; targets: ' + created.map((t) => t.type() + ' ' + t.url().slice(0, 60)).join(' | '));
  const t0 = Date.now();
  const shot = async (n) => { try { await pp.screenshot({ path: `${OUT}/${label}-${n}.png` }); } catch { /* closed */ } };
  try {
    if (await pp.$('#email')) {
      await wait(800);
      await pp.$eval('#email', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
      await pp.type('#email', process.env.PAYPAL_BUYER_EMAIL, { delay: 25 });
      const next = await pp.$('#btnNext'); if (next) { await next.click(); await wait(2500); }
      await pp.waitForSelector('#password', { visible: true, timeout: 30000 });
      await shot(1);
      await pp.type('#password', process.env.PAYPAL_BUYER_PASSWORD, { delay: 20 });
      await (await pp.$('#btnLogin')).click();
    }
    await pp.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /continue|pay|agree|complete/i.test(b.textContent) && b.offsetParent), { timeout: 60000 });
    await wait(2500);
    await shot(2);
    await pp.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(continue|pay|agree & continue|complete purchase|continue to review order|agree and continue)/i.test(x.textContent.trim()) && x.offsetParent); b?.scrollIntoView(); b?.click(); });
    await wait(4000);
  } finally {
    log.push({ name: label, seconds: (Date.now() - t0) / 1000, stills: true });
  }
}

// FROM=<step> resumes a session already in the server's state: mandate | errand | whatif | asks | eval
const ORDER = ['mandate', 'errand', 'whatif', 'asks', 'eval'];
const at = (s) => ORDER.indexOf(s) >= ORDER.indexOf(process.env.FROM || 'mandate');
await page.goto(`${APP}#mandate`, { waitUntil: 'networkidle0' });
await page.evaluateHandle('document.fonts.ready');
await wait(1200);
if (at('mandate')) {

await scene('01-mandate', async () => {
  await wait(1500);
  await page.click('#compile');
  await page.waitForSelector('#sign', { timeout: 120000 });
  await wait(1200);
  await scrollTo('#draft', 'start');
  await wait(4500);
});
await page.screenshot({ path: `${OUT}/mandate.png` });

await scene('02-sign', async () => {
  await page.click('#sign');
  await page.waitForSelector('#paybox iframe', { timeout: 60000 });
  await scrollTo('#paybox');
  await wait(3000);
});
const frame = await (await page.$('#paybox iframe')).contentFrame();
await frame.waitForSelector('[data-funding-source="paypal"]', { visible: true, timeout: 30000 }); await wait(2500);
await approveInPopup(() => frame.click('[data-funding-source="paypal"]'), '03-paypal-hold');
await scene('04-funded', async () => {
  await page.waitForFunction(() => document.querySelector('#paybox')?.innerText.includes('hold placed'), { timeout: 60000 });
  await scrollTo('#paybox'); await wait(4000);
});
}
if (at('errand')) {
await scene('05-errand', async () => {
  await page.evaluate(() => go('errand'));
  await wait(2000);
  await page.click('#go');
  const t0 = Date.now();
  while (Date.now() - t0 < 600000) {
    await wait(1200);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    if (await page.evaluate(() => S.run && S.run.status !== 'running')) break;
  }
  await wait(3000);
});
await page.evaluate(() => window.scrollTo({ top: 0 }));
await page.screenshot({ path: `${OUT}/errand-top.png` });
await page.evaluate(() => document.querySelector('.ev.verdict-approve, .ev.verdict-refuse')?.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${OUT}/errand.png` });
}
if (at('whatif')) {
await scene('06-whatif', async () => {
  if (!(await page.$('#go'))) { await page.evaluate(() => go('errand')); await wait(2000); }
  await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); document.querySelector('input[name=cond][value=naive]').checked = true; });
  await wait(1500);
  await page.click('#go');
  const t0 = Date.now();
  while (Date.now() - t0 < 600000) {
    await wait(1200);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    if (await page.evaluate(() => S.run && S.run.status !== 'running')) break;
  }
  await wait(1500);
  await page.evaluate(() => document.querySelector('.ev.shadow.verdict-refuse')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await wait(4000);
});
await page.screenshot({ path: `${OUT}/whatif.png` });
}
if (at('asks')) {
await scene('07-asks', async () => {
  await page.evaluate(() => go('asks'));
  await page.waitForSelector('.ask iframe', { timeout: 60000 }).catch(() => {});
  await wait(3500);
});
await page.screenshot({ path: `${OUT}/asks.png` });
const askFrameEl = await page.$('.ask iframe');
if (askFrameEl) {
  const af = await askFrameEl.contentFrame();
  await af.waitForSelector('[data-funding-source="paypal"]', { visible: true, timeout: 30000 }); await wait(2500);
  await approveInPopup(() => af.click('[data-funding-source="paypal"]'), '08-paypal-ask');
  await scene('09-asked-paid', async () => { await wait(5000); });
}

await scene('10-ledger', async () => {
  await page.evaluate(() => go('ledger'));
  await wait(6000);
  await page.evaluate(() => document.querySelector('#grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await wait(3500);
});
await page.screenshot({ path: `${OUT}/ledger.png` });

await scene('11-aftercare', async () => {
  const btn = await page.$('[data-report]');
  if (!btn) return;
  await btn.click(); // real mouse click: AG Grid ignores synthetic DOM clicks
  await page.waitForSelector('#acgo', { timeout: 10000 });
  await wait(1500);
  await page.click('#acgo');
  await page.waitForFunction(() => document.querySelector('#acout .okbox, #acout .warnbox'), { timeout: 180000 });
  await wait(4500);
});
await page.screenshot({ path: `${OUT}/aftercare.png` });
await page.evaluate(() => { document.querySelector('#modal').innerHTML = ''; });

}
await scene('12-eval', async () => {
  await page.evaluate(() => go('eval'));
  await wait(5500);
  await page.evaluate(() => window.scrollTo({ top: 500, behavior: 'smooth' }));
  await wait(3000);
});
await page.evaluate(() => window.scrollTo({ top: 0 }));
await page.screenshot({ path: `${OUT}/eval.png` });
await page.evaluate(() => go('shops'));
await wait(1500);
await page.goto(APP.replace('/app/', '/shop/paperleaf'), { waitUntil: 'networkidle0' });
await page.screenshot({ path: `${OUT}/shop.png` });

const prev = fs.existsSync(`${OUT}/scenes.json`) ? JSON.parse(fs.readFileSync(`${OUT}/scenes.json`, 'utf8')).scenes : [];
const merged = [...prev.filter((p) => !log.some((l) => l.name === p.name)), ...log];
fs.writeFileSync(`${OUT}/scenes.json`, JSON.stringify({ scenes: merged }, null, 2));
await browser.close();
