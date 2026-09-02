import { describe, expect, it } from 'vitest';
import { accept, judge, rankCandidates, styleGate, type Candidate, type Verdict } from '../../src/gate/accept.js';
import type { Lens, PairwiseLens } from '../../src/gate/lenses.js';
import type { Question } from '../../src/gate/questions.js';

function makeQuestions(): Question[] {
  return [
    { id: 'species', text: 'q1', targetPhrase: 'a human', contrastAlternatives: ['a dragon'], expected: 'yes', required: true, kind: 'species' },
    { id: 'age', text: 'q2', targetPhrase: 'an old man', contrastAlternatives: ['a child'], expected: 'yes', required: true, kind: 'age' },
    { id: 'distractor-species', text: 'q3', targetPhrase: 'a dragon', contrastAlternatives: ['a human'], expected: 'no', required: true, kind: 'distractor' },
  ];
}

/** A fake lens whose answers are fully scripted per question id, so the
 * gate's logic (agreement, ranking) is tested without any real vision
 * model. */
function makeFakeLens(family: Lens['family'], answers: Record<string, 'yes' | 'no'>): Lens {
  return {
    name: family,
    family,
    async ask(_imagePath, question) {
      return { answer: answers[question.id] ?? question.expected };
    },
    async same(_a, _b) {
      return { same: true, score: 0.9 };
    },
  };
}

function makeFakePairwiseLens(family: Lens['family'], winner: 'a' | 'b'): PairwiseLens {
  const base = makeFakeLens(family, {});
  return {
    ...base,
    async pairwise() {
      return { winner, raw: {} };
    },
  };
}

