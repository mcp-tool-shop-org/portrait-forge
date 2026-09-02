// Builder A -- test/backends/file.test.ts
// FileDropBackend: writes <prefix>.graph.json + <prefix>.request.json, then
// waits for an operator (simulated here) to drop the output image.

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileDropBackend } from '../../src/backends/file.js';
import { pinWorkflow } from '../../src/workflow/pin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const portraitPath = path.join(here, '..', '..', 'workflows', 'qwen-sfhd.portrait.json');

let outDir: string | undefined;

afterEach(async () => {
  if (outDir) {
    await fs.rm(outDir, { recursive: true, force: true });
    outDir = undefined;
  }
});

describe('FileDropBackend.run', () => {
  it('writes the graph and a request sidecar, then resolves once the exact-named image appears', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-file-'));
    const backend = new FileDropBackend({ pollIntervalMs: 20 });
    const pinned = await pinWorkflow(portraitPath, {
      seed: 4242,
      positive: 'sfhd style, a priest character concept',
      negative: 'blurry',
      prefix: 'drop_test',
    });

    const runPromise = backend.run(pinned.graph, { outDir, timeoutMs: 3000, workflowSha256: pinned.sha256 });

    // Simulate the operator/plugin: read what was written, then drop the output.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const graphOnDisk = JSON.parse(await fs.readFile(path.join(outDir, 'drop_test.graph.json'), 'utf8'));
    expect(graphOnDisk['11'].inputs.seed).toBe(4242);
    const requestOnDisk = JSON.parse(await fs.readFile(path.join(outDir, 'drop_test.request.json'), 'utf8'));
    expect(requestOnDisk.prefix).toBe('drop_test');
    expect(requestOnDisk.seed).toBe('4242');
    expect(requestOnDisk.workflowSha256).toBe(pinned.sha256);

    await fs.writeFile(path.join(outDir, 'drop_test.png'), Buffer.from([1, 2, 3]));

    const result = await runPromise;
    expect(result.images).toHaveLength(1);
    expect(result.images[0].filename).toBe('drop_test.png');
    expect(result.promptId).toBe('file:drop_test');
  });

  it('accepts a ComfyUI-suffixed filename (<prefix>_00001_.png)', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-file-suffix-'));
    const backend = new FileDropBackend({ pollIntervalMs: 20 });
    const pinned = await pinWorkflow(portraitPath, { seed: 1, positive: 'a', negative: 'b', prefix: 'suffix_test' });

    const runPromise = backend.run(pinned.graph, { outDir, timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.writeFile(path.join(outDir, 'suffix_test_00001_.png'), Buffer.from([9]));

    const result = await runPromise;
    expect(result.images[0].filename).toBe('suffix_test_00001_.png');
  });

  it('times out with E_GENERATION_TIMEOUT and a hint naming the graph file', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-file-timeout-'));
    const backend = new FileDropBackend({ pollIntervalMs: 10 });
    const pinned = await pinWorkflow(portraitPath, { seed: 1, positive: 'a', negative: 'b', prefix: 'timeout_test' });

    await expect(backend.run(pinned.graph, { outDir, timeoutMs: 60 })).rejects.toMatchObject({
      code: 'E_GENERATION_TIMEOUT',
      hint: expect.stringContaining('timeout_test.graph.json'),
    });
  });
});

describe('FileDropBackend.uploadImage', () => {
  it('copies the file into the uploads directory', async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-file-upload-'));
    const uploadsDir = path.join(outDir, 'uploads');
    const backend = new FileDropBackend({ uploadsDir });
    const srcPath = path.join(outDir, 'canonical.png');
    await fs.writeFile(srcPath, Buffer.from([1, 2, 3]));

    const result = await backend.uploadImage(srcPath);

    expect(result).toEqual({ filename: 'canonical.png', subfolder: '', type: 'input' });
    const copied = await fs.readFile(path.join(uploadsDir, 'canonical.png'));
    expect(copied).toEqual(Buffer.from([1, 2, 3]));
  });

  it('throws E_UPLOAD_FAILED when the local file does not exist', async () => {
    const backend = new FileDropBackend();
    await expect(backend.uploadImage('/does/not/exist.png')).rejects.toMatchObject({ code: 'E_UPLOAD_FAILED' });
  });
});

describe('FileDropBackend.checkReady', () => {
  it('is a no-op (nothing to introspect in the file-drop model)', async () => {
    const backend = new FileDropBackend();
    await expect(backend.checkReady(['KSampler'])).resolves.toBeUndefined();
  });
});
