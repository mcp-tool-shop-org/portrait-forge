#!/usr/bin/env node
// cli.ts — `portrait-forge ensure --entity <json|-> --backend local|cloud|file
//            [--registry <dir>] [--n <n>] [--out <dir>] [--wait-ms <n>]`
//          `portrait-forge variant --entity <json|-> --kind <kind>
//            [--backend local|cloud|file] [--registry <dir>] [--out <dir>] [--wait-ms <n>]`
//          `portrait-forge check --backend local|cloud|file [--out <dir>]`
//          `portrait-forge cast --file <json array> [--backend local|cloud|file] [--registry <dir>]`
//          `portrait-forge accept --entity <json|-> --candidates <dir> [--registry <dir>]`
// Exit codes: 0 ok, 1 usage, 2 config, 3 backend unreachable,
//             4 gate failed (silhouette written), 5 lens failure.
// Errors print `error:` + `hint:` to stderr.
//
// This file is the composition root: `composeRealDeps` wires the real
// prompt/gate/registry/workflow/backend modules in via dynamic import (see
// the `NEEDS:` comments below and in src/contracts.ts) so it can typecheck
// today even though those modules do not exist in this worktree yet — the
// wiring is exercised only when the CLI actually runs, and is
// "green expected at merge". Every command handler instead talks to the
// injected `ComposedDeps` interface, so tests call `main(argv, overrides)`
// with fakes and never touch `composeRealDeps` at all.

import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensurePortrait, ensureVariant, acceptCandidates,
  ConfigError, BackendUnreachableError, LensFailureError, NoCanonicalError, VariantRejectedError,
  defaultReslot, defaultEditPrompt,
  type EnsureDeps, type EnsureResult,
} from './ensure.js';
import type { EntityDescription, Backend, Lens, Manifest, PinnedConstants, Question } from './contracts.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { readdir } from 'node:fs/promises';
import { buildPrompt, descriptionHash, deriveSeed, type EntityDescription as RealEntityDescription } from './prompt/slots.js';
import { buildQuestions, type Question as RealQuestion } from './gate/questions.js';
import { judge as judgeReal, rankCandidates, styleGate as styleGateReal } from './gate/accept.js';
import { createSiglipLens, createOllamaLens, type Lens as RealLens } from './gate/lenses.js';
import { loadWorkflow, workflowSha256, fillSlots, pinnedConstants } from './workflow/pin.js';
import { registryPaths, readManifest, writeManifest, writeCanonical, writeVariant, writeSilhouette, type Manifest as RegistryManifest } from './registry/registry.js';
import { LocalComfyBackend } from './backends/local.js';
import { CloudComfyBackend } from './backends/cloud.js';
import { FileDropBackend } from './backends/file.js';
import type { Backend as RealBackend } from './backends/types.js';

// ---------------------------------------------------------------------------
// Usage / small helpers
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    'portrait-forge -- consistent character portraits from text descriptions',
    '',
    'Usage:',
    '  portrait-forge ensure --entity <json|-> --backend local|cloud|file [--registry <dir>] [--n <n>] [--out <dir>] [--wait-ms <n>]',
    '  portrait-forge variant --entity <json|-> --kind <kind> [--backend local|cloud|file] [--registry <dir>] [--out <dir>] [--wait-ms <n>]',
    '  portrait-forge check --backend local|cloud|file [--out <dir>]',
    '  portrait-forge cast --file <json array> [--backend local|cloud|file] [--registry <dir>]',
    '  portrait-forge accept --entity <json|-> --candidates <dir> [--registry <dir>]',
    '',
    'Env: COMFY_CLOUD_API_KEY (cloud backend), OLLAMA_HOST (ollama lens).',
    'Exit codes: 0 ok, 1 usage, 2 config, 3 backend unreachable, 4 gate failed (silhouette written), 5 lens failure.',
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

class UsageError extends Error {
  readonly code = 'E_USAGE';
  constructor(message: string, readonly hint: string) { super(message); }
}

