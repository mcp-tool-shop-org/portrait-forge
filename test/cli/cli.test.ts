// cli.test.ts — CLI exit codes and error reporting, driven via `main(argv,
// overrides)` with an injected fake `ComposedDeps` rather than spawning
// `node dist/cli.js`. Spawning would require `npm run build` to succeed
// first, which depends on Builder A/B's modules existing (see cli.ts's
// `composeRealDeps` — "green expected at merge"); calling `main` directly
// keeps these tests green today and exercises the exact same command
// handlers the compiled binary will run.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { main, type ComposedDeps } from '../../src/cli.js';
import type { EntityDescription, Backend, Lens } from '../../src/contracts.js';
import {
  fakeDescriptionHash, fakeDeriveSeed, fakeBuildPrompt, fakeBuildQuestions, fakeBuildVariantQuestions,
  makeFakeLens, fakeJudge, fakeStyleGate, makeFakePin, makeFakeBackend, makeThrowingBackend, makeFakeRegistry,
} from '../ensure/fakes.js';
import { defaultReslot, defaultEditPrompt, type EnsureDeps } from '../../src/ensure.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fx = (name: string) => join(fixturesDir, name);

function baseDesc(overrides: Partial<EntityDescription> = {}): EntityDescription {
  return {
    id: 'brother-aldric', name: 'Brother Aldric', kind: 'npc',
    species: 'human', bodyClass: 'stocky', age: 'elderly', face: 'weathered kind face',
    hair: 'grey tonsure', garb: 'brown wool cassock', mood: 'serene', palette: 'muted brown and cream',
    tags: [], packId: 'starter-fantasy', ...overrides,
  };
}

let stdout: string[];
let stderr: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.spyOn's overload resolution
// on process.stdout/stderr.write's multi-signature type is not worth fighting for a test double.
let stdoutSpy: any;
let stderrSpy: any;

beforeEach(() => {
  stdout = [];
  stderr = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { stdout.push(String(chunk)); return true; });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { stderr.push(String(chunk)); return true; });
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

interface FakeCase {
  registry: ReturnType<typeof makeFakeRegistry>;
  lensScriptFailSpecies?: boolean;
  styleGateRejectAll?: boolean;
  backendThrows?: string;
  lensThrows?: boolean;
}

function makeComposed(fx_: FakeCase): ComposedDeps {
  const lenses: Lens[] = fx_.lensThrows
    ? [makeFakeLens('siglip', 'siglip'), { name: 'ollama', family: 'ollama', ask: async () => { throw new Error('ollama down'); }, same: async () => { throw new Error('ollama down'); } }]
    : [makeFakeLens('siglip', 'siglip'), makeFakeLens('ollama', 'ollama')];

  const deps: EnsureDeps = {
    buildPrompt: fakeBuildPrompt,
    descriptionHash: fakeDescriptionHash,
    deriveSeed: fakeDeriveSeed,
    buildQuestions: fakeBuildQuestions,
    buildVariantQuestions: fakeBuildVariantQuestions,
    judge: fakeJudge,
    styleGate: async (imagePath, plates) => fx_.styleGateRejectAll
      ? { pass: false, score: 0.1 }
      : fakeStyleGate(imagePath, plates),
    pin: makeFakePin(),
    registryOps: fx_.registry.ops,
    referencePlates: [fx('canonical.png')],
    reslot: defaultReslot,
    editPrompt: defaultEditPrompt,
  };

  return {
    workflowDir: '/wf',
    registryRootDefault: '/reg',
    async buildEnsureDeps() { return { deps, lenses }; },
    async makeBackend(name) {
      if (fx_.backendThrows) return makeThrowingBackend(name, fx_.backendThrows);
      return makeFakeBackend(name, () => fx('candidate-a.png'));
    },
    async checkBackend(name) {
      if (fx_.backendThrows) return { ok: false, detail: fx_.backendThrows };
      return { ok: true, detail: `${name} ok` };
    },
    async checkLenses() {
      if (fx_.lensThrows) return [{ name: 'ollama', ok: false, detail: 'unreachable' }];
      return [{ name: 'siglip', ok: true }, { name: 'ollama', ok: true }];
    },
  };
}

describe('cli: usage', () => {
  it('prints usage and exits 1 with no arguments', async () => {
    const code = await main([], makeComposed({ registry: makeFakeRegistry() }));
    expect(code).toBe(1);
    expect(stdout.join('')).toContain('portrait-forge --');
  });

  it('prints usage and exits 0 for --help', async () => {
    const code = await main(['--help'], makeComposed({ registry: makeFakeRegistry() }));
    expect(code).toBe(0);
  });

  it('exits 1 for an unknown command', async () => {
    const code = await main(['frobnicate'], makeComposed({ registry: makeFakeRegistry() }));
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('unknown command');
  });
});

