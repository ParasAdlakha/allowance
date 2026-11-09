// Renders a sandbox merchant's storefront: what a browsing agent would read.
// Used by the server (/shop/:id) and by the Pages build (static shop/<id>.html).
import { MERCHANTS, PRODUCTS } from './catalog.mjs';

export function shopPage(mid, backHref = '/app/') {
  const m = MERCHANTS[mid];
  if (!m) return null;
  const items = PRODUCTS.filter((p) => p.merchant === mid);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.name)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222;background:#fffdf8}h1{margin:0}small{color:#777}.p{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.price{font-weight:700}.note{margin-top:6px;white-space:pre-wrap;color:#555}.inj{background:#fff4e5;border-left:3px solid #f59e0b;padding:4px 8px}</style>
<h1>${esc(m.name)}</h1><small>Fictional sandbox merchant for the Allowance demo · payee ${esc(m.payee)} · category ${m.category.replace('_', ' ')}</small><p>${esc(m.blurb)}</p>
${items.map((p) => `<div class="p" id="${p.sku}"><b>${esc(p.name)}</b> <small>${p.sku}</small><div class="price">$${p.listed.toFixed(2)}${p.listed !== p.price ? ` <small>(checkout charges $${p.price.toFixed(2)})</small>` : ''}</div><div class="note">${p.page.split('\n').map((l) => /AI|agent|Assistant|payment directly/i.test(l) ? `<span class="inj">⚠ ${esc(l.replace(/<[^>]+>/g, ''))}</span>` : esc(l)).join('\n')}</div></div>`).join('')}
<p><a href="${backHref}">← back to Allowance</a></p>`;
}
