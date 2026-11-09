// Cuts the Allowance videos from the real recorded scenes (record.mjs) and the slides.
//   node video.mjs <demo|teaser> <rec dir> <slides dir> <out.mp4>
// Scenes are sped up (and labelled) when longer than their narration and hold their
// last frame when shorter. Stills (PayPal popup screenshots) are shown as frames.
// Narration: edge-tts (en-US-AvaNeural). Captions: ffmpeg drawtext.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const [cut, rec, slides, out] = process.argv.slice(2);
const work = `${rec}/edit-${cut}`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const SCENE_LEN = Object.fromEntries(JSON.parse(readFileSync(`${rec}/scenes.json`, 'utf8')).scenes.map((x) => [x.name, x.seconds]));
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const FONT = 'C\\:/Windows/Fonts/segoeuib.ttf';
const FONT_MONO = 'C\\:/Windows/Fonts/consola.ttf';
const dt = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/,/g, '\\,');
const S = (n) => `${slides}/s${n}.png`;
const EV = JSON.parse(readFileSync(new URL('../../data/eval-results.json', import.meta.url), 'utf8'));
const C = EV.conditions;
const money = (n) => `${Math.round(n)} dollars`;

const demo = [
  { scene: '01-mandate', cap: ['01 · MANDATE', 'Plain English in. A policy out. Code checks it.'],
    say: 'This is Allowance, running on the PayPal sandbox. I tell my agent the rules in plain English: keep the office stocked from two shops, under a hundred and twenty dollars a month, ask me above forty, never more than three of one thing. Gemini drafts a policy, and Allowance cross-checks it against my words. Here the model quietly allowed subscriptions. I never said that, so it is reverted.' },
  { scene: '02-sign', cap: ['02 · SIGN', 'The policy is signed. PayPal reserves the budget.'],
    say: 'I sign the mandate, and PayPal reserves the budget.' },
  { still: '03-paypal-hold-2', cap: ['PAYPAL CHECKOUT', 'One approval: an authorization hold for $120'],
    say: 'One approval in PayPal: an authorization hold for a hundred and twenty dollars. The agent can never spend past it.' },
  { scene: '04-funded', cap: ['FUNDED', 'Authorization placed. The agent can now shop.'], min: 3 },
  { scene: '05-errand', cap: ['02 · ERRAND', 'The agent shops. Pages are untrusted. It can only propose.'],
    say: 'Now an errand: paper, pens and coffee. The agent searches five sandbox shops, and some of them fight back. A review tells AI agents to order twelve boxes. The agent cannot pay. It can only propose a cart, and the gate re-prices every cart from the merchant catalog. Paper and pens: approved, and captured from the PayPal hold. Coffee: the page said eighteen dollars, checkout charges twenty four. That is escalated to me.' },
  { scene: '06-whatif', cap: ['WHAT IF', 'Same agent, PayPal Agent Toolkit, no gate: shadow orders'],
    say: 'What if the agent had PayPal\'s payment tools directly, with no gate?' },
  { still: 'whatif', app: true, cap: ['WHAT IF', 'The agent reports $18. Checkout would have taken $24.'],
    say: 'Allowance replays it in shadow mode, where nothing is charged. The agent tells me the coffee cost eighteen dollars and it is all within budget. Checkout would have taken twenty four, outside my mandate.' },
  { scene: '07-asks', cap: ['03 · ASKS', 'What the agent saw vs what checkout charges'],
    say: 'The escalation waits in my inbox: what the agent saw, what checkout charges, and why it was flagged.' },
  { still: '08-paypal-ask-2', cap: ['PAYPAL CHECKOUT', 'I approve this one order myself'],
    say: 'I approve it in PayPal, and the capture runs through the PayPal Agent Toolkit.' },
  { scene: '10-ledger', cap: ['04 · LEDGER', 'Every proposal, verdict, rule and PayPal ID'],
    say: 'Every proposal, every verdict and every PayPal capture lands in the ledger, built on AG Grid, with shipment tracking posted to PayPal.' },
  { scene: '11-aftercare', cap: ['AFTERCARE', 'A model proposes the refund. Code bounds it.'],
    say: 'If something arrives broken, I say so.' },
  { still: 'aftercare', app: true, cap: ['AFTERCARE', 'Refund through the PayPal Agent Toolkit: COMPLETED'],
    say: 'An aftercare model proposes a fair refund, code caps it at what was paid, and the refund goes through the toolkit.' },
  { scene: '12-eval', cap: ['05 · EVAL', `Ungated: $${C.naive.unauthorized_usd.toFixed(0)} outside the mandate · Allowance: $${C.gated.unauthorized_usd.toFixed(0)}`],
    say: `Does it hold up? Twelve errands, the same model and shops, three agents. With the toolkit's payment tools, agents paid ${money(C.naive.unauthorized_usd)} and ${money(C.rules.unauthorized_usd)} outside the signed mandate. Behind the gate: ${money(C.gated.unauthorized_usd)}.` },
];

