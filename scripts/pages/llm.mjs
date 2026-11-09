// Browser model client for the Pages build. The visitor brings their own key
// (kept only in this browser's localStorage) and calls the provider directly.
// Same contract as core/llm.mjs: chat({messages, tools, json}) -> assistant message.
const KEY = 'allowance.llm';
export function llmSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function saveLlmSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }
export function llmConfigured() { return !!llmSettings().apiKey; }
export function llmModel() { return llmSettings().model || 'gemini-3.5-flash-lite'; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exhausted = new Set();

export async function chat({ messages, tools, json = false, temperature = 0.2 }) {
  const s = llmSettings();
  const base = (s.baseURL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/?$/, '/');
  const chain = [llmModel(), ...(s.fallbacks || ['gemini-3.1-flash-lite', 'gemini-3.5-flash'])].filter((m, i, a) => a.indexOf(m) === i);
  let last;
  for (const model of chain) {
    if (exhausted.has(model)) continue;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(base + 'chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}), ...(json ? { response_format: { type: 'json_object' } } : {}) }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const d = await res.json();
        const msg = (Array.isArray(d) ? d[0] : d).choices?.[0]?.message;
        if (msg) return msg;
      }
      const text = await res.text?.().catch(() => '') || '';
      last = new Error(`Model ${model}: ${res.status} ${text.slice(0, 200)}`);
      if (res.status === 429 && /PerDay|per day/i.test(text)) { exhausted.add(model); break; }
      if (res.status && res.status < 500 && res.status !== 429) throw last;
      const m = text.match(/retry in ([\d.]+)s/i);
      await sleep(m ? Number(m[1]) * 1000 + 500 : 1500 * 2 ** attempt);
    }
  }
  throw last || new Error('No model available');
}

export function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 ? t.slice(a, b + 1) : t);
}
