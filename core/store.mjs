// Tiny JSON-file store. Enough for a demo server; swap for Postgres in production.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(file) {
  let state = { mandates: {}, orders: [], asks: [], runs: {} };
  if (file && existsSync(file)) { try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* start fresh */ } }
  let timer = null;
  const save = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(state, null, 1)); }, 100);
  };
  return { state, save };
}
