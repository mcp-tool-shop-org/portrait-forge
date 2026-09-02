// ensure.test.ts — the acceptance loop (design §3) end-to-end against fakes.
// Covers: accept on round 1; reject-then-accept on round 2 with the
// re-slotted prompt; the style-gate-only rejection path; silhouette after
// both rounds are exhausted; the registry cache short-circuit; manifest
// shape; error normalization (backend/lens failures); ensureVariant's
// sameness + own-questions path and its rejection; acceptCandidates.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensurePortrait, ensureVariant, acceptCandidates,
  BackendUnreachableError, LensFailureError, NoCanonicalError, VariantRejectedError,
  defaultReslot, defaultEditPrompt,
  type EnsureDeps, type EnsureOptions,
} from '../../src/ensure.js';
import type { EntityDescription } from '../../src/contracts.js';
import {
  fakeDescriptionHash, fakeDeriveSeed, fakeBuildPrompt, fakeBuildQuestions, fakeBuildVariantQuestions,
  makeFakeLens, makeThrowingLens, fakeJudge, fakeStyleGate, makeFakePin, makeFakeBackend, makeThrowingBackend,
  makeFakeRegistry, type LensScript, type SameScript,
} from './fakes.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fx = (name: string) => join(fixturesDir, name);

function baseDesc(overrides: Partial<EntityDescription> = {}): EntityDescription {
  return {
    id: 'brother-aldric',
    name: 'Brother Aldric',
    kind: 'npc',
    species: 'human',
    bodyClass: 'stocky',
    age: 'elderly',
    face: 'weathered kind face',
    hair: 'grey tonsure',
    garb: 'brown wool cassock',
    mood: 'serene',
    palette: 'muted brown and cream',
    tags: [],
    packId: 'starter-fantasy',
    ...overrides,
  };
}

/** Round-aware fixture picker: round0 candidates all fail; round1 (index 0
 *  only) passes, so the "reject-then-accept on reslot" scenario is
 *  distinguishable purely by which fixture file a candidate resolves to. */
function roundAwareImageFor(prefix: string): string {
  const m = /-r(\d+)-(\d+)$/.exec(prefix);
  const round = m ? Number(m[1]) : 0;
  const idx = m ? Number(m[2]) : 0;
  if (round === 0) return [fx('candidate-a.png'), fx('candidate-b.png'), fx('candidate-c.png')][idx];
  return [fx('reslot-pass.png'), fx('reslot-fill-1.png'), fx('reslot-fill-2.png')][idx];
}

function makeDeps(overrides: Partial<EnsureDeps> = {}): EnsureDeps {
  return {
    buildPrompt: fakeBuildPrompt,
    descriptionHash: fakeDescriptionHash,
    deriveSeed: fakeDeriveSeed,
    buildQuestions: fakeBuildQuestions,
    buildVariantQuestions: fakeBuildVariantQuestions,
    judge: fakeJudge,
    styleGate: (imagePath, plates) => fakeStyleGate(imagePath, plates),
    pin: makeFakePin(),
    registryOps: makeFakeRegistry().ops,
    referencePlates: [fx('canonical.png')],
    reslot: defaultReslot,
    editPrompt: defaultEditPrompt,
    ...overrides,
  } as EnsureDeps;
}