describe('cli: ensure', () => {
  it('exits 0 and reports accepted on a clean gate pass', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['ensure', '--entity', JSON.stringify(desc), '--backend', 'local'], composed);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('accepted');
  });

  it('reads --entity from a file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portrait-forge-cli-'));
    const path = join(dir, 'entity.json');
    await writeFile(path, JSON.stringify(baseDesc()));
    try {
      const composed = makeComposed({ registry: makeFakeRegistry() });
      const code = await main(['ensure', '--entity', path, '--backend', 'local'], composed);
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when --backend is missing', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['ensure', '--entity', JSON.stringify(desc)], composed);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('error:');
  });

  it('exits 1 for an invalid --backend value', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['ensure', '--entity', JSON.stringify(desc), '--backend', 'nonsense'], composed);
    expect(code).toBe(1);
  });

  it('exits 2 for malformed --entity JSON', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['ensure', '--entity', '{not json', '--backend', 'local'], composed);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/error:.*hint:/s);
  });

  it('exits 4 and writes a silhouette when the gate never accepts', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry(), styleGateRejectAll: true });
    const code = await main(['ensure', '--entity', JSON.stringify(desc), '--backend', 'local'], composed);
    expect(code).toBe(4);
    expect(stdout.join('')).toContain('silhouette');
  });

  it('exits 3 when the backend is unreachable', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry(), backendThrows: 'ECONNREFUSED' });
    const code = await main(['ensure', '--entity', JSON.stringify(desc), '--backend', 'local'], composed);
    expect(code).toBe(3);
  });

  it('exits 5 when a lens is unreachable', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry(), lensThrows: true });
    const code = await main(['ensure', '--entity', JSON.stringify(desc), '--backend', 'local'], composed);
    expect(code).toBe(5);
  });
});

describe('cli: variant', () => {
  it('exits 1 when --kind is missing', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['variant', '--entity', JSON.stringify(desc)], composed);
    expect(code).toBe(1);
  });

  it('exits 2 when no canonical portrait has been accepted yet', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['variant', '--entity', JSON.stringify(desc), '--kind', 'wounded'], composed);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('no accepted canonical');
  });

  it('exits 0 when the canonical exists and the variant gate passes', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    await registry.ops.writeManifest('/reg', desc.packId, desc.id, {
      descriptionHash: fakeDescriptionHash(desc), prompt: fakeBuildPrompt(desc),
      seed: fakeDeriveSeed(desc.packId, desc.id, fakeDescriptionHash(desc)),
      workflowId: 'qwen-sfhd.portrait', workflowSha256: 'fixture-workflow-sha256',
      loras: [{ name: 'sfhd_style_v1', sha256: 'fixture-lora-sha256', strength: 0.8 }],
      backend: 'local', model: 'qwen_image_2512_bf16.safetensors',
      accepted: { questions: [], styleScore: 0.9 }, identity: {}, status: 'accepted',
    });
    const composed = makeComposed({ registry });
    const code = await main(['variant', '--entity', JSON.stringify(desc), '--kind', 'wounded'], composed);
    expect(code).toBe(0);
  });
});

describe('cli: check', () => {
  it('exits 0 when the backend and lenses are both reachable', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['check', '--backend', 'local'], composed);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('backend local: ok');
  });

  it('exits 3 when the backend check fails', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry(), backendThrows: 'no key' });
    const code = await main(['check', '--backend', 'cloud'], composed);
    expect(code).toBe(3);
  });

  it('exits 5 when a lens check fails', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry(), lensThrows: true });
    const code = await main(['check', '--backend', 'local'], composed);
    expect(code).toBe(5);
  });

  it('exits 1 for an invalid --backend value', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['check', '--backend', 'nope'], composed);
    expect(code).toBe(1);
  });
});

describe('cli: cast', () => {
  it('exits 0 when every entity in the batch is accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portrait-forge-cli-'));
    const path = join(dir, 'cast.json');
    await writeFile(path, JSON.stringify([baseDesc({ id: 'a' }), baseDesc({ id: 'b' })]));
    try {
      const composed = makeComposed({ registry: makeFakeRegistry() });
      const code = await main(['cast', '--file', path], composed);
      expect(code).toBe(0);
      expect(stdout.join('')).toContain('a:');
      expect(stdout.join('')).toContain('b:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 4 when any entity in the batch falls back to a silhouette', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portrait-forge-cli-'));
    const path = join(dir, 'cast.json');
    await writeFile(path, JSON.stringify([baseDesc({ id: 'a' })]));
    try {
      const composed = makeComposed({ registry: makeFakeRegistry(), styleGateRejectAll: true });
      const code = await main(['cast', '--file', path], composed);
      expect(code).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when --file is missing', async () => {
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['cast'], composed);
    expect(code).toBe(1);
  });

  it('exits 2 when --file is not a JSON array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portrait-forge-cli-'));
    const path = join(dir, 'cast.json');
    await writeFile(path, JSON.stringify(baseDesc()));
    try {
      const composed = makeComposed({ registry: makeFakeRegistry() });
      const code = await main(['cast', '--file', path], composed);
      expect(code).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cli: accept', () => {
  it('exits 0 and labels the manifest backend "file" for externally produced candidates', async () => {
    const desc = baseDesc();
    const registry = makeFakeRegistry();
    const composed = makeComposed({ registry });
    const code = await main(['accept', '--entity', JSON.stringify(desc), '--candidates', fixturesDir], composed);
    expect(code).toBe(0);
    const manifest = await registry.ops.readManifest('/reg', desc.packId, desc.id);
    expect(manifest?.backend).toBe('file');
  });

  it('exits 1 when --candidates is missing', async () => {
    const desc = baseDesc();
    const composed = makeComposed({ registry: makeFakeRegistry() });
    const code = await main(['accept', '--entity', JSON.stringify(desc)], composed);
    expect(code).toBe(1);
  });

  it('exits 2 when the candidates directory has no PNGs', async () => {
    const desc = baseDesc();
    const dir = await mkdtemp(join(tmpdir(), 'portrait-forge-empty-'));
    try {
      const composed = makeComposed({ registry: makeFakeRegistry() });
      const code = await main(['accept', '--entity', JSON.stringify(desc), '--candidates', dir], composed);
      expect(code).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
