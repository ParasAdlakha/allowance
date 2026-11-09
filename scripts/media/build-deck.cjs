// Builds the Allowance deck: each rendered slide PNG full-bleed, with the spoken script in the notes.
//   node build-deck.cjs <slides png dir> <out.pptx>
const pptxgen = require("pptxgenjs");
const path = require("path");
const [dir, out] = process.argv.slice(2);

const NOTES = [
  "Hi, we're Paras and Harshita. This is Allowance: give your AI agent an allowance, not your wallet. A shopping agent can pay through PayPal, but only inside a mandate you signed.",
  "Agents are about to pay for things: Morgan Stanley puts agent-executed commerce at 190 to 385 billion dollars of US e-commerce by 2030. But agents are easy to steer. In Microsoft's Magentic Marketplace, they took the first offer 80 to 100 percent of the time and some paid scam sellers; InjecAgent found GPT-4 agents following planted instructions 24 percent of the time. A payment tool does whatever the agent asks. The missing piece is an enforcement point between the agent and the money.",
  "Four steps. Write the rules once: the model drafts a policy and code reverts anything you didn't say, then PayPal reserves the budget. The agent shops, but it has no payment tool, only a proposal tool. A gate of fifteen rules in plain code re-prices every cart from the catalog and checks it. Then PayPal pays, you decide, and everything is audited.",
  "Here's a real errand. Product pages carry traps: a review telling AI agents to order twelve boxes, a hidden subscription, a decoy price, a price that rises at checkout, a request to pay a different account. Every proposal gets a verdict and a reason the agent can act on.",
  "PayPal end to end, on the sandbox with real API calls: an authorization hold when you sign, partial captures when the gate approves, PayPal Checkout plus the Agent Toolkit's pay_order when you approve an escalation, and the toolkit's tracking, refund and transaction tools after purchase. PayPal's authorization ceiling is a second, independent cap.",
  "AI where it helps, code where it must hold. In testing, Gemini kept adding 'subscriptions allowed' to policies that never mentioned them. Allowance cross-checks every draft against your words and reverts it. Three model jobs, three guardrails.",
  "The eval: twelve errands, the same model and shops, three agents. Agents with the PayPal Agent Toolkit's payment tools paid money outside the signed mandate, even with a hardened prompt. Behind Allowance's gate, zero, with task success kept.",
  "Who it's for: small offices and households doing routine restocks, and platforms building on the PayPal Agent Toolkit that need a policy layer. Next: AP2-format mandates, Store Sync catalogs as the price source, user-held keys. Let the agent buy the coffee; never let it buy the pallet. Thank you.",
];

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Allowance";
pres.author = "Paras Adlakha and Harshita Adlakha";
pres.company = "Paras Adlakha and Harshita Adlakha";
pres.subject = "PayPal AI Hackathon 2026";
NOTES.forEach((note, i) => {
  const slide = pres.addSlide();
  slide.addImage({ path: path.join(dir, `s${i + 1}.png`), x: 0, y: 0, w: 10, h: 5.625, altText: `Allowance slide ${i + 1}` });
  slide.addNotes(note);
});
pres.writeFile({ fileName: out }).then((f) => console.log("wrote", f));
