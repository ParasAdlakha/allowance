// One OpenAI-compatible client for any provider (Gemini via its OpenAI
// endpoint by default; OpenAI, OpenRouter or Ollama also work).
// LLM_RPM throttles calls per model (free tiers allow ~5/min).
import OpenAI from 'openai';

const clients = new Map();
export function llmConfigured() { return !!process.env.LLM_API_KEY; }
export function llmModel() { return process.env.LLM_MODEL || 'gemini-3.5-flash'; }

function getClient(baseURL, apiKey) {
  const k = baseURL + '|' + apiKey;
  if (!clients.has(k)) clients.set(k, new OpenAI({ apiKey, baseURL: baseURL || undefined, timeout: 120_000, maxRetries: 0 }));
  return clients.get(k);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanes = new Map(); // model -> next allowed time
async function throttle(model) {
  const rpm = Number(process.env.LLM_RPM || 0);
  if (!rpm) return;
  const gap = 60_000 / rpm;
  const now = Date.now();
  const at = Math.max(now, lanes.get(model) || 0);
  lanes.set(model, at + gap);
  if (at > now) await sleep(at - now);
}

function retryDelay(e) {
  const s = JSON.stringify(e?.error || e?.message || '');
  const m = s.match(/retry in ([\d.]+)s/i) || s.match(/retryDelay\\?":\\?"(\d+)s/);
  return m ? Math.ceil(Number(m[1]) * 1000) + 500 : 0;
}

// Models whose daily quota ran out; skipped until the process restarts the next day.
const exhausted = new Map();
const isDaily = (e) => /PerDay|per day|RESOURCE_EXHAUSTED.*day/i.test(JSON.stringify(e?.error || '') + (e?.message || ''));

export async function chat(opts) {
  const chain = [opts.model || llmModel(), ...(process.env.LLM_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  const today = new Date().toISOString().slice(0, 10);
  let last;
  for (const model of chain) {
    if (exhausted.get(model) === today) continue;
    try { return await chatOne({ ...opts, model }); } catch (e) {
      last = e;
      if (e?.status === 429 || isDaily(e)) { exhausted.set(model, today); continue; }
      throw e;
    }
  }
  throw last || new Error('All models exhausted for today');
}

async function chatOne({ messages, tools, json = false, temperature = 0.2, model, baseURL = process.env.LLM_BASE_URL, apiKey = process.env.LLM_API_KEY }) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle(model);
    try {
      const res = await getClient(baseURL, apiKey).chat.completions.create({
        model, messages, temperature,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      });
      const msg = res.choices?.[0]?.message;
      if (!msg) throw Object.assign(new Error('Empty response from model'), { status: 503 });
      return msg;
    } catch (e) {
      last = e;
      const status = e?.status || 0;
      if (status && status < 500 && status !== 429) throw e;
      if (isDaily(e)) throw e;
      await sleep(Math.max(retryDelay(e), 2000 * 2 ** Math.min(attempt, 4)));
    }
  }
  throw last;
}

export function parseJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(a >= 0 ? s.slice(a, b + 1) : s);
}
