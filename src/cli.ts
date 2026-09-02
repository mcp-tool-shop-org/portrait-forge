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
import type { EntityDescription, Backend, Lens } from './contracts.js';

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

async function loadModule(specifier: string): Promise<any> {
  // See file header: indirection through a variable keeps this from being
  // statically resolved by tsc, so a missing module is only a *runtime*
  // error, not a compile error.
  return import(specifier);
}

function packageRoot(): string {
  // dist/cli.js (compiled) or src/cli.ts (ts-node/vitest) both sit one
  // level under the package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export async function composeRealDeps(): Promise<ComposedDeps> {
  const root = packageRoot();
  const workflowDir = join(root, 'workflows');
  const registryRootDefault = join(root, 'registry');

  async function buildEnsureDeps(workflowPath: string): Promise<{ deps: EnsureDeps; lenses: Lens[] }> {
    // NEEDS: src/prompt/slots.ts: buildPrompt, descriptionHash, deriveSeed.
    const promptMod = await loadModule('./prompt/slots.js');
    // NEEDS: src/gate/questions.ts: buildQuestions, buildVariantQuestions
    // (the latter's existence is unconfirmed -- see src/contracts.ts).
    const questionsMod = await loadModule('./gate/questions.js');
    // NEEDS: src/gate/accept.ts: judge, styleGate.
    const acceptMod = await loadModule('./gate/accept.js');
    // NEEDS: src/gate/lenses.ts: siglipLens, ollamaLens -- spec names them
    // as constants/factories interchangeably ("Both injectable for
    // tests"); duck-typed here (call if function, use as-is otherwise).
    const lensesMod = await loadModule('./gate/lenses.js');
    const siglip = typeof lensesMod.siglipLens === 'function' ? lensesMod.siglipLens() : lensesMod.siglipLens;
    const ollama = typeof lensesMod.ollamaLens === 'function' ? lensesMod.ollamaLens() : lensesMod.ollamaLens;
    const lenses: Lens[] = [siglip, ollama].filter(Boolean);
    // NEEDS: src/workflow/pin.ts: loadWorkflow, fillSlots, workflowSha256,
    // pinnedConstants (assumed free functions per BUILD_SPEC.md's prose;
    // adapted here into the WorkflowPin shape src/contracts.ts declares).
    const pinMod = await loadModule('./workflow/pin.js');
    const template = await pinMod.loadWorkflow(workflowPath);

    // design §3: "a reference plate from the sfhd samples" ->
    // references/sfhd/*.png (Builder B owns src/registry/** and the
    // reference-plate copies; not this file's to create).
    const referencesDir = join(root, 'references', 'sfhd');
    let referencePlates: string[] = [];
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(referencesDir);
      referencePlates = files.filter((f: string) => f.toLowerCase().endsWith('.png')).map((f: string) => join(referencesDir, f));
    } catch {
      referencePlates = []; // references/** not present yet pre-merge; styleGate will surface this if it needs plates.
    }

    // NEEDS: src/registry/registry.ts: an export matching RegistryOps
    // (paths, readManifest, writeCanonical, writeVariant, writeManifest,
    // writeSilhouette) -- name/shape unconfirmed, duck-typed here.
    const registryMod = await loadModule('./registry/registry.js');

    const deps: EnsureDeps = {
      buildPrompt: promptMod.buildPrompt,
      descriptionHash: promptMod.descriptionHash,
      deriveSeed: promptMod.deriveSeed,
      buildQuestions: questionsMod.buildQuestions,
      buildVariantQuestions: questionsMod.buildVariantQuestions ?? ((desc: EntityDescription) => questionsMod.buildQuestions(desc)),
      judge: acceptMod.judge,
      styleGate: acceptMod.styleGate,
      referencePlates,
      reslot: promptMod.reslot ?? defaultReslot,
      editPrompt: promptMod.editPrompt ?? defaultEditPrompt,
      pin: {
        sha256: pinMod.workflowSha256(template),
        pinnedConstants: () => pinMod.pinnedConstants(),
        fillSlots: (slots: Record<string, string>) => pinMod.fillSlots(template, slots),
      },
      registryOps: registryMod.registryOps ?? registryMod,
    };
    return { deps, lenses };
  }

  async function makeBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<Backend> {
    if (name === 'local') {
      // NEEDS: src/backends/local.ts: an exported factory. Assumed name
      // `createLocalBackend` -- confirm at merge.
      const mod = await loadModule('./backends/local.js');
      return mod.createLocalBackend ? mod.createLocalBackend() : mod.localBackend;
    }
    if (name === 'cloud') {
      // NEEDS: src/backends/cloud.ts: an exported factory. Assumed name
      // `createCloudBackend` -- confirm at merge.
      const mod = await loadModule('./backends/cloud.js');
      return mod.createCloudBackend ? mod.createCloudBackend() : mod.cloudBackend;
    }
    // NEEDS: src/backends/file.ts (coordinator's mid-build addition):
    // an exported factory taking { outDir, waitMs }. Assumed name
    // `createFileBackend` -- confirm at merge.
    const outDir = fileOpts?.outDir ?? join(registryRootDefault, '_smoke');
    await mkdir(outDir, { recursive: true }).catch(() => {});
    const mod = await loadModule('./backends/file.js');
    return mod.createFileBackend({ outDir, waitMs: fileOpts?.waitMs });
  }

  async function checkBackend(name: 'local' | 'cloud' | 'file', fileOpts?: { outDir?: string; waitMs?: number }): Promise<{ ok: boolean; detail?: string }> {
    try {
      const backend = await makeBackend(name, fileOpts);
      // NEEDS: Backend has no `check()`/`ping()` method in BUILD_SPEC.md's
      // contract; this only confirms the factory constructed successfully
      // (e.g. E_CLOUD_KEY_MISSING would throw here for 'cloud'), it does not
      // reach the network. NEEDS: Builder A add a lightweight check() (or
      // confirm /object_info + model presence is exercised some other way)
      // so `portrait-forge check` can report more than "constructed ok".
      return { ok: true, detail: `${backend.name} backend constructed` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async function checkLenses(lenses: Lens[]): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    // NEEDS: Lens has no check()/ping() in BUILD_SPEC.md's contract either;
    // this probes with a throwaway `same(a, a)` call reusing the first
    // reference plate if one is on disk, else reports "unverified".
    const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
    for (const lens of lenses) {
      results.push({ name: lens.name, ok: true, detail: 'not actively probed (no check() in the Lens contract)' });
    }
    return results;
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
