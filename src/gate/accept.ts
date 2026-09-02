// The acceptance gate (design law §3, findings 22-31; BUILD_SPEC.md
// Builder B, src/gate/accept.ts). Every candidate is judged by asking
// every question to every lens; a required question passes only when
// BOTH lenses agree with `expected`; candidates rank by passed count;
// ties break on the Ollama lens's pairwise call. Never an aesthetic score
// anywhere in the ranking (finding 24, 28, 29).
import type { Question, QuestionKind } from './questions.js';
import { hasPairwise, type Lens, type PairwiseLens } from './lenses.js';

export interface Candidate {
  id: string;
  imagePath: string;
}

export interface QuestionVerdict {
  questionId: string;
  kind: QuestionKind;
  expected: 'yes' | 'no';
  /** Each lens's family name -> its answer, e.g. `{ siglip: 'yes', ollama: 'yes' }`. */
  answers: Record<string, 'yes' | 'no'>;
  /** True only when every lens answered `expected` (design law §3: "both
   * lenses agree with `expected`"). */
  passed: boolean;
}

// Deliberately NOT exporting or accepting any aesthetic/preference field --
// design law §3, finding 24/29: "never use an aesthetic or preference score
// as the gate." A `Verdict` has no such field, by construction: it is built
// field-by-field below, never by spreading a caller-supplied candidate.
export interface Verdict {
  candidateId: string;
  imagePath: string;
  passedRequired: number;
  totalRequired: number;
  allRequiredPassed: boolean;
  questionResults: QuestionVerdict[];
}

/**
 * Judge every candidate against every question through every lens.
 * Requires at least two lenses so a required question can require
 * agreement (design law §3).
 */
export async function judge(candidates: Candidate[], questions: Question[], lenses: Lens[]): Promise<Verdict[]> {
  if (lenses.length < 2) {
    throw new Error('judge requires at least two lenses so a required question can require agreement (design law §3)');
  }

  const verdicts: Verdict[] = [];
  for (const candidate of candidates) {
    const questionResults: QuestionVerdict[] = [];
    // One batched call per lens per candidate where the lens supports it
    // (Lens.askMany); per-question `ask()` fills any id the batch omitted.
    const batched = await Promise.all(
      lenses.map(async (lens) => (lens.askMany ? await lens.askMany(candidate.imagePath, questions) : {})),
    );
    for (const question of questions) {
      const perLens = await Promise.all(
        lenses.map(async (lens, li) => {
          const pre = batched[li]?.[question.id];
          const { answer } = pre ?? (await lens.ask(candidate.imagePath, question));
          return { family: lens.family, answer };
        }),
      );
      const answers: Record<string, 'yes' | 'no'> = {};
      for (const r of perLens) answers[r.family] = r.answer;
      const allAgreeWithExpected = perLens.every((r) => r.answer === question.expected);
      questionResults.push({
        questionId: question.id,
        kind: question.kind,
        expected: question.expected,
        answers,
        passed: allAgreeWithExpected,
      });
    }

    const requiredResults = questionResults.filter((_, i) => questions[i]?.required);
    const passedRequired = requiredResults.filter((r) => r.passed).length;

    // Built field-by-field -- never `{ ...candidate, ... }` -- so any extra
    // property a caller attaches to a Candidate (e.g. an aesthetic score)
    // cannot leak into the Verdict or influence ranking.
    verdicts.push({
      candidateId: candidate.id,
      imagePath: candidate.imagePath,
      passedRequired,
      totalRequired: requiredResults.length,
      allRequiredPassed: requiredResults.length > 0 && passedRequired === requiredResults.length,
      questionResults,
    });
  }
  return verdicts;
}

/**
 * Rank verdicts by passed-required count (descending). Ties among the top
 * score are broken by the Ollama lens's pairwise "which better matches this
 * description" call (design law §3, finding 28) -- never by an aesthetic
 * score. `description` is the natural-language summary the pairwise prompt
 * compares candidates against (e.g. the entity's `positive` prompt text).
 */
export async function rankCandidates(
  verdicts: Verdict[],
  ollamaLens: Lens,
  description: string,
): Promise<Verdict[]> {
  const sorted = [...verdicts].sort((a, b) => b.passedRequired - a.passedRequired);
  if (sorted.length < 2) return sorted;

  const topScore = sorted[0].passedRequired;
  const tiedForTop = sorted.filter((v) => v.passedRequired === topScore);
  if (tiedForTop.length < 2) return sorted;

  if (!hasPairwise(ollamaLens)) {
    throw new Error('rankCandidates needs a lens implementing pairwise() to break a tie (design law §3, finding 28)');
  }
  const pairwiseLens: PairwiseLens = ollamaLens;

  let champion = tiedForTop[0];
  for (let i = 1; i < tiedForTop.length; i++) {
    const { winner } = await pairwiseLens.pairwise(champion.imagePath, tiedForTop[i].imagePath, description);
    if (winner === 'b') champion = tiedForTop[i];
  }

  return [champion, ...sorted.filter((v) => v !== champion)];
}

/**
 * The best candidate with every required question passed, else `null`
 * (design law §3: "on zero acceptable candidates ... the entity keeps a
 * silhouette card"). Expects `rankedVerdicts` to already be ranked (see
 * `rankCandidates`) so index 0 is the top pick.
 */
export function accept(rankedVerdicts: Verdict[]): Verdict | null {
  const best = rankedVerdicts[0];
  if (best && best.allRequiredPassed) return best;
  return null;
}

// Placeholder style-similarity floor -- design law §3, finding 18. Not yet
// calibrated against a measured baseline on the starter cast (see final
// report NEEDS line); a real calibration pass should replace this constant
// with one derived from actual accepted-vs-rejected renders.
export const STYLE_GATE_THRESHOLD = 0.55;

export interface StyleGateResult {
  passed: boolean;
  bestScore: number;
  bestPlate: string;
}

/**
 * Style gate (design law §3): a style-descriptor similarity against the
 * sfhd reference plates (`references/sfhd/*.png`), via the SigLIP lens's
 * `same()` (which calls `image_compare`). Below threshold, the candidate
 * is rejected as off-look even if every question passed.
 */
export async function styleGate(
  imagePath: string,
  referencePlates: string[],
  siglipLens: Lens,
  threshold: number = STYLE_GATE_THRESHOLD,
): Promise<StyleGateResult> {
  if (referencePlates.length === 0) {
    throw new Error('styleGate requires at least one reference plate (design law §3, finding 18)');
  }
  let bestScore = -Infinity;
  let bestPlate = referencePlates[0];
  for (const plate of referencePlates) {
    const { score } = await siglipLens.same(imagePath, plate);
    const s = score ?? -Infinity;
    if (s > bestScore) {
      bestScore = s;
      bestPlate = plate;
    }
  }
  return { passed: bestScore >= threshold, bestScore, bestPlate };
}