describe('ensurePortrait — accept on round 1', () => {
  it('writes canonical + manifest exactly per design §5 when the first round already passes', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const script: LensScript = {}; // no forced failures -> every candidate passes every question
    const siglip = makeFakeLens('siglip', 'siglip', script);
    const ollama = makeFakeLens('ollama', 'ollama', script);
    const deps = makeDeps({ registryOps: registry.ops });
    const backend = makeFakeBackend('local', roundAwareImageFor);

    const result = await ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [siglip, ollama], workflowDir: '/wf', deps,
    });

    expect(result.status).toBe('accepted');
    expect(result.manifest).toEqual({
      descriptionHash: fakeDescriptionHash(desc),
      prompt: fakeBuildPrompt(desc),
      seed: fakeDeriveSeed(desc.packId, desc.id, fakeDescriptionHash(desc)) + 0, // candidate index 0 accepted
      workflowId: 'qwen-sfhd.portrait',
      workflowSha256: 'fixture-workflow-sha256',
      loras: [{ name: 'sfhd_style_v1', sha256: 'fixture-lora-sha256', strength: 0.8 }],
      backend: 'local',
      model: 'qwen_image_2512_bf16.safetensors',
      accepted: {
        questions: expect.arrayContaining([
          expect.objectContaining({ q: expect.any(String), expected: expect.stringMatching(/yes|no/), answer: expect.stringMatching(/yes|no/) }),
        ]),
        styleScore: 0.88,
      },
      identity: {},
      status: 'accepted',
    });
    expect(result.manifest.accepted.questions).toHaveLength(fakeBuildQuestions(desc).length);
    // design §3: balanced polarity -- at least 2 expected 'no' distractors made it into the manifest's record.
    expect(result.manifest.accepted.questions.filter((q) => q.expected === 'no').length).toBeGreaterThanOrEqual(2);
    expect(registry.canonicalSources.get(registry.key('/reg', desc.packId, desc.id))).toBe(fx('candidate-a.png'));
  });

  it('is idempotent: a second call with the same description hash returns the cached manifest without invoking the backend', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const siglip = makeFakeLens('siglip', 'siglip');
    const ollama = makeFakeLens('ollama', 'ollama');
    const deps = makeDeps({ registryOps: registry.ops });
    let backendCalls = 0;
    const backend = makeFakeBackend('local', (prefix, seed) => { backendCalls++; return roundAwareImageFor(prefix); });

    const opts: EnsureOptions = { backend, registryRoot: '/reg', lenses: [siglip, ollama], workflowDir: '/wf', deps };
    const first = await ensurePortrait(desc, opts);
    expect(first.status).toBe('accepted');
    const callsAfterFirst = backendCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await ensurePortrait(desc, opts);
    expect(second.status).toBe('cached');
    expect(second.manifest).toEqual(first.manifest);
    expect(backendCalls).toBe(callsAfterFirst); // no new renders
  });
});

