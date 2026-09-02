// The portrait registry (design law §5; BUILD_SPEC.md Builder B,
// src/registry/registry.ts). Filesystem layout and manifest shape exactly
// as the design law lists; `ensure()`-style staleness decision (regenerate
// only when `descriptionHash` changes) and the silhouette fallback (design
// law §3, finding 36: "no wrong face ever ships") live here as primitives
// that the orchestrator (Builder C's src/ensure.ts) calls -- this module
// does not itself drive a backend or the gate.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LoraRef {
  name: string;
  sha256: string;
  strength: number;
}

export interface AcceptedQuestionRecord {
  q: string;
  expected: 'yes' | 'no';
  answer: 'yes' | 'no';
}

// design law §5: `manifest.json` = `{ descriptionHash, prompt, seed,
// workflowId, workflowSha256, loras: [{ name, sha256, strength }], backend,
// model, accepted: { questions: [{ q, expected, answer }], styleScore },
// identity: { variant: score } }`.
export interface Manifest {
  descriptionHash: string;
  prompt: string;
  /** Serialized decimal string -- `deriveSeed` returns a bigint and JSON
   * has no bigint literal. */
  seed: string;
  workflowId: string;
  workflowSha256: string;
  loras: LoraRef[];
  backend: string;
  model: string;
  /** Not in the design law's literal manifest shape, but required to tell
   * a silhouette fallback apart from a real accepted portrait when reading
   * the manifest back (finding 36). */
  status: 'accepted' | 'silhouette';
  accepted?: {
    questions: AcceptedQuestionRecord[];
    styleScore: number;
  };
  identity?: Record<string, number>;
}

export interface RegistryPaths {
  entityDir: string;
  canonicalPath: string;
  variantsDir: string;
  manifestPath: string;
  variantPath(kind: string): string;
}

/** design law §5: `<root>/<packId>/<entityId>/canonical.png`,
 * `variants/<kind>.png`, `manifest.json`. */
export function registryPaths(root: string, packId: string, entityId: string): RegistryPaths {
  const entityDir = join(root, packId, entityId);
  const variantsDir = join(entityDir, 'variants');
  return {
    entityDir,
    canonicalPath: join(entityDir, 'canonical.png'),
    variantsDir,
    manifestPath: join(entityDir, 'manifest.json'),
    variantPath: (kind: string) => join(variantsDir, `${kind}.png`),
  };
}

/** Returns `null` when no manifest exists yet (a brand-new entity). Any
 * other read/parse failure propagates. */
export async function readManifest(paths: RegistryPaths): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(paths.manifestPath, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeManifest(paths: RegistryPaths, manifest: Manifest): Promise<void> {
  await fs.mkdir(paths.entityDir, { recursive: true });
  await fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * design law §5 / BUILD_SPEC.md Builder B: "`ensure()` semantics:
 * regenerate only when `descriptionHash` differs from the manifest." A
 * missing manifest always needs generation (brand-new entity).
 */
export function needsRegeneration(existing: Manifest | null, descriptionHash: string): boolean {
  if (!existing) return true;
  return existing.descriptionHash !== descriptionHash;
}

export async function writeCanonical(paths: RegistryPaths, imageBytes: Uint8Array): Promise<void> {
  await fs.mkdir(paths.entityDir, { recursive: true });
  await fs.writeFile(paths.canonicalPath, imageBytes);
}

export async function writeVariant(paths: RegistryPaths, kind: string, imageBytes: Uint8Array): Promise<void> {
  await fs.mkdir(paths.variantsDir, { recursive: true });
  await fs.writeFile(paths.variantPath(kind), imageBytes);
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Two levels up from src/registry/ (or dist/registry/, tsc mirrors the
// layout) is the repo root, where the bundled placeholder lives.
const DEFAULT_SILHOUETTE_SOURCE = join(__dirname, '..', '..', 'references', 'silhouette.png');

/**
 * design law §3, finding 36 / BUILD_SPEC.md Builder B: "silhouette after
 * two failed rounds with a bundled `references/silhouette.png`." Writes the
 * bundled placeholder as the entity's canonical image and marks the
 * manifest `status: 'silhouette'` so a later read can tell a placeholder
 * apart from an accepted portrait (never re-accepted as if it passed the
 * gate). `sourcePath` is injectable for tests.
 */
export async function writeSilhouette(
  paths: RegistryPaths,
  sourcePath: string = DEFAULT_SILHOUETTE_SOURCE,
): Promise<void> {
  await fs.mkdir(paths.entityDir, { recursive: true });
  const bytes = await fs.readFile(sourcePath);
  await fs.writeFile(paths.canonicalPath, bytes);
}