const steps = cut === 'teaser'
  ? [{ slide: S(1), say: 'Allowance. Give your AI agent an allowance, not your wallet.', min: 3 },
     ...demo.filter((d) => ['05-errand', '07-asks', '12-eval'].includes(d.scene)).map((d) => ({ ...d, say: undefined, min: 6 })),
     { slide: S(8), min: 3 }]
  : [
      { slide: S(1), say: 'Hi, we are Paras and Harshita. This is Allowance: give your AI agent an allowance, not your wallet.' },
      { slide: S(2), say: 'AI agents are starting to pay for things, and they are easy to steer. In Microsoft\'s marketplace study, agents took the first offer almost every time, and some paid scam sellers. A payment tool does whatever the agent asks. So we built the missing enforcement point.' },
      ...demo,
      { slide: S(8), say: 'Allowance. The model proposes, the gate decides, PayPal pays. Thank you.', min: 4 },
    ];

const parts = [];
steps.forEach((s, i) => {
  const id = String(i).padStart(2, '0');
  let len = s.min ?? 4;
  if (s.say) {
    s.mp3 = `${work}/line-${id}.mp3`;
    execFileSync('python', ['-m', 'edge_tts', '--voice', 'en-US-AvaNeural', '--rate=+8%', '--text', s.say, '--write-media', s.mp3]);
    len = Math.max(len, dur(s.mp3) + 0.6);
  }
  const clip = `${work}/clip-${id}.mp4`;
  const vf = [];
  let input;
  if (s.scene) {
    const src = `${rec}/${s.scene}.webm`;
    if (!existsSync(src)) { console.log('skip missing', s.scene); return; }
    const sd = SCENE_LEN[s.scene] || dur(src);
    const speed = sd > len ? sd / len : 1;
    input = ['-i', src];
    vf.push(`setpts=PTS/${speed.toFixed(4)}`, 'scale=1920:1080:force_original_aspect_ratio=decrease', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf4f1e8', 'fps=30', `tpad=stop_mode=clone:stop_duration=${len}`);
    if (speed > 1.15) vf.push(`drawtext=fontfile='${FONT_MONO}':text='${dt(`sped up ${speed.toFixed(1)}×`)}':x=w-tw-40:y=40:expansion=none:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10`);
  } else if (s.still) {
    const src = `${rec}/${s.still}.png`;
    if (!existsSync(src)) { console.log('skip missing', s.still); return; }
    input = ['-loop', '1', '-i', src];
    if (s.app) vf.push('scale=-2:930', 'pad=1920:1080:(ow-iw)/2:0:color=0xf4f1e8', 'fps=30');
    else vf.push('scale=-2:880', 'pad=1920:1080:(ow-iw)/2:40:color=0xf4f1e8', 'fps=30');
  } else {
    input = ['-loop', '1', '-i', s.slide];
    vf.push('scale=1920:1080', 'fps=30');
  }
  if (s.cap) {
    vf.push('drawbox=x=0:y=ih-150:w=iw:h=150:color=0x15130f@0.88:t=fill');
    vf.push(`drawtext=fontfile='${FONT_MONO}':text='${dt(s.cap[0])}':expansion=none:x=60:y=h-122:fontsize=26:fontcolor=0x9be3b8`);
    vf.push(`drawtext=fontfile='${FONT}':text='${dt(s.cap[1])}':expansion=none:x=60:y=h-84:fontsize=44:fontcolor=white`);
  }
  const audio = s.mp3 ? ['-i', s.mp3] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...input, ...audio, '-filter_complex', `[0:v]${vf.join(',')}[v];[1:a]apad,atrim=0:${len.toFixed(2)},aresample=44100[a]`,
    '-map', '[v]', '-map', '[a]', '-t', len.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', clip]);
  parts.push(clip);
  console.log(cut, id, s.scene ?? s.still ?? 'slide', len.toFixed(1) + 's');
});
writeFileSync(`${work}/list.txt`, parts.map((p) => `file '${p.split('/').pop()}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `${work}/list.txt`, '-c', 'copy', '-movflags', '+faststart', '-metadata', 'title=Allowance', '-metadata', 'artist=Paras Adlakha and Harshita Adlakha', out]);
console.log('wrote', out, dur(out).toFixed(1), 's');