async function readEntity(value: string | undefined): Promise<EntityDescription> {
  if (!value) throw new UsageError('missing --entity', usage());
  let text: string;
  if (value === '-') {
    text = await readStdin();
  } else if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
    text = value;
  } else {
    try {
      text = await readFile(value, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `could not read entity file '${value}': ${err instanceof Error ? err.message : String(err)}`,
        'pass a path to a JSON file, inline JSON starting with { , or - for stdin',
      );
    }
  }
  try {
    return JSON.parse(text) as EntityDescription;
  } catch (err) {
    throw new ConfigError(
      `--entity is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'the entity must be a JSON object matching EntityDescription',
    );
  }
}

async function readEntities(filePath: string | undefined): Promise<EntityDescription[]> {
  if (!filePath) throw new UsageError('missing --file', usage());
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `could not read cast file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      'pass a path to a JSON file containing an array of entity descriptions',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(
      `--file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'the cast file must be a JSON array of EntityDescription objects',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError('--file must contain a JSON array', 'wrap the entity descriptions in [ ... ]');
  }
  return parsed as EntityDescription[];
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

function isBackendName(v: string | undefined): v is 'local' | 'cloud' | 'file' {
  return v === 'local' || v === 'cloud' || v === 'file';
}

// ---------------------------------------------------------------------------
// Exit-code mapping
// ---------------------------------------------------------------------------

function exitForError(err: unknown): number {
  if (err instanceof UsageError) return 1;
  if (err instanceof ConfigError) return 2;
  if (err instanceof NoCanonicalError) return 2;
  if (err instanceof BackendUnreachableError) return 3;
  // A rejected variant has no "silhouette" artifact to fall back to, but is
  // the same *kind* of outcome as ensurePortrait's exhausted-rounds gate
  // failure -- both mean "the gate never accepted anything" -- so it shares
  // exit 4 rather than inventing a seventh code. Judgment call; flagged in
  // the final report.
  if (err instanceof VariantRejectedError) return 4;
  if (err instanceof LensFailureError) return 5;
  // Anything else (a thrown error from a not-yet-real dependency, an fs
  // error from the registry, etc.) is treated as a setup/config problem.
  return 2;
}

function report(result: EnsureResult, label: string): void {
  if (result.status === 'silhouette') {
    process.stdout.write(`${label}: gate failed after all rounds -- wrote silhouette (${result.imagePath})\n`);
  } else {
    process.stdout.write(`${label}: ${result.status} -> ${result.imagePath}\n`);
  }
}

// ---------------------------------------------------------------------------
// Composition root — NEEDS: replaced at merge by real imports (see
// src/contracts.ts's NEEDS: comments for each module's assumed shape).
// Dynamic `import()` is called through a variable (not a string literal) so
// TypeScript cannot statically resolve the specifier and treats the result
// as `any` — this lets the file typecheck today even though
// src/prompt/**, src/gate/**, src/registry/**, src/workflow/** and
// src/backends/** do not exist in this worktree. At runtime this code path
// only executes when the CLI actually runs without injected overrides
// (never in this package's own tests).
// ---------------------------------------------------------------------------

export interface ComposedDeps {
  /** Build the injected EnsureDeps bundle for a given workflow json file
   *  (the canonical portrait workflow, or the variant edit workflow), plus
   *  the lens list every command needs alongside it. */
  buildEnsureDeps(workflowPath: string): Promise<{ deps: EnsureDeps; lenses: Lens[] }>;
  makeBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<Backend>;
  checkBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<{ ok: boolean; detail?: string }>;
  checkLenses(lenses: Lens[]): Promise<Array<{ name: string; ok: boolean; detail?: string }>>;
  workflowDir: string;
  registryRootDefault: string;
}

function packageRoot(): string {
  // dist/cli.js (compiled) or src/cli.ts (ts-node/vitest) both sit one
  // level under the package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export async function composeRealDeps(): Promise<ComposedDeps> {
  // Stitched at merge (2026-09-02): Builder A's backends + pin, Builder B's
  // prompter/gate/registry, adapted here to the shapes src/contracts.ts
  // declared before those modules existed. Every adapter is a pure
  // reshaping -- no behavior lives in this file.
  const root = packageRoot();
  const workflowDir = join(root, 'workflows');
  const registryRootDefault = join(root, 'registry');
  const referencesDir = join(root, 'references', 'sfhd');
  const candidatesDirDefault = join(tmpdir(), 'portrait-forge', 'candidates');
  // Where the local ComfyUI keeps its LoRAs -- only used to hash the style
  // LoRA into the manifest (design §5 `loras[].sha256`). Override with
  // COMFY_LOCAL_MODELS or PORTRAIT_FORGE_LORA_PATH; 'unknown' when absent.
  const localLorasDir = process.env.COMFY_LOCAL_MODELS
    ? join(process.env.COMFY_LOCAL_MODELS, 'loras')
    : 'E:/AI-Models/ComfyUI_windows_portable/ComfyUI/models/loras';

  async function listPlates(): Promise<string[]> {
    try {
      const files = await readdir(referencesDir);
      return files.filter((f) => f.toLowerCase().endsWith('.png')).map((f) => join(referencesDir, f));
    } catch {
      return [];
    }
  }

  async function loraSha256(loraName: string): Promise<string> {
    const paths = [process.env.PORTRAIT_FORGE_LORA_PATH, join(localLorasDir, loraName)].filter((x): x is string => Boolean(x));
    for (const candidate of paths) {
      try {
        return createHash('sha256').update(await readFile(candidate)).digest('hex');
      } catch {
        /* try the next location */
      }
    }
    return 'unknown';
  }

  function nodeClassesOf(template: string): string[] {
    const graph = JSON.parse(template) as Record<string, { class_type?: string }>;
    return [...new Set(Object.values(graph).map((n) => n.class_type).filter((c): c is string => typeof c === 'string'))];
  }

  async function buildEnsureDeps(workflowPath: string): Promise<{ deps: EnsureDeps; lenses: Lens[] }> {
    const template = await loadWorkflow(workflowPath);
    const sha256 = workflowSha256(template);
    const constants = pinnedConstants();
    const isVariant = /variant/i.test(workflowPath);
    const loraSha = await loraSha256(constants.portrait.lora);
    const siglip = createSiglipLens();
    const ollama = createOllamaLens();
    const realLenses: RealLens[] = [siglip, ollama];
    const lenses = realLenses as unknown as Lens[];
    const referencePlates = await listPlates();
    const size: [number, number] = [constants.portrait.width, constants.portrait.height];
    const pinned: PinnedConstants = isVariant
      ? {
          models: [constants.variant.editModel],
          loras: [],
          sampler: constants.variant.sampler,
          scheduler: constants.variant.scheduler,
          steps: constants.variant.steps,
          cfg: constants.variant.cfg,
          size,
        }
      : {
          models: [constants.portrait.baseModel],
          loras: [{ name: constants.portrait.lora, sha256: loraSha, strength: constants.portrait.styleStrength }],
          sampler: constants.portrait.sampler,
          scheduler: constants.portrait.scheduler,
          steps: constants.portrait.steps,
          cfg: constants.portrait.cfg,
          size,
        };

    const deps: EnsureDeps = {
      buildPrompt: (desc) => {
        const built = buildPrompt(desc as RealEntityDescription);
        return { positive: built.positive, negative: built.negative, slots: built.slots as unknown as Record<string, string> };
      },
      descriptionHash: (desc) => descriptionHash(desc as RealEntityDescription),
      // deriveSeed yields the first 8 bytes of a SHA-256 as a bigint; JSON
      // manifests and JS numbers hold 53 exact bits, so the low 53 bits are
      // used -- still a pure function of (packId, entityId, descriptionHash)
      // (design §2), and well inside ComfyUI's seed range.
      deriveSeed: (packId, entityId, hash) => Number(deriveSeed(packId, entityId, hash) & ((1n << 53n) - 1n)),
      buildQuestions: (desc) => buildQuestions(desc as RealEntityDescription) as unknown as Question[],
      // BUILD_SPEC.md never named a variant-question builder; the variant's
      // own questions are the canonical ones (the face must still be that
      // face) plus the sameness check ensure.ts runs alongside.
      buildVariantQuestions: (desc) => buildQuestions(desc as RealEntityDescription) as unknown as Question[],
      judge: async (candidates, questions, lensesIn) => {
        const byId = new Map(candidates.map((c) => [String(c.index), c] as const));
        const rq = questions as unknown as RealQuestion[];
        const rl = lensesIn as unknown as RealLens[];
        const verdicts = await judgeReal(
          candidates.map((c) => ({ id: String(c.index), imagePath: c.imagePath })),
          rq,
          rl,
        );
        // design §3, finding 28: ties go to the Ollama lens's pairwise call,
        // against the description the questions encode (every expected-yes
        // target phrase).
        const ollamaLens = rl.find((l) => l.family === 'ollama') ?? rl[0];
        const description = rq.filter((q) => q.expected === 'yes').map((q) => q.targetPhrase).join(', ');
        const ranked = await rankCandidates(verdicts, ollamaLens, description);
        return ranked.map((v) => ({
          candidate: byId.get(v.candidateId)!,
          passedCount: v.passedRequired,
          requiredPassed: v.allRequiredPassed,
          answers: v.questionResults.map((r) => ({
            question: (rq.find((q) => q.id === r.questionId) ?? rq[0]) as unknown as Question,
            lensAnswers: Object.entries(r.answers).map(([lens, answer]) => ({ lens, answer })),
          })),
        }));
      },
      styleGate: async (imagePath, plates) => {
        const r = await styleGateReal(imagePath, plates, siglip);
        return { pass: r.passed, score: r.bestScore };
      },
      referencePlates,
      reslot: defaultReslot,
      editPrompt: defaultEditPrompt,
      pin: {
        sha256,
        pinnedConstants: () => pinned,
        // ensure.ts passes every slot as a string; KSampler.seed is an INT
        // input, so an all-digit seed goes back to a bare number here.
        fillSlots: (slots) =>
          fillSlots(
            template,
            Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, k === 'seed' && /^\d+$/.test(v) ? Number(v) : v])),
          ),
      },
      registryOps: {
        paths: (rootDir, packId, entityId) => {
          const rp = registryPaths(rootDir, packId, entityId);
          return { canonical: rp.canonicalPath, variantsDir: rp.variantsDir, manifest: rp.manifestPath, silhouette: rp.canonicalPath };
        },
        readManifest: async (rootDir, packId, entityId) =>
          (await readManifest(registryPaths(rootDir, packId, entityId))) as unknown as Manifest | null,
        writeCanonical: async (rootDir, packId, entityId, sourcePath) => {
          const rp = registryPaths(rootDir, packId, entityId);
          await writeCanonical(rp, await readFile(sourcePath));
          return rp.canonicalPath;
        },
        writeVariant: async (rootDir, packId, entityId, kind, sourcePath) => {
          const rp = registryPaths(rootDir, packId, entityId);
          await writeVariant(rp, kind, await readFile(sourcePath));
          return rp.variantPath(kind);
        },
        writeManifest: async (rootDir, packId, entityId, manifest) => {
          const rp = registryPaths(rootDir, packId, entityId);
          await writeManifest(rp, manifest as unknown as RegistryManifest);
          return rp.manifestPath;
        },
        writeSilhouette: async (rootDir, packId, entityId) => {
          const rp = registryPaths(rootDir, packId, entityId);
          await writeSilhouette(rp);
          return rp.canonicalPath;
        },
      },
    };
    return { deps, lenses };
  }

  /**
   * Builder A's Backend takes `{ outDir, timeoutMs, workflowSha256 }` and
   * reads seed/prefix from the filled graph; ensure.ts's contract passes
   * `{ seed, prefix }`. The adapter closes over the output directory and
   * the portrait workflow's SHA-256, and uploads any LoadImage input that
   * is still an absolute local path (the variant's canonical) before the
   * run -- local/cloud need the server-side filename, the file backend
   * stages a copy for the operator.
   */
  function adaptBackend(real: RealBackend, outDirDefault: string, sha: string): Backend {
    return {
      name: real.name,
      async run(graph, opts) {
        const g = graph as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
        for (const node of Object.values(g)) {
          const image = node?.inputs?.image;
          if (node?.class_type === 'LoadImage' && typeof image === 'string' && isAbsolute(image)) {
            const up = await real.uploadImage(image);
            node.inputs!.image = up.subfolder ? `${up.subfolder}/${up.filename}` : up.filename;
          }
        }
        const r = await real.run(g, { outDir: opts.outDir ?? outDirDefault, timeoutMs: opts.waitMs, workflowSha256: sha });
        return { images: r.images, promptId: r.promptId, durationMs: r.durationMs };
      },
    };
  }

  async function portraitTemplate(): Promise<string> {
    return loadWorkflow(join(workflowDir, 'qwen-sfhd.portrait.json'));
  }

  async function makeReal(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<{ real: RealBackend; outDir: string }> {
    if (name === 'local') return { real: new LocalComfyBackend(), outDir: fileOpts?.outDir ?? candidatesDirDefault };
    if (name === 'cloud') return { real: new CloudComfyBackend(), outDir: fileOpts?.outDir ?? candidatesDirDefault };
    const outDir = fileOpts?.outDir ?? join(registryRootDefault, '_smoke');
    return { real: new FileDropBackend({ defaultTimeoutMs: fileOpts?.waitMs, uploadsDir: join(outDir, 'uploads') }), outDir };
  }

  async function makeBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<Backend> {
    const { real, outDir } = await makeReal(name, fileOpts);
    await mkdir(outDir, { recursive: true }).catch(() => {});
    return adaptBackend(real, outDir, workflowSha256(await portraitTemplate()));
  }

  async function checkBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<{ ok: boolean; detail?: string }> {
    try {
      const { real } = await makeReal(name, fileOpts);
      const portrait = nodeClassesOf(await portraitTemplate());
      const variant = nodeClassesOf(await loadWorkflow(join(workflowDir, 'qwen-edit.variant.json')));
      await real.checkReady([...new Set([...portrait, ...variant])]);
      return { ok: true, detail: `${real.name} backend ready (${portrait.length} portrait + ${variant.length} variant node classes)` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async function checkLenses(lenses: Lens[]): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    // The lens contract has no probe verb; a real probe would load SigLIP2
    // and a vision model, which `check` must not do on a busy GPU.
    return lenses.map((lens) => ({ name: lens.name, ok: true, detail: 'constructed (not probed -- run `ensure` to exercise)' }));
  }

  return { buildEnsureDeps, makeBackend, checkBackend, checkLenses, workflowDir, registryRootDefault };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdEnsure(args: string[], composed: ComposedDeps): Promise<number> {
  const desc = await readEntity(flag(args, '--entity'));
  const backendName = flag(args, '--backend');
  if (!isBackendName(backendName)) throw new UsageError('ensure needs --backend local|cloud|file', usage());
  const registryRoot = flag(args, '--registry') ?? composed.registryRootDefault;
  const n = flag(args, '--n');
  const outDir = flag(args, '--out');
  const waitMsRaw = flag(args, '--wait-ms');
  const waitMs = waitMsRaw ? Number(waitMsRaw) : undefined;

  const backend = await composed.makeBackend(backendName, { outDir, waitMs });
  const { deps, lenses } = await composed.buildEnsureDeps(join(composed.workflowDir, 'qwen-sfhd.portrait.json'));

  const result = await ensurePortrait(desc, {
    backend, registryRoot, lenses, workflowDir: composed.workflowDir,
    N: n ? Number(n) : undefined, deps,
  });
  report(result, desc.id);
  return result.status === 'silhouette' ? 4 : 0;
}

async function cmdVariant(args: string[], composed: ComposedDeps): Promise<number> {
  const desc = await readEntity(flag(args, '--entity'));
  const kind = flag(args, '--kind');
  if (!kind) throw new UsageError('variant needs --kind <kind>', usage());
  const backendName = flag(args, '--backend') ?? 'local';
  if (!isBackendName(backendName)) throw new UsageError('variant needs --backend local|cloud|file', usage());
  const registryRoot = flag(args, '--registry') ?? composed.registryRootDefault;
  const outDir = flag(args, '--out');
  const waitMsRaw = flag(args, '--wait-ms');
  const waitMs = waitMsRaw ? Number(waitMsRaw) : undefined;

  const backend = await composed.makeBackend(backendName, { outDir, waitMs });
  const { deps, lenses } = await composed.buildEnsureDeps(join(composed.workflowDir, 'qwen-edit.variant.json'));

  const result = await ensureVariant(desc, kind, {
    backend, registryRoot, lenses, workflowDir: composed.workflowDir, deps,
  });
  report(result, `${desc.id}/${kind}`);
  return result.status === 'silhouette' ? 4 : 0;
}

async function cmdCheck(args: string[], composed: ComposedDeps): Promise<number> {
  const backendName = flag(args, '--backend');
  if (!isBackendName(backendName)) throw new UsageError('check needs --backend local|cloud|file', usage());
  const outDir = flag(args, '--out');
  const backendResult = await composed.checkBackend(backendName, { outDir });
  process.stdout.write(`backend ${backendName}: ${backendResult.ok ? 'ok' : 'FAILED'}${backendResult.detail ? ` -- ${backendResult.detail}` : ''}\n`);
  if (!backendResult.ok) return 3;

  const lensResults = await composed.checkLenses([]);
  for (const l of lensResults) {
    process.stdout.write(`lens ${l.name}: ${l.ok ? 'ok' : 'FAILED'}${l.detail ? ` -- ${l.detail}` : ''}\n`);
  }
  if (lensResults.some((l) => !l.ok)) return 5;
  return 0;
}

async function cmdCast(args: string[], composed: ComposedDeps): Promise<number> {
  const entities = await readEntities(flag(args, '--file'));
  const backendName = flag(args, '--backend') ?? 'local';
  if (!isBackendName(backendName)) throw new UsageError('cast needs --backend local|cloud|file', usage());
  const registryRoot = flag(args, '--registry') ?? composed.registryRootDefault;

  const backend = await composed.makeBackend(backendName, {});
  const { deps, lenses } = await composed.buildEnsureDeps(join(composed.workflowDir, 'qwen-sfhd.portrait.json'));

  let sawSilhouette = false;
  for (const desc of entities) {
    const result = await ensurePortrait(desc, { backend, registryRoot, lenses, workflowDir: composed.workflowDir, deps });
    report(result, desc.id);
    if (result.status === 'silhouette') sawSilhouette = true;
  }
  return sawSilhouette ? 4 : 0;
}

async function cmdAccept(args: string[], composed: ComposedDeps): Promise<number> {
  const desc = await readEntity(flag(args, '--entity'));
  const candidateDir = flag(args, '--candidates');
  if (!candidateDir) throw new UsageError('accept needs --candidates <dir>', usage());
  const registryRoot = flag(args, '--registry') ?? composed.registryRootDefault;

  const { deps, lenses } = await composed.buildEnsureDeps(join(composed.workflowDir, 'qwen-sfhd.portrait.json'));

  const result = await acceptCandidates(desc, candidateDir, { registryRoot, lenses, deps });
  report(result, desc.id);
  return result.status === 'silhouette' ? 4 : 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[], overrides?: ComposedDeps): Promise<number> {
  const verb = argv[0];
  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(usage() + '\n');
    return verb ? 0 : 1;
  }

  let composed: ComposedDeps;
  try {
    composed = overrides ?? await composeRealDeps();
  } catch (err) {
    process.stderr.write(`error: could not initialize -- ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write('hint: this is expected before the other builders\' modules (src/prompt/**, src/gate/**, src/registry/**, src/workflow/**, src/backends/**) are merged\n');
    return 2;
  }

  try {
    switch (verb) {
      case 'ensure': return await cmdEnsure(argv.slice(1), composed);
      case 'variant': return await cmdVariant(argv.slice(1), composed);
      case 'check': return await cmdCheck(argv.slice(1), composed);
      case 'cast': return await cmdCast(argv.slice(1), composed);
      case 'accept': return await cmdAccept(argv.slice(1), composed);
      default: {
        process.stderr.write(`error: unknown command '${verb}'\n${usage()}\n`);
        return 1;
      }
    }
  } catch (err) {
    const code = exitForError(err);
    const hint = (err as { hint?: string }).hint;
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (hint) process.stderr.write(`hint: ${hint}\n`);
    return code;
  }
}

// Auto-run only when this file is the process entry point (compiled
// dist/cli.js run directly, or `node src/cli.ts` via a loader) -- not when
// a test imports { main } from this module.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
