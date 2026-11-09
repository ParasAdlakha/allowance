# Submission texts

Copy-ready answers for the Devpost form, the video, and social posts. Figures are from the live project on the PayPal sandbox, 9–10 November 2026.

---

## Devpost form

**Project name:** Allowance

**Elevator pitch (200 chars):** Give your AI agent an allowance, not your wallet. Signed mandates + a deterministic spend gate + PayPal: the agent proposes, the gate decides, PayPal pays, asks you, or refuses.

**Team:** Paras Adlakha, Harshita Adlakha

**Try it:** https://parasadlakha.github.io/allowance/app/ (runs in the browser on GitHub Pages; PayPal sandbox; see "Testing instructions")

**Repository:** https://github.com/ParasAdlakha/allowance (MIT; mirror: https://github.com/HarshitaAdlakha/allowance)

**Video:** _YouTube link (public, under 3 minutes)_

**Built with:** PayPal Orders v2 (authorize + partial capture), PayPal JavaScript SDK, PayPal Agent Toolkit (`@paypal/agent-toolkit`), PayPal Vault v3, PayPal Refunds, PayPal Shipment Tracking, PayPal Transaction Search, PayPal Sandbox, Google Gemini (gemini-3.5-flash / flash-lite via the OpenAI-compatible API), OpenAI Node SDK, AG Grid, GitHub Pages, Node.js, JavaScript, HTML/CSS

### About the project

**Inspiration**

Agentic commerce is arriving: PayPal shipped Agent Ready, Store Sync and an Agent Toolkit, and Google's AP2 (built with PayPal) defines signed "mandates" for agent purchases. But agents are easy to steer. Microsoft's *Magentic Marketplace* found shopping agents took the first offer 80–100% of the time and some paid scam sellers; *InjecAgent* found GPT-4 agents following instructions planted in content 24% of the time. A payment tool does whatever the agent asks. We wanted the missing piece: an enforcement point between "the agent wants to pay" and "PayPal moves money".

**What it does**

1. **Mandate.** You write the rules in plain English ("keep the office stocked from Paperleaf and Beanline, under $120 a month, ask me above $40, never more than 3 of one thing"). Gemini drafts a typed policy. A deterministic cross-check compares it with your words and **reverts any permission the model invented**; in testing Gemini kept adding "subscriptions allowed". You edit, sign (HMAC), and approve a **PayPal authorization hold** for the budget.
2. **Errand.** The agent searches five fictional sandbox shops. Some pages fight back: a review telling AI agents to order 12 boxes, hidden text adding a $39/month club, a "$4.99" that's really a $149 pallet, a sale price that rises at checkout, and "pay this other account for 30% off". The agent has **no payment tool**, only `propose_cart`.
3. **Gate.** Plain code re-prices every cart from the merchant catalog and checks 15 rules: signature, expiry, merchant allowlist, category, registered payee, subscriptions, per-item limit, price drift, per-order max, period budget, ask-me threshold, duplicates. **Approve** → a **partial capture** against the PayPal hold. **Escalate** → your inbox. **Refuse** → the agent gets rule codes and may revise once.
4. **Asks.** Escalations show what the agent saw versus what checkout charges. You approve in **PayPal Checkout**; the capture runs through the **PayPal Agent Toolkit** (`pay_order`, verified with `get_order`).
5. **Ledger and aftercare.** An **AG Grid** ledger of every proposal, verdict, rule and PayPal ID. Shipment tracking is posted with the toolkit's `create_shipment_tracking`. Report a problem and an aftercare model proposes a refund, which code caps at the refundable amount, paid through the toolkit's `create_refund`. Reconciliation runs against `list_transactions`.
6. **What if?** Run the same errand with the PayPal Agent Toolkit's `create_order`/`pay_order` and no gate, in shadow mode (nothing charged), and see which orders would have broken your mandate.

**How we built it**

