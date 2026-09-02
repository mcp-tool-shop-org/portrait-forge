// ensure.ts — the acceptance loop (design §3) and the manifest write (design
// §5): registry check -> prompt -> N candidates -> style gate -> judge ->
// accept -> canonical + manifest -> else second round (re-slotted prompt) ->
// else silhouette. `ensureVariant` edits from canonical with a sameness
// check plus the variant's own questions.
//
// Every dependency (prompt, gate, registry, workflow-pin, backend) is
// INJECTED via `EnsureOptions.deps` rather than imported directly, so this
// module is fully testable against fakes today — before Builder A's
// `src/backends/**` / `src/workflow/**` and Builder B's `src/prompt/**` /
// `src/gate/**` / `src/registry/**` exist in this worktree. `src/cli.ts`
// wires the real modules in at its composition root ("green expected at
// merge" — see the NEEDS: comments in `src/contracts.ts` for what each real
// module must export).
//
// design law: E:/AI/claude-rpg/docs/living-world-slice-b2.md

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EntityDescription, PromptResult, Candidate, Verdict, Lens,
  Backend, WorkflowPin, Manifest, RegistryOps,
  BuildPrompt, BuildQuestions, BuildVariantQuestions, Judge, StyleGate,
  DescriptionHash, DeriveSeed,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Errors — one code per CLI exit-code bucket (see cli.ts's mapping).
// ---------------------------------------------------------------------------

export class EnsureError extends Error {
  constructor(readonly code: string, message: string, readonly hint: string) {
    super(message);
  }
}
/** Maps to CLI exit 2 (config). */
export class ConfigError extends EnsureError {
  constructor(message: string, hint: string) { super('E_CONFIG', message, hint); }
}
/** Maps to CLI exit 3 (backend unreachable). Every `backend.run()` call in
 *  this file is wrapped so a thrown error from Builder A's real backend
 *  (whatever shape it turns out to be — E_COMFY_UNREACHABLE,
 *  E_COMFY_NODE_MISSING, E_CLOUD_KEY_MISSING per BUILD_SPEC.md) is
 *  normalized to this one code before it reaches the CLI. */
export class BackendUnreachableError extends EnsureError {
  constructor(message: string, hint: string) { super('E_BACKEND', message, hint); }
}
/** Maps to CLI exit 5 (lens failure). Every lens-mediated call
 *  (styleGate, judge, Lens.same) is wrapped the same way. */
export class LensFailureError extends EnsureError {
  constructor(message: string, hint: string) { super('E_LENS', message, hint); }
}
/** ensureVariant with no accepted canonical on record yet. */
export class NoCanonicalError extends EnsureError {
  constructor(entityId: string) {
    super(
      'E_NO_CANONICAL',
      `no accepted canonical portrait for '${entityId}'`,
      `run 'portrait-forge ensure' for this entity before requesting a variant`,
    );
  }
}
/** A rendered variant that failed sameness or its own questions — never
 *  written to the registry (design §2: "no wrong face ever ships" applies
 *  to variants too, by extension of finding 36). */
export class VariantRejectedError extends EnsureError {
  constructor(kind: string, detail: { same: boolean; passed: boolean }) {
    super(
      'E_VARIANT_REJECTED',
      `variant '${kind}' rejected (sameness=${detail.same}, questions=${detail.passed})`,
      'the canonical face may not survive this edit prompt — inspect the rendered candidate before retrying',
    );
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface EnsureDeps {
  buildPrompt: BuildPrompt;
  descriptionHash: DescriptionHash;
  deriveSeed: DeriveSeed;
  buildQuestions: BuildQuestions;
  buildVariantQuestions: BuildVariantQuestions;
  judge: Judge;
  styleGate: StyleGate;
  pin: WorkflowPin;
  registryOps: RegistryOps;
  referencePlates: string[];
  /** design §3: the second round's re-slotted prompt "drops the palette
   *  slot, widens the shot". Kept injectable (default: `defaultReslot`
   *  below) so Builder B can supply the authoritative transform without
   *  touching this file — NEEDS: src/prompt/slots.ts confirm whether this
   *  belongs there instead. */
  reslot(desc: EntityDescription): EntityDescription;
  /** design §1/§4: the edit prompt naming the variant kind for
   *  Qwen-Image-Edit. Not named anywhere in BUILD_SPEC.md (only the
   *  canonical `buildPrompt(desc)` is specified); default:
   *  `defaultEditPrompt` below. NEEDS: Builder B confirm whether a
   *  `src/prompt/**` function should own this instead. */
  editPrompt(desc: EntityDescription, kind: string): string;
}

export interface EnsureOptions {
  backend: Backend;
  registryRoot: string;
  lenses: Lens[];
  workflowDir: string;
  /** default 3 (design §3: "generate N = 3 candidates"). */
  N?: number;
  /** default 2 (design §3: "one more round ... then silhouette" = 2 total rounds). */
  rounds?: number;
  deps: EnsureDeps;
}

/** Options for `acceptCandidates` — the gate-only path added mid-build for
 *  the `accept` CLI verb (externally produced candidates: an operator ran
 *  the graph through the Comfy Cloud MCP plugin by hand, or the 'file'
 *  backend's drop-and-wait round trip already happened, and the PNGs sit in
 *  `candidateDir`). No `Backend` is invoked here — there is nothing left to
 *  render — so this only needs the manifest's `backend` label, which
 *  defaults to `'file'` since that is the only backend shape whose whole
 *  point is "candidates arrive from outside this process". */
export interface AcceptOptions {
  registryRoot: string;
  lenses: Lens[];
  deps: EnsureDeps;
  backendName?: 'local' | 'cloud' | 'file';
}

export interface EnsureResult {
  status: 'cached' | 'accepted' | 'silhouette';
  manifest: Manifest;
  imagePath: string;
}

// ---------------------------------------------------------------------------
// Default helpers (Builder C's placeholders; overridable via EnsureDeps)
// ---------------------------------------------------------------------------

/** design §3: drop the palette slot, widen the shot. `desc.palette` is
 *  simply omitted; "widen the shot" has no dedicated EntityDescription field
 *  in the spec, so this default signals it via a convention tag
 *  (`wide-shot`) in `tags` — NEEDS: Builder B confirm the real convention
 *  buildPrompt(desc) reads for "widen the shot" if it differs. */
export function defaultReslot(desc: EntityDescription): EntityDescription {
  const { palette: _palette, ...rest } = desc;
  const tags = Array.from(new Set([...(rest.tags ?? []), 'wide-shot']));
  return { ...rest, tags };
}

/** A minimal, deterministic edit prompt for the variant workflow. Real
 *  wording is a prompt-design decision Builder B may want to own instead. */
export function defaultEditPrompt(desc: EntityDescription, kind: string): string {
  return `${kind.replace(/-/g, ' ')} variant of ${desc.name}, same face and identity, ${kind.replace(/-/g, ' ')} detailing only`;
}

function kindSeedOffset(kind: string): number {
  const h = createHash('sha256').update(kind).digest();
  return h.readUInt32BE(0) % 1000;
}

// ---------------------------------------------------------------------------
// ensurePortrait
// ---------------------------------------------------------------------------

export async function ensurePortrait(desc: EntityDescription, opts: EnsureOptions): Promise<EnsureResult> {
  const N = opts.N ?? 3;
  const rounds = opts.rounds ?? 2;
  const { deps } = opts;

  const hash = deps.descriptionHash(desc);
  const existing = await deps.registryOps.readManifest(opts.registryRoot, desc.packId, desc.id);
  if (existing && existing.descriptionHash === hash) {
    const paths = deps.registryOps.paths(opts.registryRoot, desc.packId, desc.id);
    return { status: 'cached', manifest: existing, imagePath: paths.canonical };
  }

  const seedBase = deps.deriveSeed(desc.packId, desc.id, hash);
  let lastPromptResult: PromptResult | null = null;

  for (let round = 0; round < rounds; round++) {
    // design §3: "second round with a re-slotted prompt (drop the palette
    // slot, widen the shot)".
    const roundDesc = round === 0 ? desc : deps.reslot(desc);
    const promptResult = deps.buildPrompt(roundDesc);
    lastPromptResult = promptResult;

    const candidates: Candidate[] = [];
    for (let i = 0; i < N; i++) {
      // design §2: "generate N = 3 candidates (seed, seed+1, seed+2)".
      const seed = seedBase + i;
      const prefix = `${desc.packId}-${desc.id}-r${round}-${i}`;
      const graph = deps.pin.fillSlots({
        seed: String(seed),
        positive: promptResult.positive,
        negative: promptResult.negative,
        prefix,
      });
      let run;
      try {
        run = await opts.backend.run(graph, { seed, prefix });
      } catch (err) {
        throw new BackendUnreachableError(
          `backend '${opts.backend.name}' failed to render candidate ${i} (round ${round}): ${msgOf(err)}`,
          `confirm the backend is reachable — 'portrait-forge check --backend ${opts.backend.name}'`,
        );
      }
      const image = run.images[0];
      if (!image) {
        throw new BackendUnreachableError(
          `backend '${opts.backend.name}' returned no image for candidate ${i}`,
          'the workflow may be missing a SaveImage node — verify with GET /object_info',
        );
      }
      candidates.push({ index: i, seed, imagePath: image.path });
    }

    // design §3: "style gate: a style-descriptor similarity against a
    // reference plate ... below threshold the candidate is rejected as
    // off-look even if the questions pass."
    const styleScores = new Map<number, number>();
    const styled: Candidate[] = [];
    for (const c of candidates) {
      let gate;
      try {
        gate = await deps.styleGate(c.imagePath, deps.referencePlates);
      } catch (err) {
        throw new LensFailureError(
          `style gate failed on candidate ${c.index}: ${msgOf(err)}`,
          'confirm the SigLIP lens (ai-eyes) is reachable',
        );
      }
      if (gate.pass) {
        styled.push(c);
        styleScores.set(c.index, gate.score);
      }
    }
    if (styled.length === 0) continue; // every candidate was off-look; try next round

    const questions = deps.buildQuestions(desc);
    let verdicts: Verdict[];
    try {
      verdicts = await deps.judge(styled, questions, opts.lenses);
    } catch (err) {
      throw new LensFailureError(
        `judge failed (round ${round}): ${msgOf(err)}`,
        'confirm both lenses (siglip, ollama) are reachable',
      );
    }
    // design §3: "accept = the best candidate with every required question
    // passed, else null." judge() ranks; ensure.ts only needs the first
    // verdict whose requiredPassed is true (judge's own ranking already put
    // the best-qualifying candidate first among passers).
    const accepted = verdicts.find((v) => v.requiredPassed) ?? null;
    if (accepted) {
      const manifest = buildManifest({
        hash, promptResult, backend: opts.backend.name, deps,
        seed: accepted.candidate.seed,
        styleScore: styleScores.get(accepted.candidate.index) ?? 0,
        questions: accepted.answers.map((a) => ({
          q: a.question.text,
          expected: a.question.expected,
          answer: a.lensAnswers[0]?.answer ?? a.question.expected,
        })),
        status: 'accepted',
      });
      const imagePath = await deps.registryOps.writeCanonical(
        opts.registryRoot, desc.packId, desc.id, accepted.candidate.imagePath,
      );
      await deps.registryOps.writeManifest(opts.registryRoot, desc.packId, desc.id, manifest);
      return { status: 'accepted', manifest, imagePath };
    }
  }

  // design §3: "then the entity keeps a silhouette card (no wrong face ever
  // ships — 36's inconsistency cost)."
  const manifest = buildManifest({
    hash, promptResult: lastPromptResult ?? deps.buildPrompt(desc), backend: opts.backend.name, deps,
    seed: seedBase, styleScore: 0, questions: [], status: 'silhouette',
  });
  const imagePath = await deps.registryOps.writeSilhouette(opts.registryRoot, desc.packId, desc.id);
  await deps.registryOps.writeManifest(opts.registryRoot, desc.packId, desc.id, manifest);
  return { status: 'silhouette', manifest, imagePath };
}

function buildManifest(args: {
  hash: string;
  promptResult: PromptResult;
  backend: 'local' | 'cloud' | 'file';
  deps: EnsureDeps;
  seed: number;
  styleScore: number;
  questions: Array<{ q: string; expected: 'yes' | 'no'; answer: 'yes' | 'no' }>;
  status: 'accepted' | 'silhouette';
}): Manifest {
  const constants = args.deps.pin.pinnedConstants();
  return {
    descriptionHash: args.hash,
    prompt: args.promptResult,
    seed: args.seed,
    workflowId: 'qwen-sfhd.portrait',
    workflowSha256: args.deps.pin.sha256,
    loras: constants.loras,
    backend: args.backend,
    model: constants.models[0] ?? 'unknown',
    accepted: { questions: args.questions, styleScore: args.styleScore },
    identity: {},
    status: args.status,
  };
}

// ---------------------------------------------------------------------------
// ensureVariant
// ---------------------------------------------------------------------------

export async function ensureVariant(
  desc: EntityDescription,
  kind: string,
  opts: EnsureOptions,
): Promise<EnsureResult> {
  const { deps } = opts;
  const paths = deps.registryOps.paths(opts.registryRoot, desc.packId, desc.id);
  const canonicalManifest = await deps.registryOps.readManifest(opts.registryRoot, desc.packId, desc.id);
  if (!canonicalManifest || canonicalManifest.status !== 'accepted') {
    throw new NoCanonicalError(desc.id);
  }

  const editPrompt = deps.editPrompt(desc, kind);
  const seed = deps.deriveSeed(desc.packId, desc.id, canonicalManifest.descriptionHash) + kindSeedOffset(kind);
  const prefix = `${desc.packId}-${desc.id}-variant-${kind}`;
  const graph = deps.pin.fillSlots({
    canonical_image: paths.canonical,
    edit_prompt: editPrompt,
    seed: String(seed),
    prefix,
  });

  let run;
  try {
    run = await opts.backend.run(graph, { seed, prefix });
  } catch (err) {
    throw new BackendUnreachableError(
      `backend '${opts.backend.name}' failed to render variant '${kind}': ${msgOf(err)}`,
      `confirm the backend is reachable — 'portrait-forge check --backend ${opts.backend.name}'`,
    );
  }
  const image = run.images[0];
  if (!image) {
    throw new BackendUnreachableError(
      `backend '${opts.backend.name}' returned no image for variant '${kind}'`,
      'the edit workflow may be missing a SaveImage node',
    );
  }

  // design §2: "sameness check (both lenses)" — every lens must agree.
  let sameness: Array<{ same: boolean; score?: number }>;
  try {
    sameness = await Promise.all(opts.lenses.map((l) => l.same(paths.canonical, image.path)));
  } catch (err) {
    throw new LensFailureError(
      `sameness check failed for variant '${kind}': ${msgOf(err)}`,
      'confirm both lenses are reachable',
    );
  }
  const same = sameness.length > 0 && sameness.every((s) => s.same);

  // design (BUILD_SPEC.md, Builder C section): "+ the variant's own questions".
  const variantQuestions = deps.buildVariantQuestions(desc, kind);
  let verdicts: Verdict[];
  try {
    verdicts = await deps.judge([{ index: 0, seed, imagePath: image.path }], variantQuestions, opts.lenses);
  } catch (err) {
    throw new LensFailureError(
      `variant question judge failed for '${kind}': ${msgOf(err)}`,
      'confirm both lenses are reachable',
    );
  }
  const passed = verdicts[0]?.requiredPassed ?? false;

  if (!same || !passed) {
    throw new VariantRejectedError(kind, { same, passed });
  }

  const identityScores: Record<string, number> = {};
  sameness.forEach((s, idx) => {
    identityScores[opts.lenses[idx]?.name ?? `lens${idx}`] = s.score ?? (s.same ? 1 : 0);
  });
  const values = Object.values(identityScores);
  const avgIdentity = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 1;

  const variantPath = await deps.registryOps.writeVariant(opts.registryRoot, desc.packId, desc.id, kind, image.path);
  const manifest: Manifest = {
    ...canonicalManifest,
    identity: { ...canonicalManifest.identity, [kind]: avgIdentity },
  };
  await deps.registryOps.writeManifest(opts.registryRoot, desc.packId, desc.id, manifest);
  return { status: 'accepted', manifest, imagePath: variantPath };
}

// ---------------------------------------------------------------------------
// acceptCandidates — gate-only path for externally produced candidates
// (added mid-build for the `accept` CLI verb: style gate + judge + accept +
// registry write over PNGs already sitting in a directory; no Backend.run
// call at all).
// ---------------------------------------------------------------------------

export async function acceptCandidates(
  desc: EntityDescription,
  candidateDir: string,
  opts: AcceptOptions,
): Promise<EnsureResult> {
  const { deps } = opts;
  const backendName = opts.backendName ?? 'file';
  const hash = deps.descriptionHash(desc);
  const seedBase = deps.deriveSeed(desc.packId, desc.id, hash);

  let files: string[];
  try {
    files = (await readdir(candidateDir)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  } catch (err) {
    throw new ConfigError(
      `could not read candidate directory '${candidateDir}': ${msgOf(err)}`,
      'point --candidates at a directory that already holds the rendered PNGs',
    );
  }
  if (files.length === 0) {
    throw new ConfigError(
      `no PNG candidates found in '${candidateDir}'`,
      'drop rendered PNGs into --candidates <dir> before running accept',
    );
  }

  const candidates: Candidate[] = files.map((f, i) => ({
    index: i,
    seed: seedBase + i,
    imagePath: join(candidateDir, f),
  }));

  const promptResult = deps.buildPrompt(desc);

  const styleScores = new Map<number, number>();
  const styled: Candidate[] = [];
  for (const c of candidates) {
    let gate;
    try {
      gate = await deps.styleGate(c.imagePath, deps.referencePlates);
    } catch (err) {
      throw new LensFailureError(
        `style gate failed on candidate ${c.index}: ${msgOf(err)}`,
        'confirm the SigLIP lens (ai-eyes) is reachable',
      );
    }
    if (gate.pass) {
      styled.push(c);
      styleScores.set(c.index, gate.score);
    }
  }

  if (styled.length > 0) {
    const questions = deps.buildQuestions(desc);
    let verdicts: Verdict[];
    try {
      verdicts = await deps.judge(styled, questions, opts.lenses);
    } catch (err) {
      throw new LensFailureError(`judge failed: ${msgOf(err)}`, 'confirm both lenses (siglip, ollama) are reachable');
    }
    const accepted = verdicts.find((v) => v.requiredPassed) ?? null;
    if (accepted) {
      const manifest = buildManifest({
        hash, promptResult, backend: backendName, deps,
        seed: accepted.candidate.seed,
        styleScore: styleScores.get(accepted.candidate.index) ?? 0,
        questions: accepted.answers.map((a) => ({
          q: a.question.text,
          expected: a.question.expected,
          answer: a.lensAnswers[0]?.answer ?? a.question.expected,
        })),
        status: 'accepted',
      });
      const imagePath = await deps.registryOps.writeCanonical(
        opts.registryRoot, desc.packId, desc.id, accepted.candidate.imagePath,
      );
      await deps.registryOps.writeManifest(opts.registryRoot, desc.packId, desc.id, manifest);
      return { status: 'accepted', manifest, imagePath };
    }
  }

  // design §3: no candidate passed style + questions -> silhouette, same as
  // ensurePortrait's exhausted-rounds outcome ("no wrong face ever ships").
  const manifest = buildManifest({
    hash, promptResult, backend: backendName, deps,
    seed: seedBase, styleScore: 0, questions: [], status: 'silhouette',
  });
  const imagePath = await deps.registryOps.writeSilhouette(opts.registryRoot, desc.packId, desc.id);
  await deps.registryOps.writeManifest(opts.registryRoot, desc.packId, desc.id, manifest);
  return { status: 'silhouette', manifest, imagePath };
}