describe('judge', () => {
  it('requires at least two lenses', async () => {
    const lens = makeFakeLens('siglip', {});
    await expect(judge([{ id: 'c1', imagePath: '/a.png' }], makeQuestions(), [lens])).rejects.toThrow(/at least two lenses/);
  });

  it('passes a required question only when both lenses agree with expected', async () => {
    const questions = makeQuestions();
    const siglip = makeFakeLens('siglip', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const ollama = makeFakeLens('ollama', { species: 'yes', age: 'no', 'distractor-species': 'no' }); // disagrees on age
    const candidates: Candidate[] = [{ id: 'c1', imagePath: '/a.png' }];
    const [verdict] = await judge(candidates, questions, [siglip, ollama]);

    const ageResult = verdict.questionResults.find((r) => r.questionId === 'age')!;
    expect(ageResult.passed).toBe(false); // lenses disagreed
    expect(verdict.allRequiredPassed).toBe(false);
    expect(verdict.passedRequired).toBe(2); // species + distractor-species passed
  });

  it('accepts a candidate when every required question passes on both lenses', async () => {
    const questions = makeQuestions();
    const siglip = makeFakeLens('siglip', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const ollama = makeFakeLens('ollama', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const [verdict] = await judge([{ id: 'c1', imagePath: '/a.png' }], questions, [siglip, ollama]);
    expect(verdict.allRequiredPassed).toBe(true);
    expect(verdict.passedRequired).toBe(3);
  });

  it('rejects a candidate that fails a required question on either lens', async () => {
    const questions = makeQuestions();
    const siglip = makeFakeLens('siglip', { species: 'no', age: 'yes', 'distractor-species': 'no' }); // fails species
    const ollama = makeFakeLens('ollama', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const [verdict] = await judge([{ id: 'c1', imagePath: '/a.png' }], questions, [siglip, ollama]);
    expect(verdict.allRequiredPassed).toBe(false);
  });

  it('never lets an extra numeric property on a Candidate reach the Verdict', async () => {
    const questions = makeQuestions();
    const siglip = makeFakeLens('siglip', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const ollama = makeFakeLens('ollama', { species: 'yes', age: 'yes', 'distractor-species': 'no' });
    const candidateWithAesthetic = { id: 'c1', imagePath: '/a.png', aestheticScore: 9.9 } as Candidate & { aestheticScore: number };
    const [verdict] = await judge([candidateWithAesthetic], questions, [siglip, ollama]);
    expect(verdict).not.toHaveProperty('aestheticScore');
    expect(Object.keys(verdict).sort()).toEqual(
      ['allRequiredPassed', 'candidateId', 'imagePath', 'passedRequired', 'questionResults', 'totalRequired'].sort(),
    );
  });
});

describe('rankCandidates', () => {
  it('ranks by passedRequired descending with no tie', async () => {
    const verdicts: Verdict[] = [
      { candidateId: 'low', imagePath: '/low.png', passedRequired: 1, totalRequired: 3, allRequiredPassed: false, questionResults: [] },
      { candidateId: 'high', imagePath: '/high.png', passedRequired: 3, totalRequired: 3, allRequiredPassed: true, questionResults: [] },
    ];
    const ollama = makeFakePairwiseLens('ollama', 'a');
    const ranked = await rankCandidates(verdicts, ollama, 'a knight in plate armor');
    expect(ranked[0].candidateId).toBe('high');
  });

  it('breaks a tie using the ollama lens pairwise call, never an aesthetic score', async () => {
    const verdicts: Verdict[] = [
      { candidateId: 'first', imagePath: '/first.png', passedRequired: 3, totalRequired: 3, allRequiredPassed: true, questionResults: [] },
      { candidateId: 'second', imagePath: '/second.png', passedRequired: 3, totalRequired: 3, allRequiredPassed: true, questionResults: [] },
    ];
    const ollamaPicksB = makeFakePairwiseLens('ollama', 'b');
    const ranked = await rankCandidates(verdicts, ollamaPicksB, 'a knight in plate armor');
    expect(ranked[0].candidateId).toBe('second'); // "b" = the second in the tie
  });

  it('requires a pairwise-capable lens to break a tie', async () => {
    const verdicts: Verdict[] = [
      { candidateId: 'a', imagePath: '/a.png', passedRequired: 2, totalRequired: 3, allRequiredPassed: false, questionResults: [] },
      { candidateId: 'b', imagePath: '/b.png', passedRequired: 2, totalRequired: 3, allRequiredPassed: false, questionResults: [] },
    ];
    const nonPairwiseLens = makeFakeLens('siglip', {});
    await expect(rankCandidates(verdicts, nonPairwiseLens, 'desc')).rejects.toThrow(/pairwise/);
  });
});

describe('accept', () => {
  it('returns the top-ranked verdict when it passed every required question', () => {
    const ranked: Verdict[] = [
      { candidateId: 'winner', imagePath: '/w.png', passedRequired: 3, totalRequired: 3, allRequiredPassed: true, questionResults: [] },
    ];
    expect(accept(ranked)?.candidateId).toBe('winner');
  });

  it('returns null when the top-ranked verdict failed a required question', () => {
    const ranked: Verdict[] = [
      { candidateId: 'loser', imagePath: '/l.png', passedRequired: 2, totalRequired: 3, allRequiredPassed: false, questionResults: [] },
    ];
    expect(accept(ranked)).toBeNull();
  });

  it('returns null for an empty verdict list', () => {
    expect(accept([])).toBeNull();
  });
});

describe('styleGate', () => {
  it('passes when the best reference-plate similarity meets the threshold', async () => {
    const scores: Record<string, number> = { '/plate-a.png': 0.3, '/plate-b.png': 0.7 };
    const siglip: Lens = {
      name: 'siglip',
      family: 'siglip',
      async ask() {
        return { answer: 'yes' };
      },
      async same(_imagePath, plate) {
        return { same: true, score: scores[plate] };
      },
    };
    const result = await styleGate('/candidate.png', ['/plate-a.png', '/plate-b.png'], siglip, 0.5);
    expect(result.passed).toBe(true);
    expect(result.bestScore).toBe(0.7);
    expect(result.bestPlate).toBe('/plate-b.png');
  });

  it('rejects when no reference plate meets the threshold', async () => {
    const siglip: Lens = {
      name: 'siglip',
      family: 'siglip',
      async ask() {
        return { answer: 'yes' };
      },
      async same() {
        return { same: false, score: 0.1 };
      },
    };
    const result = await styleGate('/candidate.png', ['/plate-a.png'], siglip, 0.5);
    expect(result.passed).toBe(false);
  });

  it('requires at least one reference plate', async () => {
    const siglip: Lens = {
      name: 'siglip',
      family: 'siglip',
      async ask() {
        return { answer: 'yes' };
      },
      async same() {
        return { same: false, score: 0 };
      },
    };
    await expect(styleGate('/candidate.png', [], siglip)).rejects.toThrow(/at least one reference plate/);
  });
});
