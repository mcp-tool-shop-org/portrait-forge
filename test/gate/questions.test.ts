import { describe, expect, it } from 'vitest';
import { buildQuestions } from '../../src/gate/questions.js';
import type { EntityDescription } from '../../src/prompt/slots.js';

function makeDesc(overrides: Partial<EntityDescription> = {}): EntityDescription {
  return {
    id: 'aldric',
    name: 'Brother Aldric',
    kind: 'npc',
    species: 'human',
    bodyClass: 'stocky',
    age: 'an old man',
    face: 'a weathered face',
    hair: 'a tonsure',
    garb: 'a hooded brown wool cassock',
    mood: 'a solemn expression',
    palette: 'muted browns',
    tags: ['clergy', 'prop:brass censer'],
    faction: 'the chantry',
    packId: 'starter-fantasy',
    ...overrides,
  };
}

// design law §3, finding 30: negation never appears in question text. Word
// boundaries so a substring like "known" or "unremarkable" is not a false
// positive.
const NEGATION_RE = /\b(no|not|without|never)\b|un-/i;

describe('buildQuestions', () => {
  it('produces exactly 8 questions', () => {
    const questions = buildQuestions(makeDesc());
    expect(questions).toHaveLength(8);
  });

  it('has at least two questions with expected "no", drawn from distractors', () => {
    const questions = buildQuestions(makeDesc());
    const noQuestions = questions.filter((q) => q.expected === 'no');
    expect(noQuestions.length).toBeGreaterThanOrEqual(2);
    for (const q of noQuestions) {
      expect(q.kind).toBe('distractor');
    }
  });

  it('never contains a negation word in any question text', () => {
    const questions = buildQuestions(makeDesc());
    for (const q of questions) {
      expect(q.text).not.toMatch(NEGATION_RE);
    }
  });

  it('has required flags and a valid kind on every question', () => {
    const validKinds = new Set(['species', 'sex', 'age', 'hair', 'garment', 'prop', 'mood', 'distractor']);
    const questions = buildQuestions(makeDesc());
    for (const q of questions) {
      expect(typeof q.required).toBe('boolean');
      expect(validKinds.has(q.kind)).toBe(true);
      expect(q.id).toBeTruthy();
      expect(q.targetPhrase).toBeTruthy();
      expect(q.contrastAlternatives.length).toBeGreaterThan(0);
      expect(q.contrastAlternatives).not.toContain(q.targetPhrase);
    }
  });

  it('distractors never overlap the entity\'s own description', () => {
    const desc = makeDesc();
    const questions = buildQuestions(desc);
    const distractors = questions.filter((q) => q.kind === 'distractor');
    for (const d of distractors) {
      expect(d.targetPhrase.toLowerCase()).not.toContain(desc.species!.toLowerCase());
    }
  });

  it('is deterministic for the same entity id', () => {
    const desc = makeDesc();
    const a = buildQuestions(desc);
    const b = buildQuestions(desc);
    expect(a).toEqual(b);
  });

  it('varies distractors across different entity ids', () => {
    const a = buildQuestions(makeDesc({ id: 'aldric' }));
    const b = buildQuestions(makeDesc({ id: 'a-completely-different-entity-id-42' }));
    const aDistractors = a.filter((q) => q.kind === 'distractor').map((q) => q.targetPhrase);
    const bDistractors = b.filter((q) => q.kind === 'distractor').map((q) => q.targetPhrase);
    expect(aDistractors).not.toEqual(bDistractors);
  });

  it('covers all six structural categories exactly once', () => {
    const questions = buildQuestions(makeDesc());
    const kinds = questions.filter((q) => q.kind !== 'distractor').map((q) => q.kind).sort();
    expect(kinds).toEqual(['age', 'garment', 'hair', 'mood', 'prop', 'species'].sort());
  });

  it('reads the signature prop from a prop: tag when present', () => {
    const questions = buildQuestions(makeDesc({ tags: ['prop:brass censer'] }));
    const propQuestion = questions.find((q) => q.kind === 'prop');
    expect(propQuestion?.targetPhrase).toBe('brass censer');
  });

  it('falls back to a plain generic prop phrase when no prop: tag exists', () => {
    const questions = buildQuestions(makeDesc({ tags: ['clergy'] }));
    const propQuestion = questions.find((q) => q.kind === 'prop');
    expect(propQuestion?.targetPhrase).toBeTruthy();
    expect(propQuestion?.text).not.toMatch(NEGATION_RE);
  });
});