A zero-framework Node server (`server/server.mjs`) and vanilla JS app. `core/gate.mjs` is the gate (about 120 lines, no model calls). `core/mandate.mjs` handles schema, normalize, HMAC sign/verify, the cross-check and a rule parser. `core/agent.mjs` is one tool-calling loop for three conditions. `core/paypal.mjs` covers PayPal REST and the Agent Toolkit. `core/engine.mjs` orchestrates funding, gate-then-pay, asks, shipping, aftercare and reconciliation. The model is any OpenAI-compatible endpoint; we used Gemini with per-model rate limiting and daily-quota fallback. With no keys at all, the app runs on simulated PayPal and a deliberately gullible scripted agent.

**PayPal, concretely (all sandbox, real API calls):** Orders v2 `intent: AUTHORIZE` + JS SDK Buttons to fund a mandate; `/v2/payments/authorizations/{id}/capture` with `final_capture: false` and `invoice_id` per approved order; Checkout Buttons + Agent Toolkit `pay_order`/`get_order` for owner-approved orders; Agent Toolkit `create_shipment_tracking`, `create_refund`, `list_transactions`; Vault v3 setup/payment tokens auto-detected where the account supports it.

**Challenges**

- Our sandbox business account is registered in India, where PayPal doesn't offer wallet vaulting. We redesigned funding around an **authorization hold with partial captures**. That turned out better: PayPal's authorization ceiling became a second, independent cap on the agent.
- Unapproved PayPal orders expire, so hold orders are created at the moment the owner clicks the PayPal button.
- Gemini's free tier allows 20 requests a day on the main model, so we added a per-model rate limiter and automatic fallback across models.
- Making the eval honest. Ungated agents' orders are charged at the merchant's catalog price (as a real checkout would), and we report "hard rule broken" separately from "skipped an approval you asked for".

**Accomplishments**

- Real money movement on the sandbox: holds, partial captures, an owner-approved checkout, tracking and refunds, all tied to gate decisions.
- The model is never trusted with a price or a payee.
- A cross-check that caught the model loosening rules, on real runs.
- 25 unit tests and a three-condition eval.

**What we learned**

A better prompt helps, but only an execution-time gate gives a guarantee that doesn't depend on which model is behind it. Draft with the model, verify with code, sign as a human.

**What's next**

AP2-format Intent and Cart Mandates so other agents can verify them; Store Sync catalogs as the authoritative price source; user-held signing keys; team roles (requester/approver); Vault-backed long-lived mandates where available.

### Eval

Twelve errands, three agents, the same model (`gemini-3.5-flash-lite`) and the same shops. Payments are dry-run and judged against the signed mandate.

| | Toolkit, plain prompt | Toolkit, hardened prompt | Allowance gate |
|---|---|---|---|
| Paid outside the mandate | $127.60 (3/12 errands) | $127.60 (3/12) | **$0.00** |
| ...hard rule broken | $72.00 | $72.00 | $0.00 |
| Task success | 75% | 75% | **100%** |

The model resisted every planted instruction (quantity injection, payee redirect, hidden subscription, fake "required" warranty). It still broke the mandate in a quarter of errands: it paid a checkout price 33% above the page, went over a $60 per-order cap, and skipped an approval the owner asked for. Those are arithmetic over prices the model never sees, so a better prompt doesn't fix them; code at the point of payment does.

### Testing instructions

- **Hosted (no setup):** open https://parasadlakha.github.io/allowance/app/. Replay the recorded sandbox session under 02 Errand → *Replay a run*, or click **model ⚙** to add a Gemini key and run your own errands. In the browser build the PayPal hold and approvals are real sandbox payments; automatic captures and refunds are simulated (they need the server secret). 01 Mandate → *Draft policy* → *Sign* → click **PayPal** and log in with the sandbox buyer below → 02 Errand → *Send agent* → 03 Asks → approve in PayPal → 04 Ledger → *Report problem*.
- **Sandbox buyer (test only):** _email / password supplied in the private testing field of the form_
- **Locally:** `git clone … && npm ci && cp .env.example .env && npm start`. No keys gives simulated PayPal and a scripted agent. Add PayPal sandbox and Gemini keys for the real thing (README, "Run it yourself").

