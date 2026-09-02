// The acceptance gate's question set (design law §3, findings 22-31).
//
// "Questions, not scores." A fixed count of atomic, positively phrased
// checks (finding 30: no negation anywhere in the text), balanced in
// polarity (finding 26: at least two whose correct answer is "no," drawn
// from distractors that never overlap the real description), coarse and
// structural (finding 31): species, age band, hair, one signature garment,
// one signature prop, mood register.
import type { EntityDescription } from '../prompt/slots.js';

export type QuestionKind =
  | 'species'
  | 'sex'
  | 'age'
  | 'hair'
  | 'garment'
  | 'prop'
  | 'mood'
  | 'distractor'
  /** A prompt-craft contract atom (Director ruling 2026-09-02): one question per atom. */
  | 'contract';

export interface Question {
  id: string;
  /** Full natural-language question text for a VLM lens. Positively
   * phrased -- design law §3, finding 30: negation never appears here. */
  text: string;
  /** The bare descriptive phrase this question is testing for. This is
   * what a SigLIP lens passes as `target` to `image_verify` (module
   * contract, src/gate/lenses.ts). */
  targetPhrase: string;
  /** >=1 contrast phrases the target must out-score for a "yes" verdict --
   * `image_verify`'s required `alternatives` (it is a RELATIVE verdict,
   * never an absolute threshold). */
  contrastAlternatives: string[];
  expected: 'yes' | 'no';
  required: boolean;
  kind: QuestionKind;
}

const FIXED_QUESTION_COUNT = 8;

// design law §3, finding 26: distractor/alternative pools kept separate
// from any real filler so a question never accidentally matches the very
// entity it is checking against.
const SPECIES_POOL = [
  'a dragon',
  'a robot',
  'a merfolk',
  'an insectoid swarm',
  'a giant slug',
  'a floating jellyfish',
] as const;

const PROP_POOL = [
  'a lute',
  'a fishing net',
  'a birdcage',
  'a wooden shield',
  'a set of juggling pins',
  'a potted plant',
] as const;

const AGE_POOL = [
  'a young child',
  'a teenager',
  'a young adult',
  'a middle-aged adult',
  'an elderly person',
] as const;

const HAIR_POOL = [
  'long braided hair',
  'a shaved head',
  'short cropped hair',
  'a wild curly mane',
  'a hooded head covering',
] as const;

const GARMENT_POOL = [
  'a hooded cassock',
  'polished plate armor',
  'ragged scrap armor',
  'a tailored merchant coat',
  'a plain apron',
] as const;

const MOOD_POOL = [
  'a calm expression',
  'a menacing scowl',
  'a cheerful grin',
  'a weary grimace',
  'a suspicious glare',
] as const;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** True when `candidate` shares words with anything in this entity's own
 * description -- used both to keep a distractor from overlapping the real
 * entity and to keep an alternative phrase from equalling its own target. */
function overlapsEntity(candidate: string, desc: EntityDescription): boolean {
  const haystack = normalize(
    [desc.species, desc.bodyClass, desc.garb, desc.face, desc.hair, desc.age, desc.mood, ...desc.tags]
      .filter((v): v is string => Boolean(v))
      .join(' '),
  );
  const needle = normalize(candidate);
  if (haystack.includes(needle)) return true;
  return needle.split(' ').some((word) => word.length > 3 && haystack.includes(word));
}

/** Deterministic pick from `pool`: the same entity always yields the same
 * distractor (never `Math.random`), while still varying across entities. */
function pickDeterministic<T extends string>(pool: readonly T[], desc: EntityDescription, salt: string): T {
  const seedSource = `${desc.id}:${salt}`;
  let h = 0;
  for (let i = 0; i < seedSource.length; i++) {
    h = (h * 31 + seedSource.charCodeAt(i)) >>> 0;
  }
  const candidates = pool.filter((c) => !overlapsEntity(c, desc));
  const usable = candidates.length > 0 ? candidates : pool;
  return usable[h % usable.length];
}

/** Up to `max` pool entries that are not the actual value (by word overlap),
 * for use as `image_verify` contrast alternatives. Always non-empty. */
function pickAlternatives<T extends string>(pool: readonly T[], actual: string, max = 3): string[] {
  const actualNorm = normalize(actual);
  const filtered = pool.filter((p) => normalize(p) !== actualNorm && !actualNorm.includes(normalize(p)));
  const usable = filtered.length > 0 ? filtered : pool;
  return usable.slice(0, max);
}

function signaturePropText(desc: EntityDescription): string {
  // Convention: a tag of the form `prop:<value>` names the signature prop
  // (design law §1: "fillers come from ... tags"). Falls back to a plain,
  // positively phrased generic when no such tag exists.
  const tag = desc.tags.find((t) => t.toLowerCase().startsWith('prop:'));
  if (tag) return tag.slice('prop:'.length).trim();
  return 'a plain handheld item';
}

/**
 * Build the FIXED count of 8 atomic questions for one entity (design law
 * §3, finding 25). Six positive checks (species, age, hair, garment, prop,
 * mood) plus exactly two negative-polarity distractor checks (finding 26).
 */
