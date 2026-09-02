// fakes.ts — hand-rolled test doubles for Builder A's (backend/pin) and
// Builder B's (prompt/questions/lenses/judge/styleGate/registry) modules,
// built strictly from the behavior BUILD_SPEC.md and the design law
// describe (design §1-§5), since those real modules do not exist in this
// worktree yet (see src/contracts.ts's NEEDS: comments). Not a stand-in for
// Builder A/B's own tests — only enough behavior to exercise ensure.ts's
// orchestration red-first.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  Backend, Lens, Manifest, RegistryOps, Question, Verdict, QuestionVerdict,
  WorkflowPin, PinnedConstants, EntityDescription, PromptResult, RunResult,
} from '../../src/contracts.js';

// ---------------------------------------------------------------------------
// prompt/slots.ts stand-ins
// ---------------------------------------------------------------------------

/** design §1: "descriptionHash(desc) = SHA-256 of the canonical JSON of the
 *  slots that affect the image." */
export function fakeDescriptionHash(desc: EntityDescription): string {
  const canonical = JSON.stringify({
    species: desc.species, bodyClass: desc.bodyClass, age: desc.age, face: desc.face,
    hair: desc.hair, garb: desc.garb, mood: desc.mood, palette: desc.palette,
    shapeTilt: desc.shapeTilt, kind: desc.kind,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** design §2: "seed = hash(packId, entityId, descriptionHash)". */
export function fakeDeriveSeed(packId: string, entityId: string, hash: string): number {
  const h = createHash('sha256').update(`${packId}:${entityId}:${hash}`).digest();
  return h.readUInt32BE(0) % 1_000_000;
}

/** design §1: frozen slot order, style token first; reads `wide-shot` from
 *  tags as this fixture's stand-in for ensure.ts's `reslot` convention. */
export function fakeBuildPrompt(desc: EntityDescription): PromptResult {
  const shot = desc.tags?.includes('wide-shot') ? 'three-quarter' : 'bust';
  const slots: Record<string, string> = {
    species: desc.species ?? '', age: desc.age ?? '', face: desc.face ?? '',
    hair: desc.hair ?? '', garb: desc.garb ?? '', mood: desc.mood ?? '',
    palette: desc.palette ?? '', shot,
  };
  const positive = [
    'sfhd style', desc.species ?? desc.bodyClass ?? '', desc.age ?? '', desc.face ?? '',
    desc.hair ?? '', desc.garb ?? '', desc.mood ?? '', desc.palette ?? '', shot,
  ].filter(Boolean).join(', ');
  return { positive, negative: 'blurry, extra limbs, wrong species', slots };
}

// ---------------------------------------------------------------------------
// gate/questions.ts stand-ins
// ---------------------------------------------------------------------------

/** design §3: 8 questions, no negation, >= 2 expected 'no'. */
export function fakeBuildQuestions(desc: EntityDescription): Question[] {
  return [
    { id: 'q-species', text: `Does the character appear to be a ${desc.species ?? 'human'}?`, expected: 'yes', required: true, kind: 'species' },
    { id: 'q-garment', text: `Is the character wearing ${desc.garb ?? 'plain clothing'}?`, expected: 'yes', required: true, kind: 'garment' },
    { id: 'q-hair', text: `Does the character have ${desc.hair ?? 'hair'}?`, expected: 'yes', required: false, kind: 'hair' },
    { id: 'q-mood', text: `Does the character's expression read as ${desc.mood ?? 'neutral'}?`, expected: 'yes', required: false, kind: 'mood' },
    { id: 'q-age', text: `Does the character look ${desc.age ?? 'adult'}?`, expected: 'yes', required: false, kind: 'age' },
    { id: 'q-sex', text: 'Does the character appear male?', expected: 'yes', required: false, kind: 'sex' },
    { id: 'q-distractor-species', text: 'Is the character a dragon?', expected: 'no', required: true, kind: 'distractor' },
    { id: 'q-distractor-prop', text: 'Is the character holding a lute?', expected: 'no', required: false, kind: 'distractor' },
  ];
}

/** BUILD_SPEC.md never names this function (see contracts.ts's NEEDS
 *  comment); one extra required question naming the variant kind. */
export function fakeBuildVariantQuestions(desc: EntityDescription, kind: string): Question[] {
  return [
    { id: 'v-kind', text: `Does the character appear ${kind.replace(/-/g, ' ')}?`, expected: 'yes', required: true, kind: 'mood' },
  ];
}

// ---------------------------------------------------------------------------
// gate/lenses.ts stand-ins
// ---------------------------------------------------------------------------

/** imagePath -> questionId -> forced answer (missing = answers `expected`,
 *  i.e. "passes"). */
export type LensScript = Record<string, Record<string, 'yes' | 'no'>>;
/** "imageA|imageB" -> forced sameness (missing = true). */
export type SameScript = Record<string, boolean>;

export function makeFakeLens(name: string, family: 'siglip' | 'ollama', script: LensScript = {}, sameScript: SameScript = {}): Lens {
  return {
    name,
    family,
    async ask(imagePath: string, q: Question) {
      const forced = script[imagePath]?.[q.id];
      const answer = forced ?? q.expected;
      return { answer, score: answer === q.expected ? 0.92 : 0.1 };
    },
    async same(imageA: string, imageB: string) {
      const forced = sameScript[`${imageA}|${imageB}`] ?? sameScript[`${imageB}|${imageA}`];
      const same = forced ?? true;
      return { same, score: same ? 0.95 : 0.15 };
    },
  };
}

/** A lens whose ask()/same() always throws — for LensFailureError coverage. */
export function makeThrowingLens(name: string, family: 'siglip' | 'ollama'): Lens {
  return {
    name,
    family,
    async ask() { throw new Error(`${name} unreachable`); },
    async same() { throw new Error(`${name} unreachable`); },
  };
}

// ---------------------------------------------------------------------------
// gate/accept.ts stand-ins
// ---------------------------------------------------------------------------

/** design §3: "a required question passes only if BOTH lenses agree with
 *  `expected`; rank by passed count ... accept = the best candidate with
 *  every required question passed, else null." (ensure.ts picks the first
 *  verdict with requiredPassed === true, so this fake must put a genuine
 *  passer first when one exists.) */
export async function fakeJudge(
  candidates: Array<{ index: number; seed: number; imagePath: string }>,
  questions: Question[],
  lenses: Lens[],
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const c of candidates) {
    const answers: QuestionVerdict[] = [];
    let passedCount = 0;
    let requiredPassed = true;
    for (const q of questions) {
      const lensAnswers = [];
      for (const lens of lenses) {
        const a = await lens.ask(c.imagePath, q);
        lensAnswers.push({ lens: lens.name, answer: a.answer, score: a.score });
      }
      const bothAgree = lensAnswers.every((a) => a.answer === q.expected);
      if (bothAgree) passedCount++;
      if (q.required && !bothAgree) requiredPassed = false;
      answers.push({ question: q, lensAnswers });
    }
    verdicts.push({ candidate: c, passedCount, requiredPassed, answers });
  }
  // rank by passed count (design §3); requiredPassed winners first so
  // ensure.ts's `.find(v => v.requiredPassed)` picks the best qualifier.
  return verdicts.sort((a, b) => Number(b.requiredPassed) - Number(a.requiredPassed) || b.passedCount - a.passedCount);
}

export async function fakeStyleGate(imagePath: string, _referencePlates: string[], rejectPaths: Set<string> = new Set()) {
  return { pass: !rejectPaths.has(imagePath), score: rejectPaths.has(imagePath) ? 0.2 : 0.88 };
}

// ---------------------------------------------------------------------------
// workflow/pin.ts stand-in
// ---------------------------------------------------------------------------

export function makeFakePin(): WorkflowPin {
  const constants: PinnedConstants = {
    models: ['qwen_image_2512_bf16.safetensors'],
    loras: [{ name: 'sfhd_style_v1', sha256: 'fixture-lora-sha256', strength: 0.8 }],
    sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 4, size: [832, 1216],
  };
  return {
    sha256: 'fixture-workflow-sha256',
    pinnedConstants: () => constants,
    fillSlots: (slots: Record<string, string>) => ({ __graph: 'fixture', slots }),
  };
}

// ---------------------------------------------------------------------------
// backends/*.ts stand-in
// ---------------------------------------------------------------------------

export function makeFakeBackend(
  name: 'local' | 'cloud' | 'file',
  imageFor: (prefix: string, seed: number) => string,
): Backend {
  return {
    name,
    async run(_graph: unknown, opts): Promise<RunResult> {
      return {
        images: [{ path: imageFor(opts.prefix, opts.seed), filename: `${opts.prefix}.png` }],
        promptId: opts.prefix,
        durationMs: 5,
      };
    },
  };
}

export function makeThrowingBackend(name: 'local' | 'cloud' | 'file', message: string): Backend {
  return {
    name,
    async run() { throw new Error(message); },
  };
}

// ---------------------------------------------------------------------------
// registry/registry.ts stand-in (in-memory)
// ---------------------------------------------------------------------------

export function makeFakeRegistry() {
  const manifests = new Map<string, Manifest>();
  const canonicalSources = new Map<string, string>();
  const variantSources = new Map<string, string>();
  const key = (root: string, packId: string, entityId: string) => `${root}::${packId}::${entityId}`;

  const ops: RegistryOps = {
    paths(root, packId, entityId) {
      const base = join(root, packId, entityId);
      return {
        canonical: join(base, 'canonical.png'),
        variantsDir: join(base, 'variants'),
        manifest: join(base, 'manifest.json'),
        silhouette: join(base, 'silhouette.png'),
      };
    },
    async readManifest(root, packId, entityId) {
      return manifests.get(key(root, packId, entityId)) ?? null;
    },
    async writeCanonical(root, packId, entityId, sourcePath) {
      canonicalSources.set(key(root, packId, entityId), sourcePath);
      return ops.paths(root, packId, entityId).canonical;
    },
    async writeVariant(root, packId, entityId, kind, sourcePath) {
      variantSources.set(`${key(root, packId, entityId)}::${kind}`, sourcePath);
      return join(ops.paths(root, packId, entityId).variantsDir, `${kind}.png`);
    },
    async writeManifest(root, packId, entityId, manifest) {
      manifests.set(key(root, packId, entityId), manifest);
      return ops.paths(root, packId, entityId).manifest;
    },
    async writeSilhouette(root, packId, entityId) {
      return ops.paths(root, packId, entityId).silhouette;
    },
  };

  return { ops, manifests, canonicalSources, variantSources, key };
}
