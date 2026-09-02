// Builder A -- test/backends/cloud.test.ts
// The same fake server, in its Comfy Cloud v1 shape (/api prefix, X-API-Key
// auth, /api/job/{id}/status instead of /history/{id}). Covers the key
// missing/rejected cases and the same run/upload contract as local.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CloudComfyBackend } from '../../src/backends/cloud.js';
import { pinWorkflow } from '../../src/workflow/pin.js';
import { startFakeComfyServer, type FakeComfyServer } from './fakeComfyServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const portraitPath = path.join(here, '..', '..', 'workflows', 'qwen-sfhd.portrait.json');

const REQUIRED_CLASSES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'LoraLoaderModelOnly',
  'CLIPTextEncode',
  'ModelSamplingAuraFlow',
  'KSampler',
  'EmptySD3LatentImage',
  'VAEDecode',
  'SaveImage',
];

const API_KEY = 'test-secret-key';

let server: FakeComfyServer | undefined;
let outDir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (outDir) {
    await fs.rm(outDir, { recursive: true, force: true });
    outDir = undefined;
  }
});

describe('CloudComfyBackend key handling', () => {
  it('throws E_CLOUD_KEY_MISSING when no API key is configured', async () => {
    const prevEnv = process.env.COMFY_CLOUD_API_KEY;
    delete process.env.COMFY_CLOUD_API_KEY;
    try {
      const backend = new CloudComfyBackend({ baseUrl: 'http://127.0.0.1:1' });
      await expect(backend.checkReady(['KSampler'])).rejects.toMatchObject({ code: 'E_CLOUD_KEY_MISSING' });
    } finally {
      if (prevEnv !== undefined) process.env.COMFY_CLOUD_API_KEY = prevEnv;
    }
  });

  it('throws E_CLOUD_KEY_MISSING (401) when the server rejects the key', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES, apiPrefix: '/api', requireApiKey: API_KEY });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: 'wrong-key', pollIntervalMs: 10 });
    await expect(backend.checkReady(REQUIRED_CLASSES)).rejects.toMatchObject({ code: 'E_CLOUD_KEY_MISSING' });
  });
});

describe('CloudComfyBackend.checkReady', () => {
  it('resolves when every required node class is present', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES, apiPrefix: '/api', requireApiKey: API_KEY });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: API_KEY, pollIntervalMs: 10 });
    await expect(backend.checkReady(REQUIRED_CLASSES)).resolves.toBeUndefined();
  });

  it('throws E_COMFY_NODE_MISSING naming the missing class', async () => {
    server = await startFakeComfyServer({
      objectInfoClasses: REQUIRED_CLASSES.filter((c) => c !== 'VAEDecode'),
      apiPrefix: '/api',
      requireApiKey: API_KEY,
    });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: API_KEY, pollIntervalMs: 10 });
    await expect(backend.checkReady(REQUIRED_CLASSES)).rejects.toMatchObject({
      code: 'E_COMFY_NODE_MISSING',
      message: expect.stringContaining('VAEDecode'),
    });
  });
});

describe('CloudComfyBackend.run', () => {
  it('submits the graph, polls job status, and downloads the output image', async () => {
    server = await startFakeComfyServer({
      objectInfoClasses: REQUIRED_CLASSES,
      apiPrefix: '/api',
      requireApiKey: API_KEY,
      outputFilename: 'portrait_00001_.png',
      readyAfterMs: 30,
    });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: API_KEY, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cloud-'));
    const pinned = await pinWorkflow(portraitPath, {
      seed: 4242,
      positive: 'sfhd style, a priest character concept',
      negative: 'blurry',
      prefix: 'portrait_test',
    });

    const result = await backend.run(pinned.graph, { outDir });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].filename).toBe('portrait_00001_.png');
    const written = await fs.readFile(result.images[0].path);
    expect(written.length).toBeGreaterThan(0);
    expect(server.postedGraphs).toHaveLength(1);
  });

  it('times out with E_GENERATION_TIMEOUT when status never reaches success', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES, apiPrefix: '/api', requireApiKey: API_KEY, readyAfterMs: 10_000 });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: API_KEY, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cloud-timeout-'));
    const pinned = await pinWorkflow(portraitPath, { seed: 1, positive: 'x', negative: 'y', prefix: 'p' });
    await expect(backend.run(pinned.graph, { outDir, timeoutMs: 60 })).rejects.toMatchObject({ code: 'E_GENERATION_TIMEOUT' });
  });
});

describe('CloudComfyBackend.uploadImage', () => {
  it('uploads a local file via POST /api/upload/image', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES, apiPrefix: '/api', requireApiKey: API_KEY });
    const backend = new CloudComfyBackend({ baseUrl: server.url, apiKey: API_KEY, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cloud-up-'));
    const srcPath = path.join(outDir, 'canonical.png');
    await fs.writeFile(srcPath, Buffer.from([1, 2, 3, 4]));

    const result = await backend.uploadImage(srcPath);

    expect(result).toEqual({ filename: 'uploaded.png', subfolder: '', type: 'input' });
    expect(server.uploadedFiles).toHaveLength(1);
  });
});