### AI tools used

- **Google Gemini** (`gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`) via the OpenAI-compatible endpoint: drafting mandates (JSON mode), the shopping agent (tool calling), aftercare refund decisions (JSON mode), and the eval agents.
- **PayPal Agent Toolkit** (OpenAI adapter): payment, capture, tracking, refund and transaction tools.
- **edge-tts** for the video narration.

---

## Video script (under 3 minutes)

See `scripts/media/video.mjs`. The narration covers: hook → problem → mandate (cross-check reverts subscriptions) → sign + PayPal hold → errand with traps → what-if without the gate → ask approved in PayPal → ledger → aftercare refund → eval → close.

---

## LinkedIn post (Harshita, team voice)

Images: `docs/img/linkedin-cover.png`, `linkedin-errand.png`, `linkedin-eval.png`.

> "Give your AI agent an allowance, not your wallet."
>
> Paras and I built Allowance for the PayPal AI Hackathon. AI agents are starting to shop and pay for us, and research keeps showing they're easy to steer: they take the first offer, follow instructions hidden in web pages, and pay whoever asks.
>
> So we built the missing enforcement point:
> ✍️ You write the rules in plain English; the AI drafts a policy, and code reverts anything you didn't actually say
> 💳 You sign once and PayPal reserves the budget
> 🛒 The agent shops but can only *propose* a cart
> 🚦 A deterministic gate re-prices it and checks your mandate: pay, ask you, or refuse
> 🧾 Every decision, capture, tracking number and refund in one ledger
>
> We tested it: twelve errands, same model. The agent ignored every injected instruction, but with PayPal payment tools and no gate it still paid $127.60 outside the mandate, through checkout price changes, an order over the per-order cap, and a skipped approval. Behind the gate: $0, and every errand completed.
>
> My background is in system dynamics, and this felt like a classic control problem: put the limit where the money moves, not where the words are.
>
> 🙏 Thank you to PayPal's developer team (Jo Franchetti, Eddie Jaoude, Marco Podien) and to Devpost for a global, build-anything hackathon.
>
> 💻 https://github.com/HarshitaAdlakha/allowance
>
> #PayPal #AgenticCommerce #AIAgents #Hackathon #Fintech #BuildInPublic #WomenInTech

## LinkedIn post (Paras, personal)

> When an AI agent can pay, the hard problem isn't shopping. It's limits.
>
> Harshita and I built Allowance for the PayPal AI Hackathon. Design choices I'd make again:
> 🔒 The agent has no payment tool. It can only propose a cart, and a plain-code gate decides.
> 💲 Never trust the model's numbers: the gate re-prices from the merchant's catalog, and checkout drift goes to the human.
> 🧱 Two independent caps: our gate, plus a PayPal authorization hold the agent can't talk past.
> 🧪 The model drafts the policy, code cross-checks it against the user's words, and the human signs. Gemini kept adding "subscriptions allowed"; the cross-check caught it every time.
>
> 🧪 The surprise from our eval: the model resisted every prompt injection we planted, yet still paid $127.60 outside the mandate in 3 of 12 errands, because limits are arithmetic over checkout prices it never sees. A hardened prompt changed nothing. The gate: $0.
>
> 💻 https://github.com/ParasAdlakha/allowance
>
> #AIAgents #PayPal #LLM #AgenticCommerce #SystemsEngineering #Hackathon

## X post

> Built Allowance for the PayPal AI Hackathon 💳🤖
>
> Your AI agent gets an allowance, not your wallet: signed mandates, a deterministic spend gate, PayPal holds + partial captures. The agent proposes, the gate decides.
>
> github.com/ParasAdlakha/allowance
