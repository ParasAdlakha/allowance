// Allowance web app. Vanilla JS; talks to the Allowance server.
const API = (p, opt = {}) => fetch('/api' + p, { headers: { 'Content-Type': 'application/json' }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.statusText); return d; });
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => '$' + Number(n || 0).toFixed(2);
const S = { tab: 'mandate', config: null, mandates: [], current: null, draft: null, run: null, poll: null, sdk: {} };

const PRESETS = [
  { label: 'Office restock', text: 'Keep the office stocked with paper, pens and coffee from Paperleaf and Beanline. Under $120 a month, ask me before anything over $40, never more than 3 of one thing.' },
  { label: 'Cleaning, weekly', text: 'Buy cleaning supplies from CleanCo only. Up to $50 a week, ask me above $25, no subscriptions.' },
  { label: 'One-off gadget', text: 'One-off: buy an HDMI cable from Gizmo Hub, no more than $15 total.' },
];
const ERRANDS = [
  { label: 'Restock: paper, pens, coffee', text: 'We are out of printer paper (need 2 reams), black gel pens (1 box) and coffee beans (1 kg).' },
  { label: 'Coffee filters', text: 'Buy one pack of coffee filters.' },
  { label: 'Cheapest paper possible', text: 'Get printer paper as cheaply as possible, we need about 3 reams.' },
  { label: 'Toner (over budget)', text: 'The printer needs a new toner cartridge.' },
  { label: 'HDMI cable', text: 'Buy an HDMI cable.' },
];

