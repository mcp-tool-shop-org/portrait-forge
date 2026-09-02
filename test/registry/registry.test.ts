import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  needsRegeneration,
  readManifest,
  registryPaths,
  writeCanonical,
  writeManifest,
  writeSilhouette,
  writeVariant,
  type Manifest,
} from '../../src/registry/registry.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portrait-forge-registry-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    descriptionHash: 'abc123',
    prompt: 'sfhd style, a priest, an old man',
    seed: '12345678901234',
    workflowId: 'qwen-sfhd',
    workflowSha256: 'deadbeef',
    loras: [{ name: 'sfhd_style_v1', sha256: 'feedface', strength: 0.8 }],
    backend: 'local',
    model: 'qwen-image-2512',
    status: 'accepted',
    accepted: {
      questions: [{ q: 'This portrait shows a human.', expected: 'yes', answer: 'yes' }],
      styleScore: 0.7,
    },
    ...overrides,
  };
}

describe('registryPaths', () => {
  it('lays out <root>/<packId>/<entityId>/canonical.png, variants/<kind>.png, manifest.json', () => {
    const paths = registryPaths(root, 'starter-fantasy', 'aldric');
    expect(paths.entityDir).toBe(join(root, 'starter-fantasy', 'aldric'));
    expect(paths.canonicalPath).toBe(join(root, 'starter-fantasy', 'aldric', 'canonical.png'));
    expect(paths.manifestPath).toBe(join(root, 'starter-fantasy', 'aldric', 'manifest.json'));
    expect(paths.variantPath('wounded')).toBe(join(root, 'starter-fantasy', 'aldric', 'variants', 'wounded.png'));
  });
});

describe('manifest read/write', () => {
  it('returns null for a manifest that does not exist yet', async () => {
    const paths = registryPaths(root, 'pack', 'nobody');
    expect(await readManifest(paths)).toBeNull();
  });

  it('round-trips a written manifest', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    const manifest = makeManifest();
    await writeManifest(paths, manifest);
    const readBack = await readManifest(paths);
    expect(readBack).toEqual(manifest);
  });

  it('creates the entity directory if it does not exist', async () => {
    const paths = registryPaths(root, 'brand-new-pack', 'brand-new-entity');
    await writeManifest(paths, makeManifest());
    const raw = await readFile(paths.manifestPath, 'utf8');
    expect(JSON.parse(raw).descriptionHash).toBe('abc123');
  });
});

describe('needsRegeneration', () => {
  it('is true when there is no existing manifest', () => {
    expect(needsRegeneration(null, 'anyhash')).toBe(true);
  });

  it('is false when the descriptionHash matches', () => {
    const manifest = makeManifest({ descriptionHash: 'same-hash' });
    expect(needsRegeneration(manifest, 'same-hash')).toBe(false);
  });

  it('is true when the descriptionHash differs', () => {
    const manifest = makeManifest({ descriptionHash: 'old-hash' });
    expect(needsRegeneration(manifest, 'new-hash')).toBe(true);
  });
});

describe('idempotence', () => {
  it('ensure-style: writing the same manifest twice is a no-op in effect', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    const manifest = makeManifest();
    await writeManifest(paths, manifest);
    const first = await readManifest(paths);
    await writeManifest(paths, manifest);
    const second = await readManifest(paths);
    expect(first).toEqual(second);
    expect(needsRegeneration(second, manifest.descriptionHash)).toBe(false);
  });
});

describe('canonical and variant writes', () => {
  it('writes canonical.png bytes to the entity directory', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeCanonical(paths, bytes);
    const readBack = await readFile(paths.canonicalPath);
    expect(new Uint8Array(readBack)).toEqual(bytes);
  });

  it('writes variants/<kind>.png bytes under the variants directory', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    const bytes = new Uint8Array([9, 9, 9]);
    await writeVariant(paths, 'wounded', bytes);
    const readBack = await readFile(paths.variantPath('wounded'));
    expect(new Uint8Array(readBack)).toEqual(bytes);
  });
});

describe('writeSilhouette', () => {
  it('copies the bundled placeholder in as the canonical image after two failed rounds', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    const fakeSource = join(root, 'fake-silhouette.png');
    const { writeFile } = await import('node:fs/promises');
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic prefix, doesn't need to be a full valid PNG for this test
    await writeFile(fakeSource, fakeBytes);

    await writeSilhouette(paths, fakeSource);
    const readBack = await readFile(paths.canonicalPath);
    expect(new Uint8Array(readBack)).toEqual(new Uint8Array(fakeBytes));
  });

  it('uses the real bundled references/silhouette.png by default', async () => {
    const paths = registryPaths(root, 'pack', 'aldric');
    await writeSilhouette(paths); // no override -> resolves to references/silhouette.png
    const readBack = await readFile(paths.canonicalPath);
    // PNG signature
    expect(readBack.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