describe('ensurePortrait — reject-then-accept on round 2 (re-slotted prompt)', () => {
  it('rejects every round-1 candidate on a required question, then accepts round 2 after dropping the palette slot', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    // Every round-0 candidate fails the required species question on BOTH lenses.
    const script: LensScript = {
      [fx('candidate-a.png')]: { 'q-species': 'no' },
      [fx('candidate-b.png')]: { 'q-species': 'no' },
      [fx('candidate-c.png')]: { 'q-species': 'no' },
    };
    const siglip = makeFakeLens('siglip', 'siglip', script);
    const ollama = makeFakeLens('ollama', 'ollama', script);
    const deps = makeDeps({ registryOps: registry.ops });
    const backend = makeFakeBackend('local', roundAwareImageFor);

    const result = await ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [siglip, ollama], workflowDir: '/wf', deps,
    });

    expect(result.status).toBe('accepted');
    // design §3: the re-slotted prompt drops palette and widens the shot.
    expect(result.manifest.prompt.slots.palette).toBe('');
    expect(result.manifest.prompt.slots.shot).toBe('three-quarter');
    expect(result.manifest.prompt).not.toEqual(fakeBuildPrompt(desc)); // differs from the round-1 prompt
    expect(registry.canonicalSources.get(registry.key('/reg', desc.packId, desc.id))).toBe(fx('reslot-pass.png'));
  });

  it('skips a round entirely on style-gate rejection without ever calling judge', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const siglip = makeFakeLens('siglip', 'siglip');
    const ollama = makeFakeLens('ollama', 'ollama');
    let judgeCalls = 0;
    const rejected = new Set([fx('candidate-a.png'), fx('candidate-b.png'), fx('candidate-c.png')]);
    const deps = makeDeps({
      registryOps: registry.ops,
      styleGate: async (imagePath, plates) => fakeStyleGate(imagePath, plates, rejected),
      judge: async (...args) => { judgeCalls++; return fakeJudge(...args); },
    });
    const backend = makeFakeBackend('local', roundAwareImageFor);

    const result = await ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [siglip, ollama], workflowDir: '/wf', deps,
    });

    expect(result.status).toBe('accepted'); // round 2's fixtures are not in the reject set
    expect(judgeCalls).toBe(1); // round 0's style-gate wipeout never reached judge()
  });

  it('writes a silhouette when both rounds are exhausted with no acceptable candidate', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    // Fail the required species question everywhere, in both rounds.
    const script: LensScript = {
      [fx('candidate-a.png')]: { 'q-species': 'no' },
      [fx('candidate-b.png')]: { 'q-species': 'no' },
      [fx('candidate-c.png')]: { 'q-species': 'no' },
      [fx('reslot-pass.png')]: { 'q-species': 'no' },
      [fx('reslot-fill-1.png')]: { 'q-species': 'no' },
      [fx('reslot-fill-2.png')]: { 'q-species': 'no' },
    };
    const siglip = makeFakeLens('siglip', 'siglip', script);
    const ollama = makeFakeLens('ollama', 'ollama', script);
    const deps = makeDeps({ registryOps: registry.ops });
    const backend = makeFakeBackend('local', roundAwareImageFor);

    const result = await ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [siglip, ollama], workflowDir: '/wf', deps,
    });

    expect(result.status).toBe('silhouette');
    expect(result.manifest.status).toBe('silhouette');
    expect(result.manifest.accepted).toEqual({ questions: [], styleScore: 0 });
    expect(result.manifest.identity).toEqual({});
  });
});

describe('ensurePortrait — error normalization', () => {
  it('wraps a thrown backend error as BackendUnreachableError (maps to CLI exit 3)', async () => {
    const desc = baseDesc();
    const deps = makeDeps({ registryOps: makeFakeRegistry().ops });
    const backend = makeThrowingBackend('local', 'ECONNREFUSED 127.0.0.1:8188');

    await expect(ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip')], workflowDir: '/wf', deps,
    })).rejects.toBeInstanceOf(BackendUnreachableError);
  });

  it('wraps a thrown lens error (inside styleGate) as LensFailureError (maps to CLI exit 5)', async () => {
    const desc = baseDesc();
    const deps = makeDeps({
      registryOps: makeFakeRegistry().ops,
      styleGate: async () => { throw new Error('ai-eyes unreachable'); },
    });
    const backend = makeFakeBackend('local', roundAwareImageFor);

    await expect(ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip')], workflowDir: '/wf', deps,
    })).rejects.toBeInstanceOf(LensFailureError);
  });

  it('wraps a thrown lens error (inside judge, via a throwing lens) as LensFailureError', async () => {
    const desc = baseDesc();
    const deps = makeDeps({ registryOps: makeFakeRegistry().ops });
    const backend = makeFakeBackend('local', roundAwareImageFor);
    const throwingLens = makeThrowingLens('ollama', 'ollama');

    await expect(ensurePortrait(desc, {
      backend, registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip'), throwingLens], workflowDir: '/wf', deps,
    })).rejects.toBeInstanceOf(LensFailureError);
  });
});