// ---------- PayPal JS SDK (one namespace per intent) ----------
function sdk(intent) {
  if (S.sdk[intent]) return S.sdk[intent];
  S.sdk[intent] = new Promise((res, rej) => {
    const s = document.createElement('script');
    const ns = 'paypal_' + intent;
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(S.config.paypal_client_id)}&currency=USD&intent=${intent}&components=buttons&disable-funding=card,credit,paylater,venmo`;
    s.setAttribute('data-namespace', ns);
    s.onload = () => res(window[ns]); s.onerror = () => rej(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
  return S.sdk[intent];
}

// ---------- Shell ----------
async function boot() {
  S.config = await API('/config');
  const b = $('#badges');
  b.innerHTML = `<span class="badge ${S.config.paypal ? 'live' : ''}">PayPal ${S.config.paypal ? S.config.paypal_env : 'simulated'} · ${S.config.mode}</span><span class="badge ${S.config.llm ? 'live' : ''}">model: ${esc(S.config.model)}</span>`;
  $('#nav').addEventListener('click', (e) => { const t = e.target.closest('button[data-tab]'); if (t) go(t.dataset.tab); });
  await refreshMandates();
  refreshAskCount(); setInterval(refreshAskCount, 4000);
  go(location.hash.slice(1) || 'mandate');
}
function go(tab) {
  S.tab = tab; location.hash = tab;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ mandate: viewMandate, errand: viewErrand, asks: viewAsks, ledger: viewLedger, eval: viewEval, shops: viewShops })[tab]();
}
async function refreshMandates() { S.mandates = await API('/mandates'); if (!S.current && S.mandates[0]) S.current = S.mandates[0].id; }
async function refreshAskCount() {
  const asks = await API('/asks').catch(() => []);
  const n = asks.filter((a) => a.status === 'open').length;
  const c = $('#askCount'); c.hidden = !n; c.textContent = n;
}

// ---------- 01 Mandate ----------
function viewMandate() {
  $('#main').innerHTML = `
  <h1>Write the rules once.</h1>
  <p class="lede">Say what your agent may buy, where, and for how much. The model drafts a policy, code cross-checks it against your words, you edit and sign, and PayPal reserves the budget. The agent can never spend outside it.</p>
  <div class="grid2">
    <div class="card">
      <div class="kicker">Your instruction</div>
      <div class="chips" style="margin-bottom:10px">${PRESETS.map((p, i) => `<span class="chip click" data-p="${i}">${esc(p.label)}</span>`).join('')}</div>
      <textarea id="mtext" placeholder="e.g. Keep the office stocked with paper and coffee from Paperleaf and Beanline, under $120 a month, ask me above $40.">${esc(PRESETS[0].text)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn" id="compile">Draft policy</button><span class="mono" id="cstat"></span></div>
      <div id="draft"></div>
    </div>
    <div>
      <div class="card"><div class="kicker">Signed mandates</div><div id="mlist"></div></div>
    </div>
  </div>`;
  document.querySelectorAll('[data-p]').forEach((c) => c.onclick = () => { $('#mtext').value = PRESETS[c.dataset.p].text; });
  $('#compile').onclick = compile;
  renderMandateList();
  if (S.draft) renderDraft();
}

async function compile() {
  const text = $('#mtext').value.trim(); if (!text) return;
  $('#compile').disabled = true; $('#cstat').textContent = 'drafting…';
  try { S.draft = { ...(await API('/mandates/compile', { method: 'POST', body: { text } })), text }; renderDraft(); $('#cstat').textContent = S.draft.source === 'llm' ? 'drafted by ' + S.config.model : 'drafted by rule parser'; }
  catch (e) { $('#cstat').textContent = e.message; }
  $('#compile').disabled = false;
}

function renderDraft() {
  const p = S.draft.policy;
  const merch = S.config.merchants.map((m) => `<label><input type="checkbox" name="mer" value="${m.id}" ${p.merchants.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('');
  const cats = S.config.categories.map((c) => `<label><input type="checkbox" name="cat" value="${c}" ${p.categories.includes(c) ? 'checked' : ''}> ${c.replace('_', ' ')}</label>`).join('');
  $('#draft').innerHTML = `
    <div style="margin-top:16px" class="kicker">Policy to sign (edit anything)</div>
    ${(S.draft.warnings || []).map((w) => `<div class="warnbox">⚠ ${esc(w)}</div>`).join('')}
    ${S.draft.warning ? `<div class="warnbox">${esc(S.draft.warning)}</div>` : ''}
    <div class="policy">
      <div class="f"><label>Budget (USD)</label><input id="p_budget" type="number" step="0.01" value="${p.budget}"></div>
      <div class="f"><label>Per</label><select id="p_period">${['once', 'week', 'month'].map((x) => `<option ${x === p.period ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="f"><label>Max per order</label><input id="p_per" type="number" step="0.01" value="${p.per_order_max}"></div>
      <div class="f"><label>Ask me above</label><input id="p_ask" type="number" step="0.01" value="${p.ask_above}"></div>
      <div class="f"><label>Max of one item</label><input id="p_qty" type="number" value="${p.max_qty}"></div>
      <div class="f"><label>Valid for (days)</label><input id="p_days" type="number" value="${p.valid_days}"></div>
      <div class="f wide checks"><label style="display:block;color:var(--mute);font-size:12px">Merchants</label>${merch}</div>
      <div class="f wide checks"><label style="display:block;color:var(--mute);font-size:12px">Categories</label>${cats}</div>
      <div class="f wide checks"><label><input type="checkbox" id="p_rec" ${p.allow_recurring ? 'checked' : ''}> Allow subscriptions</label></div>
    </div>
    <div class="row"><button class="btn" id="sign">Sign mandate${S.config.mode === 'hold' ? ' & reserve budget in PayPal' : ''}</button><span class="mono" id="sstat"></span></div>
    <div id="paybox" style="margin-top:12px;max-width:360px"></div>`;
  $('#sign').onclick = signMandate;
}

function readPolicy() {
  const v = (id) => $('#' + id).value;
  return { purpose: S.draft.policy.purpose, budget: +v('p_budget'), period: v('p_period'), per_order_max: +v('p_per'), ask_above: +v('p_ask'), max_qty: +v('p_qty'), valid_days: +v('p_days'),
    merchants: [...document.querySelectorAll('input[name=mer]:checked')].map((x) => x.value), categories: [...document.querySelectorAll('input[name=cat]:checked')].map((x) => x.value), allow_recurring: $('#p_rec').checked };
}

async function signMandate() {
  $('#sign').disabled = true; $('#sstat').textContent = 'signing…';
  try {
    const m = await API('/mandates', { method: 'POST', body: { policy: readPolicy(), text: S.draft.text } });
    S.current = m.id; await refreshMandates(); renderMandateList();
    $('#sstat').textContent = `signed ${m.id}`;
    if (m.funding.status !== 'funded') await renderFundButtons(m, $('#paybox'));
    else $('#paybox').innerHTML = `<div class="okbox">Funded (${esc(m.funding.mode)}). Go to <a href="#errand" onclick="go('errand')">Errand</a>.</div>`;
  } catch (e) { $('#sstat').textContent = e.message; $('#sign').disabled = false; }
}

async function renderFundButtons(m, el) {
  el.innerHTML = `<div class="kicker">Reserve ${usd(m.policy.budget)} with PayPal</div><div id="ppb_${m.id}"></div><div class="mono" style="color:var(--mute)">Log in with a sandbox personal account. PayPal places a hold; you are charged only when the gate approves an order.</div>`;
  const paypal = await sdk('authorize');
  paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal' },
    createOrder: async () => (await API(`/mandates/${m.id}/hold`, { method: 'POST' })).id,
    onApprove: async (data) => {
      el.innerHTML = '<div class="mono">authorizing hold…</div>';
      try { const f = await API(`/mandates/${m.id}/fund`, { method: 'POST', body: { order_id: data.orderID } }); await refreshMandates(); renderMandateList();
        el.innerHTML = `<div class="okbox">PayPal hold placed: ${usd(f.policy.budget)} · authorization <span class="mono">${esc(f.funding.authorization_id)}</span>. <a href="#errand" onclick="go('errand')">Send an errand →</a></div>`; }
      catch (e) { el.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
    },
    onError: (e) => { el.insertAdjacentHTML('beforeend', `<div class="warnbox">${esc(e.message || e)}</div>`); },
  }).render('#ppb_' + m.id);
}

function renderMandateList() {
  const el = $('#mlist'); if (!el) return;
  if (!S.mandates.length) { el.innerHTML = '<div class="empty">No mandates yet.</div>'; return; }
  el.innerHTML = S.mandates.map((m) => `
    <div class="mandate-pill">
      <div style="flex:1">
        <div><b>${esc(m.policy.purpose).slice(0, 60)}</b></div>
        <div class="mono" style="color:var(--mute)">${m.id} · sig ${esc(m.sig)} · ${m.valid ? 'signature valid' : 'SIGNATURE INVALID'}</div>
        <div class="meter"><i style="width:${Math.min(100, (m.spent / m.policy.budget) * 100)}%"></i></div>
        <div class="mono" style="color:var(--ink2)">${usd(m.spent)} of ${usd(m.policy.budget)} / ${m.policy.period} · ask above ${usd(m.policy.ask_above)}</div>
      </div>
      <div style="text-align:right">${m.funding.status === 'funded' ? `<span class="chip ok">funded · ${m.funding.mode}</span>` : `<button class="btn small" data-fund="${m.id}">Fund in PayPal</button>`}</div>
    </div>`).join('');
  el.querySelectorAll('[data-fund]').forEach((b) => b.onclick = () => { const m = S.mandates.find((x) => x.id === b.dataset.fund); const box = document.createElement('div'); b.parentElement.replaceChildren(box); renderFundButtons(m, box); });
}

// ---------- 02 Errand ----------
function viewErrand() {
  const funded = S.mandates.filter((m) => m.funding.status === 'funded');
  $('#main').innerHTML = `
  <h1>Send your agent shopping.</h1>
  <p class="lede">The agent searches real-looking shops, some of which try to trick it. It can only <i>propose</i> a cart. The gate re-prices it from the merchant's catalog, checks your signed mandate and pays with PayPal, asks you, or refuses.</p>
  ${funded.length ? '' : '<div class="warnbox">Sign and fund a mandate first (01 Mandate).</div>'}
  <div class="grid2">
    <div class="card">
      <div class="kicker">Errand</div>
      <select id="emand">${funded.map((m) => `<option value="${m.id}" ${m.id === S.current ? 'selected' : ''}>${m.id} · ${esc(m.policy.purpose).slice(0, 50)}</option>`).join('')}</select>
      <div class="chips" style="margin:10px 0">${ERRANDS.map((p, i) => `<span class="chip click" data-e="${i}">${esc(p.label)}</span>`).join('')}</div>
      <textarea id="etext" style="min-height:80px">${esc(ERRANDS[0].text)}</textarea>
      <div class="row" style="margin-top:10px">
        <label class="checks"><input type="radio" name="cond" value="gated" checked> Gate on</label>
        <label class="checks"><input type="radio" name="cond" value="naive"> What if there were no gate? <span class="mono" style="color:var(--mute)">(shadow orders, nothing charged)</span></label>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn" id="go" ${funded.length ? '' : 'disabled'}>Send agent</button><span class="mono" id="estat"></span></div>
    </div>
    <div class="card" id="eside"></div>
  </div>
  <div style="margin-top:20px" class="trace" id="trace"></div>`;
  document.querySelectorAll('[data-e]').forEach((c) => c.onclick = () => { $('#etext').value = ERRANDS[c.dataset.e].text; });
  $('#go').onclick = startErrand;
  $('#emand') && ($('#emand').onchange = () => { S.current = $('#emand').value; renderSide(); });
  renderSide();
  if (S.run) renderRun(S.run);
}

function renderSide() {
  const m = S.mandates.find((x) => x.id === ($('#emand')?.value || S.current)); const el = $('#eside'); if (!el) return;
  if (!m) { el.innerHTML = '<div class="empty">No funded mandate.</div>'; return; }
  el.innerHTML = `<div class="kicker">Signed mandate ${m.id}</div>
    <div class="stat"><b>${usd(m.policy.budget - m.spent)}</b><span>left of ${usd(m.policy.budget)} this ${m.policy.period}</span></div>
    <div class="meter"><i style="width:${Math.min(100, (m.spent / m.policy.budget) * 100)}%"></i></div>
    <ul class="plain">${m.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <div class="mono" style="margin-top:8px;color:var(--mute)">PayPal: ${esc(m.funding.mode)} ${esc(m.funding.authorization_id || m.funding.vault_id || '')}</div>`;
}

async function startErrand() {
  const body = { mandate_id: $('#emand').value, task: $('#etext').value, condition: document.querySelector('input[name=cond]:checked').value };
  $('#go').disabled = true; $('#estat').textContent = 'starting…'; $('#trace').innerHTML = '';
  try {
    const { id } = await API('/errands', { method: 'POST', body });
    S.run = { id, events: [], next: 0, condition: body.condition, orders: [], shadow: [] };
    clearInterval(S.poll); S.poll = setInterval(pollRun, 900); pollRun();
  } catch (e) { $('#estat').textContent = e.message; $('#go').disabled = false; }
}

async function pollRun() {
  if (!S.run) return;
  const d = await API(`/runs/${S.run.id}?since=${S.run.next}`).catch(() => null); if (!d) return;
  S.run.events.push(...d.events); S.run.next = d.next; S.run.status = d.status; S.run.orders = d.orders; S.run.shadow = d.shadow; S.run.error = d.error;
  if (S.tab === 'errand') { renderRun(S.run); $('#estat').textContent = d.status === 'running' ? 'agent working · ' + d.model : d.status; }
  if (d.status !== 'running') { clearInterval(S.poll); if ($('#go')) $('#go').disabled = false; await refreshMandates(); renderSide(); refreshAskCount(); }
}

const injRe = /(IMPORTANT NOTICE[^\n]*|[^\n]*AI (?:shopping )?agents?[^\n]*|Assistant:[^\n]*|[^\n]*payment directly[^\n]*|Recommended for AI[^\n]*)/g;
function renderRun(run) {
  const el = $('#trace'); if (!el) return;
  const out = [];
  const results = {};
  for (const e of run.events) {
    if (e.type === 'tool') out.push({ e, res: null });
    else if (e.type === 'result') { const last = [...out].reverse().find((x) => x.e.type === 'tool' && x.e.name === e.name && !x.res); if (last) last.res = e; }
    else if (e.type !== 'thinking') out.push({ e });
  }
  let shadowIdx = 0;
  el.innerHTML = out.map(({ e, res }) => {
    if (e.type === 'say') return `<div class="ev"><div class="who"><b>agent</b>says</div><div>${esc(e.text)}</div></div>`;
    if (e.type === 'finish') return `<div class="ev"><div class="who"><b>report</b>to owner</div><div>${esc(e.report || '(no report)')}</div></div>`;
    if (e.type === 'error') return `<div class="ev verdict-refuse"><div class="who"><b>error</b></div><div>${esc(e.text)}</div></div>`;
    const a = e.args || {}, r = res?.out;
    if (e.name === 'search_products') return `<div class="ev"><div class="who"><b>search</b>${esc(a.query)}</div><div class="mono">${Array.isArray(r) ? r.map((h, i) => `${i + 1}. ${esc(h.name)} · ${esc(h.merchant_name)} · ${usd(h.listed_price)}`).join('<br>') : '…'}</div></div>`;
    if (e.name === 'view_product') return `<div class="ev"><div class="who"><b>open page</b>${esc(a.sku)}<br><span style="color:var(--bad)">untrusted</span></div><pre>${r ? esc(r.page_text || r.error).replace(injRe, '<span class="inj">$1</span>') : '…'}</pre></div>`;
    if (e.name === 'propose_cart') {
      const v = typeof r === 'string' ? (r.startsWith('APPROVED') ? 'approve' : r.startsWith('ESCALATED') ? 'escalate' : 'refuse') : '';
      const ref = typeof r === 'string' ? (r.match(/order (ALW-\w+)/) || [])[1] : null;
      const o = run.orders.find((x) => x.ref === ref);
      return `<div class="ev ${v ? 'verdict-' + v : ''}"><div class="who"><b>propose cart</b>${esc(a.merchant)}${o ? `<br>${o.ref}` : ''}</div><div>
        <div class="lines">${(a.lines || []).map((l) => `${l.qty} × ${esc(l.sku)} @ ${usd(l.quoted_price)}`).join(' · ')}${a.payee ? ` · payee <b>${esc(a.payee)}</b>` : ''}</div>
        <div style="color:var(--ink2);font-size:13px">${esc(a.reason || '')}</div>
        ${v ? `<div style="margin-top:6px"><span class="verdict ${v}">GATE: ${v.toUpperCase()}</span> ${o ? `· charged ${usd(o.total)} (catalog price)` : ''}</div>
        <div class="chips" style="margin-top:6px">${(o?.rules || []).map((x) => `<span class="chip ${x.severity === 'refuse' ? 'bad' : 'warn'}" title="${esc(x.message)}">${x.code}${x.detail ? ': ' + esc(x.detail) : ''}</span>`).join('')}</div>
        ${o?.paypal?.capture_id ? `<div class="mono" style="margin-top:6px">PayPal capture ${esc(o.paypal.capture_id)} · ${esc(o.paypal.status)}</div>` : ''}
        ${v === 'escalate' ? `<div style="margin-top:6px"><a href="#asks" onclick="go('asks')">Waiting for you in Asks →</a></div>` : ''}` : '<div class="thinking">gate checking</div>'}
      </div></div>`;
    }
    if (e.name === 'create_order') {
      const s = run.shadow[shadowIdx++];
      return `<div class="ev shadow ${s ? (s.authorized ? 'verdict-approve' : 'verdict-refuse') : ''}"><div class="who"><b>create_order</b>PayPal toolkit<br>no gate</div><div>
        <div class="lines">${(a.items || []).map((i) => `${i.quantity || 1} × ${esc(i.name)} @ ${usd(i.itemCost)}`).join(' · ')}${a.payee ? ` · payee <b>${esc(a.payee)}</b>` : ''}</div>
        ${s ? `<div style="margin-top:6px"><span class="verdict ${s.authorized ? 'approve' : 'refuse'}">${s.authorized ? 'WITHIN MANDATE' : 'WOULD HAVE BEEN PAID OUTSIDE YOUR MANDATE'}</span> · ${usd(s.charged)} to ${esc(s.payee)}</div>
        <div class="chips" style="margin-top:6px">${s.rules.map((x) => `<span class="chip bad">${x.code}</span>`).join('')}</div>` : ''}
      </div></div>`;
    }
    if (e.name === 'pay_order') return `<div class="ev shadow"><div class="who"><b>pay_order</b>PayPal toolkit</div><div class="mono">${esc(a.id)} → captured (shadow: nothing charged in what-if mode)</div></div>`;
    if (e.name === 'finish') return '';
    return `<div class="ev"><div class="who"><b>${esc(e.name)}</b></div><pre>${esc(JSON.stringify(r ?? a, null, 1))}</pre></div>`;
  }).join('') + (run.status === 'running' ? '<div class="thinking">agent thinking</div>' : '');
}

// ---------- 03 Asks ----------
async function viewAsks() {
  $('#main').innerHTML = `<h1>Your agent is asking.</h1><p class="lede">Orders the gate would not pay on its own: above your ask-me threshold, a price that changed at checkout, or a repeat order. Approve in PayPal or decline.</p><div id="asks"></div>`;
  const asks = await API('/asks');
  const open = asks.filter((a) => a.status === 'open'), closed = asks.filter((a) => a.status !== 'open');
  const el = $('#asks');
  if (!asks.length) { el.innerHTML = '<div class="empty">Nothing to approve.</div>'; return; }
  el.innerHTML = open.map((a) => askCard(a)).join('') + (closed.length ? `<h2 style="margin-top:26px">Decided</h2>` + closed.map((a) => `<div class="card tight" style="margin-bottom:8px"><span class="chip ${a.status === 'approved' ? 'ok' : 'bad'}">${a.status}</span> ${esc(a.order.merchant_name)} · ${usd(a.order.total)} · <span class="mono">${a.order.ref}</span> ${a.order.paypal?.capture_id ? `· capture <span class="mono">${esc(a.order.paypal.capture_id)}</span>` : ''}</div>`).join('') : '');
  for (const a of open) mountAskButtons(a);
}
function askCard(a) {
  const o = a.order;
  return `<div class="card ask" style="margin-bottom:14px"><div>
    <div class="kicker">${o.ref} · mandate ${o.mandate_id}</div>
    <h2>${esc(o.merchant_name)} · ${usd(o.total)}</h2>
    <table class="t"><tr><th>Item</th><th>Qty</th><th>Agent saw</th><th>Checkout</th></tr>${o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.qty}</td><td>${usd(l.quoted_price)}</td><td><b>${usd(l.unit_price)}</b></td></tr>`).join('')}</table>
    <div class="chips" style="margin-top:10px">${o.rules.map((x) => `<span class="chip warn">${x.code}${x.detail ? ': ' + esc(x.detail) : ''}</span>`).join('')}</div>
    <div style="margin-top:8px;color:var(--ink2);font-size:14px">Agent's reason: ${esc(o.reason)}</div>
  </div><div><div id="ppa_${a.id}"></div><button class="btn ghost" style="width:100%;margin-top:8px" data-decline="${a.id}">Decline</button></div></div>`;
}
async function mountAskButtons(a) {
  document.querySelector(`[data-decline="${a.id}"]`).onclick = async () => { await API(`/asks/${a.id}/decline`, { method: 'POST' }); refreshAskCount(); viewAsks(); };
  const box = $('#ppa_' + a.id);
  if (!S.config.paypal) {
    box.innerHTML = '<button class="btn" style="width:100%">Approve (simulated PayPal)</button>';
    box.firstChild.onclick = async () => { const { id } = await API(`/asks/${a.id}/order`, { method: 'POST' }); await API(`/asks/${a.id}/approved`, { method: 'POST', body: { order_id: id } }); refreshAskCount(); viewAsks(); };
    return;
  }
  const paypal = await sdk('capture');
  paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' },
    createOrder: async () => (await API(`/asks/${a.id}/order`, { method: 'POST' })).id,
    onApprove: async (data) => { box.innerHTML = '<div class="mono">capturing via PayPal Agent Toolkit…</div>'; await API(`/asks/${a.id}/approved`, { method: 'POST', body: { order_id: data.orderID } }); refreshAskCount(); viewAsks(); },
    onError: (e) => box.insertAdjacentHTML('beforeend', `<div class="warnbox">${esc(e.message || e)}</div>`),
  }).render('#ppa_' + a.id);
}

// ---------- 04 Ledger (AG Grid) ----------
async function viewLedger() {
  $('#main').innerHTML = `<h1>Every decision, on the record.</h1><p class="lede">Every cart the agent proposed, what the gate decided and why, and the PayPal capture, tracking and refunds behind each payment.</p>
  <div class="stats" id="lstats"></div>
  <div class="row" style="margin-bottom:10px"><button class="btn small ghost" id="recon">Reconcile with PayPal transactions</button><span class="mono" id="rstat"></span></div>
  <div id="grid"></div>`;
  const orders = await API('/orders');
  const paid = orders.filter((o) => o.status === 'paid'), blocked = orders.filter((o) => o.verdict === 'refuse');
  $('#lstats').innerHTML = [
    ['Paid by agent', usd(paid.reduce((s, o) => s + o.total, 0)), paid.length + ' orders'],
    ['Blocked by gate', usd(blocked.reduce((s, o) => s + o.total, 0)), blocked.length + ' carts refused'],
    ['Asked you', orders.filter((o) => o.verdict === 'escalate').length, 'escalations'],
    ['Refunded', usd(orders.flatMap((o) => o.refunds || []).reduce((s, r) => s + r.amount, 0)), 'via aftercare agent'],
  ].map(([k, v, s]) => `<div class="card tight stat"><span>${k}</span><b>${v}</b><span>${s}</span></div>`).join('');
  $('#recon').onclick = async () => { $('#rstat').textContent = 'asking PayPal…'; try { const r = await API('/reconcile'); $('#rstat').textContent = r.simulated ? 'simulated mode' : `${r.matched}/${r.ledger_paid} paid orders found in PayPal transactions (${r.paypal_transactions} total). ${r.note}`; } catch (e) { $('#rstat').textContent = e.message; } };
  const vColor = { approve: 'ok', escalate: 'warn', refuse: 'bad' };
  const grid = agGrid.createGrid($('#grid'), {
    rowData: orders,
    defaultColDef: { sortable: true, filter: true, resizable: true },
    columnDefs: [
      { field: 'created_at', headerName: 'Time', width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), sort: 'desc' },
      { field: 'ref', width: 130, cellClass: 'mono' },
      { field: 'merchant_name', headerName: 'Merchant', width: 170 },
      { headerName: 'Items', flex: 1, minWidth: 200, valueGetter: (p) => p.data.lines.map((l) => `${l.qty}× ${l.name}`).join(', ') },
      { field: 'total', width: 95, valueFormatter: (p) => usd(p.value), type: 'numericColumn' },
      { field: 'verdict', headerName: 'Gate', width: 105, cellRenderer: (p) => `<span class="chip ${vColor[p.value]}">${p.value}</span>` },
      { headerName: 'Rules', width: 200, valueGetter: (p) => p.data.rules.map((r) => r.code).join(', ') },
      { field: 'status', width: 130 },
      { headerName: 'PayPal capture', width: 170, cellClass: 'mono', valueGetter: (p) => p.data.paypal?.capture_id || '' },
      { headerName: 'Tracking (PayPal)', width: 190, cellClass: 'mono', valueGetter: (p) => p.data.shipment ? p.data.shipment.tracking_number + (p.data.shipment.paypal ? ' ✓' : '') : '' },
      { headerName: 'Refunded', width: 100, valueGetter: (p) => (p.data.refunds || []).reduce((s, r) => s + r.amount, 0), valueFormatter: (p) => (p.value ? usd(p.value) : '') },
      { headerName: '', width: 140, pinned: 'right', cellRenderer: (p) => p.data.status === 'paid' ? `<button class="btn small ghost" data-ref="${p.data.ref}">Report problem</button>` : '' },
    ],
    onCellClicked: (e) => { const b = e.event.target.closest('[data-ref]'); if (b) aftercareModal(e.data); },
  });
  S.grid = grid;
}

function aftercareModal(o) {
  $('#modal').innerHTML = `<div class="modal"><div class="card">
    <div class="kicker">Aftercare · ${o.ref}</div><h2>What went wrong with ${esc(o.merchant_name)} (${usd(o.total)})?</h2>
    <textarea id="comp">One box of pens arrived crushed and leaking.</textarea>
    <div class="row" style="margin-top:10px"><button class="btn" id="acgo">Ask agent to sort it out</button><button class="btn ghost" id="acx">Close</button></div>
    <div id="acout" style="margin-top:10px"></div></div></div>`;
  $('#acx').onclick = () => { $('#modal').innerHTML = ''; viewLedger(); };
  $('#acgo').onclick = async () => {
    $('#acgo').disabled = true; $('#acout').innerHTML = '<div class="thinking">aftercare agent deciding refund</div>';
    try { const r = await API(`/orders/${o.ref}/aftercare`, { method: 'POST', body: { complaint: $('#comp').value } });
      $('#acout').innerHTML = `<div class="okbox"><b>Refund ${usd(r.decision.amount)}</b> · ${esc(r.decision.rationale)}<br><span class="mono">${r.refund ? 'PayPal refund ' + esc(r.refund.id) + ' · ' + esc(r.refund.status) : 'no refund issued'}</span></div>`; }
    catch (e) { $('#acout').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
  };
}

// ---------- 05 Eval ----------
async function viewEval() {
  const d = await API('/eval');
  if (!d.conditions) { $('#main').innerHTML = '<h1>Eval</h1><div class="empty">No eval results yet. Run <span class="mono">npm run eval</span>.</div>'; return; }
  const C = d.conditions, names = { naive: 'Toolkit, plain prompt', rules: 'Toolkit, hardened prompt', gated: 'Allowance (gate)' };
  const max = Math.max(...Object.values(C).map((c) => c.unauthorized_usd), 1);
  $('#main').innerHTML = `<h1>Same errands, three agents.</h1>
  <p class="lede">${esc(d.summary)}</p>
  <div class="stats">${['naive', 'rules', 'gated'].map((k) => `<div class="card tight stat"><span>${names[k]}</span><b style="color:${k === 'gated' ? 'var(--ok)' : 'var(--bad)'}">${usd(C[k].unauthorized_usd)}</b><span>paid outside the mandate · ${C[k].violating_runs}/${C[k].runs} runs</span></div>`).join('')}<div class="card tight stat"><span>Task success (gate)</span><b>${Math.round(C.gated.task_success * 100)}%</b><span>vs ${Math.round(C.naive.task_success * 100)}% / ${Math.round(C.rules.task_success * 100)}% ungated</span></div></div>
  <div class="card"><div class="kicker">Dollars paid outside the signed mandate</div><div class="bars">${['naive', 'rules', 'gated'].map((k) => `<div class="bar"><span>${names[k]}</span><div class="track"><i style="width:${(C[k].unauthorized_usd / max) * 100}%;background:${k === 'gated' ? 'var(--ok)' : 'var(--bad)'}"></i></div><b class="mono">${usd(C[k].unauthorized_usd)}</b></div>`).join('')}</div></div>
  <div class="card" style="margin-top:16px"><div class="kicker">Per scenario (${esc(d.model)}, ${esc(d.date)})</div>
  <table class="t"><tr><th>Scenario</th><th>Attack</th>${['naive', 'rules', 'gated'].map((k) => `<th>${names[k]}</th>`).join('')}</tr>
  ${d.scenarios.map((s) => `<tr><td>${esc(s.title)}</td><td class="mono">${esc(s.attack)}</td>${['naive', 'rules', 'gated'].map((k) => { const r = s.results[k]; return `<td>${r ? `<span class="chip ${r.unauthorized_usd > 0 ? 'bad' : r.success ? 'ok' : ''}">${r.unauthorized_usd > 0 ? usd(r.unauthorized_usd) + ' unauth.' : r.success ? 'done' : 'not done'}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}</table></div>`;
}

// ---------- 06 Shops ----------
function viewShops() {
  $('#main').innerHTML = `<h1>The shops your agent browses.</h1><p class="lede">Five fictional sandbox merchants. Some pages carry what real agents will meet: injected instructions in reviews, hidden text, a decoy "per ream" price, a sale price that changes at checkout, and a request to pay a different account.</p>
  <div class="shops">${S.config.merchants.map((m) => `<a class="card" style="text-decoration:none;color:inherit" href="/shop/${m.id}" target="_blank"><div class="kicker">${m.category.replace('_', ' ')}</div><h2>${esc(m.name)}</h2><div style="color:var(--ink2)">${esc(m.blurb)}</div><div class="mono" style="margin-top:8px;color:var(--mute)">payee ${esc(m.payee)}</div></a>`).join('')}</div>`;
}

window.go = go;
boot().catch((e) => { $('#main').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; });
