// Approves the first unfunded mandate's PayPal hold with the sandbox buyer (smoke test).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
for (const l of fs.readFileSync('../../.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const APP = process.argv[2] || 'http://localhost:8787/app/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(APP + '#mandate', { waitUntil: 'networkidle0' });
await page.waitForSelector('[data-fund]', { timeout: 20000 });
await page.click('[data-fund]');
await page.waitForSelector('#mlist iframe', { timeout: 30000 });
await wait(2500);
const frame = await (await page.$('#mlist iframe')).contentFrame();
const popupP = new Promise((res) => browser.once('targetcreated', async (t) => res(await t.page())));
await frame.click('[data-funding-source="paypal"]');
const pp = await popupP;
await wait(12000);
console.log('popup url', pp.url());
await pp.screenshot({ path: 'popup1.png' });
console.log('inputs', await pp.evaluate(() => [...document.querySelectorAll('input,button')].map((e) => e.tagName + '#' + e.id + ':' + (e.name || '') + ':' + (e.textContent || '').trim().slice(0, 20)).join(' | ')));
await pp.waitForSelector('#email', { timeout: 45000 });
await pp.type('#email', process.env.PAYPAL_BUYER_EMAIL, { delay: 10 });
const next = await pp.$('#btnNext'); if (next) { await next.click(); await wait(2500); }
await pp.waitForSelector('#password', { visible: true, timeout: 30000 });
await pp.type('#password', process.env.PAYPAL_BUYER_PASSWORD, { delay: 10 });
await (await pp.$('#btnLogin')).click();
await wait(8000);
await pp.screenshot({ path: 'fund-review.png' }).catch(() => {});
const btns = await pp.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => (b.id || '') + ':' + b.textContent.trim().slice(0, 40)));
console.log('buttons', btns);
await pp.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /continue|pay|agree|complete/i.test(x.textContent) && x.offsetParent); b?.click(); });
await wait(9000);
console.log('page says:', await page.evaluate(() => document.querySelector('#mlist').innerText.slice(0, 400)));
await browser.close();
