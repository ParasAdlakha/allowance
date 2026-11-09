import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as node from 'node:crypto';
import * as shim from '../scripts/pages/crypto.mjs';
import { normalize, sign, verify } from '../core/mandate.mjs';
import { shopPage } from '../core/shop.mjs';

const inputs = ['', 'abc', 'x'.repeat(1000), JSON.stringify({ a: 1, b: 'ü€ 🛒' })];

test('browser SHA-256 and HMAC match node:crypto', () => {
  for (const m of inputs) {
    assert.equal(shim.createHash('sha256').update(m).digest('hex'), node.createHash('sha256').update(m).digest('hex'));
    for (const k of ['k3y', 'y'.repeat(100)]) assert.equal(shim.createHmac('sha256', k).update(m).digest('hex'), node.createHmac('sha256', k).update(m).digest('hex'));
  }
});

test('a mandate signed on the server verifies with the browser shim', () => {
  const m = sign(normalize({ budget: 50, merchants: ['paperleaf'] }), 'shared-key');
  const sig = shim.createHmac('sha256', 'shared-key').update(JSON.stringify(Object.keys(m.policy).sort().reduce((a, k) => ((a[k] = m.policy[k]), a), {}))).digest('hex');
  assert.equal(sig, m.sig);
  assert.ok(verify(m, 'shared-key'));
});

test('storefronts render every product and mark injected lines', () => {
  const html = shopPage('paperleaf', '../');
  assert.match(html, /PL-PENS-12/);
  assert.match(html, /class="inj"/);
  assert.match(html, /href="\.\.\/"/);
  assert.equal(shopPage('nope'), null);
});
