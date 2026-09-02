// Builder A -- test/backends/local.test.ts
// A fake ComfyUI HTTP server stands in for the local rig: node-presence
// check, submit-then-poll-history, download, upload.

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalComfyBackend } from '../../src/backends/local.js';
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

describe('LocalComfyBackend.checkReady', () => {
  it('resolves when every required node class is present in /object_info', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    await expect(backend.checkReady(REQUIRED_CLASSES)).resolves.toBeUndefined();
  });

  it('throws E_COMFY_NODE_MISSING naming the missing class', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES.filter((c) => c !== 'KSampler') });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    await expect(backend.checkReady(REQUIRED_CLASSES)).rejects.toMatchObject({
      code: 'E_COMFY_NODE_MISSING',
      message: expect.stringContaining('KSampler'),
    });
  });

  it('throws E_COMFY_UNREACHABLE after retries are exhausted when the server is down', async () => {
    const backend = new LocalComfyBackend({ baseUrl: 'http://127.0.0.1:1', maxRetries: 1, retryBaseDelayMs: 1 });
    await expect(backend.checkReady(['KSampler'])).rejects.toMatchObject({ code: 'E_COMFY_UNREACHABLE' });
  });
});

describe('LocalComfyBackend.run', () => {
  it('submits the graph, polls /history until ready, and downloads the output image', async () => {
    server = await startFakeComfyServer({
      objectInfoClasses: REQUIRED_CLASSES,
      outputFilename: 'portrait_00001_.png',
      readyAfterMs: 30,
    });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-local-'));
    const pinned = await pinWorkflow(portraitPath, {
      seed: 4242,
      positive: 'sfhd style, a priest character concept',
      negative: 'blurry',
      prefix: 'portrait_test',
    });

    const result = await backend.run(pinned.graph, { outDir });

    expect(result.promptId).toBeTruthy();
    expect(result.images).toHaveLength(1);
    expect(result.images[0].filename).toBe('portrait_00001_.png');
    const written = await fs.readFile(result.images[0].path);
    expect(written.length).toBeGreaterThan(0);

    expect(server.postedGraphs).toHaveLength(1);
    expect((server.postedGraphs[0]['11'] as any).inputs.seed).toBe(4242);
  });

  it('rejects with E_GENERATION_FAILED when ComfyUI reports node_errors', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES });
    // Override /prompt to return node_errors by hitting a second server that always errors.
    await server.close();
    const { createServer } = await import('node:http');
    const errServer = createServer((req, res) => {
      if (req.url === '/prompt') {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ prompt_id: 'x', node_errors: { '11': { errors: ['bad seed'] } } }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => errServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = errServer.address() as import('node:net').AddressInfo;
    const backend = new LocalComfyBackend({ baseUrl: `http://127.0.0.1:${addr.port}`, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-local-err-'));
    const pinned = await pinWorkflow(portraitPath, { seed: 1, positive: 'x', negative: 'y', prefix: 'p' });
    await expect(backend.run(pinned.graph, { outDir })).rejects.toMatchObject({ code: 'E_GENERATION_FAILED' });
    await new Promise<void>((resolve) => errServer.close(() => resolve()));
  });

  it('times out with E_GENERATION_TIMEOUT when history never reports outputs', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES, readyAfterMs: 10_000 });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-local-timeout-'));
    const pinned = await pinWorkflow(portraitPath, { seed: 1, positive: 'x', negative: 'y', prefix: 'p' });
    await expect(backend.run(pinned.graph, { outDir, timeoutMs: 60 })).rejects.toMatchObject({ code: 'E_GENERATION_TIMEOUT' });
  });
});

describe('LocalComfyBackend.uploadImage', () => {
  it('uploads a local file via POST /upload/image', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-local-up-'));
    const srcPath = path.join(outDir, 'canonical.png');
    await fs.writeFile(srcPath, Buffer.from([1, 2, 3, 4]));

    const result = await backend.uploadImage(srcPath);

    expect(result).toEqual({ filename: 'uploaded.png', subfolder: '', type: 'input' });
    expect(server.uploadedFiles).toHaveLength(1);
    expect(server.uploadedFiles[0].bytes.length).toBeGreaterThan(0);
  });

  it('throws E_UPLOAD_FAILED when the local file does not exist', async () => {
    server = await startFakeComfyServer({ objectInfoClasses: REQUIRED_CLASSES });
    const backend = new LocalComfyBackend({ baseUrl: server.url, pollIntervalMs: 10 });
    await expect(backend.uploadImage('/does/not/exist.png')).rejects.toMatchObject({ code: 'E_UPLOAD_FAILED' });
  });
});
