// End-to-end check of the GitHub Pages build's real PayPal flows (sandbox):
// draft + sign a mandate, approve the PayPal hold in the popup, run a scripted errand
// that escalates, approve the escalation in PayPal. Needs PAYPAL_BUYER_* in ../../.env.
//   node pages-test.mjs [app url]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
for (const l of fs.readFileSync('../../.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const APP = process.argv[2] || 'http://localhost:8811/app/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 300000, args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });

async function approve(frameSel) {
  const frame = await (await page.waitForSelector(frameSel, { timeout: 30000 })).contentFrame();
  await frame.waitForSelector('[data-funding-source="paypal"]', { visible: true, timeout: 30000 }); await wait(2000);
  const created = []; const on = (t) => created.push(t); browser.on('targetcreated', on);
  await frame.click('[data-funding-source="paypal"]');
  let pp = null;
  for (let i = 0; i < 60 && !pp; i++) {
    await wait(1000);
    for (const t of created) {
      if (t.type() !== 'page' || !/paypal\.com/.test(t.url())) continue;
      const p = await t.page().catch(() => null);
      if (p && !p.isClosed() && await p.evaluate(() => !!document.querySelector('#email') || [...document.querySelectorAll('button')].some((b) => /complete purchase|continue|pay now/i.test(b.textContent) && b.offsetParent)).catch(() => false)) { pp = p; break; }
    }
  }
  browser.off('targetcreated', on);
  if (!pp) throw new Error('popup not found');
  if (await pp.$('#email')) {
    await pp.$eval('#email', (e) => { e.value = ''; });
    await pp.type('#email', process.env.PAYPAL_BUYER_EMAIL, { delay: 10 });
    const next = await pp.$('#btnNext'); if (next) { await next.click(); await wait(2500); }
    await pp.waitForSelector('#password', { visible: true, timeout: 30000 });
    await pp.type('#password', process.env.PAYPAL_BUYER_PASSWORD, { delay: 10 });
    await (await pp.$('#btnLogin')).click();
  }
  await pp.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /continue|pay|agree|complete/i.test(b.textContent) && b.offsetParent), { timeout: 60000 });
  await wait(2000);
  await pp.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(continue|pay|agree & continue|complete purchase|agree and continue)/i.test(x.textContent.trim()) && x.offsetParent); b?.click(); });
}

await page.goto(APP + '#mandate', { waitUntil: 'networkidle0' });
await wait(1500);
await page.click('#compile');
await page.waitForSelector('#sign', { timeout: 60000 });
await page.click('#sign');
await approve('#paybox iframe');
await page.waitForFunction(() => /hold placed|warn/.test((document.querySelector('#paybox')?.innerText || '') + (document.querySelector('#paybox .warnbox') ? 'warn' : '')), { timeout: 90000 }).catch(async () => { console.log('PAYBOX:', await page.evaluate(() => document.querySelector('#paybox')?.innerText)); });
console.log('HOLD:', await page.evaluate(() => document.querySelector('#paybox').innerText));

console.log('ERRAND:', await page.evaluate(async () => {
  const m = (await API('/mandates')).find((x) => !x.recorded && x.funding.status === 'funded');
  const r = await API('/errands', { method: 'POST', body: { mandate_id: m.id, task: 'Buy 1 house blend coffee beans 1 kg' } });
  for (let i = 0; i < 40; i++) { const d = await API('/runs/' + r.id + '?since=0'); if (d.status !== 'running') return d.orders.map((o) => o.ref + ' ' + o.verdict + ' ' + o.status).join(' | '); await new Promise((x) => setTimeout(x, 500)); }
  return 'timeout';
}));
await page.evaluate(() => go('asks'));
await approve('.ask iframe');
await page.waitForFunction(() => /approved/.test(document.querySelector('#asks')?.innerText || '') && !document.querySelector('.ask iframe'), { timeout: 90000 }).catch(() => {});
await wait(2000);
console.log('ASKS:', await page.evaluate(() => document.querySelector('#asks').innerText.split('\n').filter((l) => /approved|capture/i.test(l)).slice(0, 3).join(' | ')));
await browser.close();