export function buildQuestions(desc: EntityDescription): Question[] {
  if (desc.contract) return buildContractQuestions(desc);
  const speciesText = desc.species ?? desc.bodyClass ?? 'a humanoid figure';
  const ageText = desc.age ?? 'an adult stage of life';
  const hairText = desc.hair ?? 'a plain hairstyle';
  const garbText = desc.garb ?? 'plain clothing';
  const propText = signaturePropText(desc);
  const moodText = desc.mood ?? 'a calm expression';

  const speciesDistractor = pickDeterministic(SPECIES_POOL, desc, 'species-distractor');
  const propDistractor = pickDeterministic(PROP_POOL, desc, 'prop-distractor');

  const questions: Question[] = [
    {
      id: 'species',
      text: `This portrait shows ${speciesText}.`,
      targetPhrase: speciesText,
      contrastAlternatives: pickAlternatives(SPECIES_POOL, speciesText),
      expected: 'yes',
      required: true,
      kind: 'species',
    },
    {
      id: 'age',
      text: `This portrait shows a character at ${ageText}.`,
      targetPhrase: ageText,
      contrastAlternatives: pickAlternatives(AGE_POOL, ageText),
      expected: 'yes',
      required: true,
      kind: 'age',
    },
    {
      id: 'hair',
      text: `This portrait shows ${hairText}.`,
      targetPhrase: hairText,
      contrastAlternatives: pickAlternatives(HAIR_POOL, hairText),
      expected: 'yes',
      required: true,
      kind: 'hair',
    },
    {
      id: 'garment',
      text: `This portrait shows the character wearing ${garbText}.`,
      targetPhrase: garbText,
      contrastAlternatives: pickAlternatives(GARMENT_POOL, garbText),
      expected: 'yes',
      required: true,
      kind: 'garment',
    },
    {
      id: 'prop',
      text: `This portrait shows the character holding ${propText}.`,
      targetPhrase: propText,
      contrastAlternatives: pickAlternatives(PROP_POOL, propText),
      expected: 'yes',
      required: true,
      kind: 'prop',
    },
    {
      id: 'mood',
      text: `This portrait shows a character with ${moodText}.`,
      targetPhrase: moodText,
      contrastAlternatives: pickAlternatives(MOOD_POOL, moodText),
      expected: 'yes',
      required: true,
      kind: 'mood',
    },
    // Negative-polarity distractors (design law §3, finding 26). Phrased
    // just as positively as the real checks -- only `expected` carries the
    // polarity, never the wording (finding 30).
    {
      id: 'distractor-species',
      text: `This portrait shows ${speciesDistractor}.`,
      targetPhrase: speciesDistractor,
      contrastAlternatives: pickAlternatives(SPECIES_POOL, speciesDistractor).length
        ? [speciesText, ...pickAlternatives(SPECIES_POOL, speciesDistractor)].slice(0, 3)
        : [speciesText],
      expected: 'no',
      required: true,
      kind: 'distractor',
    },
    {
      id: 'distractor-prop',
      text: `This portrait shows the character holding ${propDistractor}.`,
      targetPhrase: propDistractor,
      contrastAlternatives: pickAlternatives(PROP_POOL, propDistractor).length
        ? [propText, ...pickAlternatives(PROP_POOL, propDistractor)].slice(0, 3)
        : [propText],
      expected: 'no',
      required: true,
      kind: 'distractor',
    },
  ];

  if (questions.length !== FIXED_QUESTION_COUNT) {
    // Defensive -- this can only happen if the list above is edited without
    // updating FIXED_QUESTION_COUNT. The module contract requires exactly 8.
    throw new Error(`buildQuestions must produce exactly ${FIXED_QUESTION_COUNT} questions, got ${questions.length}`);
  }

  return questions;
}

/**
 * Contract path (Director ruling 2026-09-02): one atomic, positively
 * phrased question per prompt-craft atom -- must_have atoms expect "yes",
 * must_not atoms expect "no" (design law §3, findings 25/26/30: atomic,
 * balanced polarity, no negation in the text). `required` follows the
 * atom's severity. The SigLIP lens's relative verdict needs contrast
 * phrases: an expected-yes atom is contrasted against the contract's own
 * expected-no claims (padded from the generic pools), and vice versa.
 */
function buildContractQuestions(desc: EntityDescription): Question[] {
  const atoms = desc.contract?.atoms ?? [];
  const yesClaims = atoms.filter((a) => a.expected === 'yes').map((a) => a.claim);
  const noClaims = atoms.filter((a) => a.expected === 'no').map((a) => a.claim);
  const pad = (list: string[], self: string): string[] => {
    const out = list.filter((c) => c !== self).slice(0, 3);
    for (const pool of [SPECIES_POOL, PROP_POOL]) {
      for (const p of pool) {
        if (out.length >= 3) break;
        if (p !== self && !out.includes(p)) out.push(p);
      }
    }
    return out;
  };
  return atoms.map((a) => ({
    id: a.id,
    text: `This portrait shows ${a.claim}.`,
    targetPhrase: a.claim,
    contrastAlternatives: pad(a.expected === 'yes' ? noClaims : yesClaims, a.claim),
    expected: a.expected,
    required: a.required,
    kind: 'contract' as const,
  }));
}
