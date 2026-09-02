// Ad-hoc live check (not part of the test suite): exercises both real
// lenses against a real reference plate. Run with:
//   node scripts/live-check.mjs
import { createSiglipLens, createOllamaLens } from '../dist/gate/lenses.js';
import { buildQuestions } from '../dist/gate/questions.js';

const image = new URL('../references/sfhd/knight.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const desc = {
  id: 'live-check-knight',
  name: 'Live Check Knight',
  kind: 'npc',
  species: 'human',
  bodyClass: 'noble',
  age: 'a young adult',
  hair: 'short cropped hair',
  garb: 'polished plate armor with a tabard',
  mood: 'a determined expression',
  tags: ['prop:longsword'],
  packId: 'live-check',
};

const questions = buildQuestions(desc);
const trueQuestion = questions.find((q) => q.kind === 'garment'); // expected 'yes' on this image
const distractorQuestion = questions.find((q) => q.kind === 'distractor' && q.id === 'distractor-species'); // expected 'no'

console.log('image:', image);
console.log('true question:', trueQuestion.text, '| target:', trueQuestion.targetPhrase, '| alternatives:', trueQuestion.contrastAlternatives);
console.log('distractor question:', distractorQuestion.text, '| target:', distractorQuestion.targetPhrase, '| alternatives:', distractorQuestion.contrastAlternatives);

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`[${label}] ${Date.now() - t0}ms ->`, JSON.stringify(result));
    return result;
  } catch (err) {
    console.log(`[${label}] ${Date.now() - t0}ms -> ERROR:`, err && err.message ? err.message : err);
    return null;
  }
}

async function main() {
  console.log('\n=== SigLIP lens ===');
  const siglip = createSiglipLens();
  await timed('siglip.ask(true)', () => siglip.ask(image, trueQuestion));
  await timed('siglip.ask(distractor)', () => siglip.ask(image, distractorQuestion));
  await timed('siglip.same(self)', () => siglip.same(image, image));

  console.log('\n=== Ollama lens ===');
  const ollama = createOllamaLens();
  await timed('ollama.ask(true)', () => ollama.ask(image, trueQuestion));
  await timed('ollama.ask(distractor)', () => ollama.ask(image, distractorQuestion));

  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
