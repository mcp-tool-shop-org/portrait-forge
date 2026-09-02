#!/usr/bin/env node
// Gate diagnostics / calibration: for one entity and a candidates directory,
// print the style-gate score per candidate against every reference plate and
// every question's answer per lens -- the numbers the design's "A6-style
// levers set from a measured baseline on the starter cast" need
// (docs/living-world-slice-b2.md §2-3). Read-only: writes nothing to the
// registry. Usage:
//   node scripts/gate-diag.mjs --entity casts/starter-fantasy/pilgrim.json --candidates <dir> [--no-ollama]
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuestions } from '../dist/gate/questions.js';
import { createSiglipLens, createOllamaLens } from '../dist/gate/lenses.js';
import { judge, styleGate, STYLE_GATE_THRESHOLD } from '../dist/gate/accept.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const entityPath = flag('--entity'); const candDir = flag('--candidates'); const noOllama = args.includes('--no-ollama');
if (!entityPath || !candDir) { console.error('usage: gate-diag --entity <json> --candidates <dir> [--no-ollama]'); process.exit(1); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desc = JSON.parse(await readFile(entityPath, 'utf8'));
const plates = (await readdir(join(root, 'references', 'sfhd'))).filter((f) => f.endsWith('.png')).map((f) => join(root, 'references', 'sfhd', f));
const candidates = (await readdir(candDir)).filter((f) => f.endsWith('.png')).sort().map((f) => ({ id: f, imagePath: join(candDir, f) }));
const siglip = createSiglipLens();
const lenses = noOllama ? [siglip] : [siglip, createOllamaLens()];

console.log(`entity ${desc.id}: ${candidates.length} candidates, ${plates.length} plates, threshold ${STYLE_GATE_THRESHOLD}`);
for (const c of candidates) {
  const r = await styleGate(c.imagePath, plates, siglip);
  const per = [];
  for (const p of plates) per.push(`${p.split(/[\\/]/).pop()}=${(await siglip.same(c.imagePath, p)).score?.toFixed(3)}`);
  console.log(`style ${c.id}: best ${r.bestScore.toFixed(3)} (${r.bestPlate.split(/[\\/]/).pop()}) passed=${r.passed} | ${per.join(' ')}`);
}
const questions = buildQuestions(desc);
console.log('questions:');
for (const q of questions) console.log(`  ${q.id} [${q.kind}${q.required ? ', required' : ''}] expect=${q.expected}: ${q.text} | target="${q.targetPhrase}" vs ${JSON.stringify(q.contrastAlternatives)}`);
const verdicts = await judge(candidates, questions, lenses);
for (const v of verdicts) {
  console.log(`verdict ${v.candidateId}: required ${v.passedRequired}/${v.totalRequired} allRequiredPassed=${v.allRequiredPassed}`);
  for (const q of v.questionResults) console.log(`  ${q.questionId} expect=${q.expected} ${JSON.stringify(q.answers)} ${q.passed ? 'PASS' : 'fail'}`);
}
process.exit(0);