describe('ensureVariant — edit from canonical with sameness + the variant\'s own questions', () => {
  async function seedCanonical(registry: ReturnType<typeof makeFakeRegistry>, desc: EntityDescription) {
    await registry.ops.writeManifest('/reg', desc.packId, desc.id, {
      descriptionHash: fakeDescriptionHash(desc),
      prompt: fakeBuildPrompt(desc),
      seed: fakeDeriveSeed(desc.packId, desc.id, fakeDescriptionHash(desc)),
      workflowId: 'qwen-sfhd.portrait',
      workflowSha256: 'fixture-workflow-sha256',
      loras: [{ name: 'sfhd_style_v1', sha256: 'fixture-lora-sha256', strength: 0.8 }],
      backend: 'local',
      model: 'qwen_image_2512_bf16.safetensors',
      accepted: { questions: [], styleScore: 0.9 },
      identity: {},
      status: 'accepted',
    });
  }

  it('accepts a variant when both lenses agree on sameness and the variant question passes', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    await seedCanonical(registry, desc);
    const deps = makeDeps({ registryOps: registry.ops });
    const backend = makeFakeBackend('local', () => fx('variant-wounded.png'));

    const result = await ensureVariant(desc, 'wounded', {
      backend, registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip'), makeFakeLens('ollama', 'ollama')],
      workflowDir: '/wf', deps,
    });

    expect(result.status).toBe('accepted');
    expect(result.manifest.identity.wounded).toBeCloseTo(0.95, 5);
    expect(registry.variantSources.get(`${registry.key('/reg', desc.packId, desc.id)}::wounded`)).toBe(fx('variant-wounded.png'));
  });

  it('rejects a variant when the lenses disagree on sameness', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    await seedCanonical(registry, desc);
    const canonicalPath = registry.ops.paths('/reg', desc.packId, desc.id).canonical;
    const variantPath = fx('variant-wounded.png');
    const sameScript: SameScript = { [`${canonicalPath}|${variantPath}`]: false };
    const deps = makeDeps({
      registryOps: registry.ops,
    });
    const backend = makeFakeBackend('local', () => variantPath);

    await expect(ensureVariant(desc, 'wounded', {
      backend, registryRoot: '/reg',
      lenses: [makeFakeLens('siglip', 'siglip', {}, sameScript), makeFakeLens('ollama', 'ollama')],
      workflowDir: '/wf', deps,
    })).rejects.toBeInstanceOf(VariantRejectedError);
  });

  it('refuses a variant when no canonical has been accepted yet', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry(); // never seeded
    const deps = makeDeps({ registryOps: registry.ops });
    const backend = makeFakeBackend('local', () => fx('variant-wounded.png'));

    await expect(ensureVariant(desc, 'wounded', {
      backend, registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip'), makeFakeLens('ollama', 'ollama')],
      workflowDir: '/wf', deps,
    })).rejects.toBeInstanceOf(NoCanonicalError);
  });
});

describe('acceptCandidates — gate-only path for externally produced PNGs', () => {
  it('gates already-rendered candidates in a directory and writes canonical + manifest on accept', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const deps = makeDeps({ registryOps: registry.ops });

    const result = await acceptCandidates(desc, fixturesDir, {
      registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip'), makeFakeLens('ollama', 'ollama')], deps,
    });

    expect(result.status).toBe('accepted');
    expect(result.manifest.backend).toBe('file'); // default label for externally produced candidates
  });

  it('writes a silhouette when every candidate in the directory fails style gate', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const deps = makeDeps({
      registryOps: registry.ops,
      styleGate: async () => ({ pass: false, score: 0.1 }),
    });

    const result = await acceptCandidates(desc, fixturesDir, {
      registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip'), makeFakeLens('ollama', 'ollama')], deps,
    });

    expect(result.status).toBe('silhouette');
  });

  it('raises a config error when the candidate directory has no PNGs', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const deps = makeDeps({ registryOps: registry.ops });
    const emptyDir = dirname(fileURLToPath(import.meta.url)); // this test file's own dir has no .png files

    await expect(acceptCandidates(desc, emptyDir, {
      registryRoot: '/reg', lenses: [makeFakeLens('siglip', 'siglip')], deps,
    })).rejects.toThrow(/no PNG candidates/);
  });
});
