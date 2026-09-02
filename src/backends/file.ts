// Builder A -- src/backends/file.ts
// A "file-drop" backend for the coordination path this rig actually uses for
// Comfy Cloud today: the session's hosted Comfy Cloud MCP plugin holds its
// own credential server-side (no COMFY_CLOUD_API_KEY on disk to borrow), so
// a standalone HTTP adapter (cloud.ts) cannot drive it directly. Instead,
// this backend WRITES the filled graph to disk and WAITS for an operator (or
// the coordinating process driving that MCP plugin) to submit it and drop
// the resulting image back into the same directory.
//
// design B2 §1 (findings 12-19): still "the same graph", still one workflow
// file, still the same manifest shape -- only the transport between
// portrait-forge and the generator differs. `run()`'s return value is
// indistinguishable from `local.ts`/`cloud.ts` to a caller.
//
// Contract with whatever executes the graph:
//   1. portrait-forge writes `<outDir>/<prefix>.graph.json` (the exact
//      ComfyUI API-format graph, ready to submit as-is) and a sidecar
//      `<outDir>/<prefix>.request.json` (seed, prefix, workflow SHA-256,
//      the expected output filename pattern, and a submission timestamp).
//   2. The operator/plugin submits `<prefix>.graph.json` however it drives
//      Comfy Cloud, then saves the resulting image into `outDir` named
//      exactly `<prefix>.png`, or `<prefix>_<anything>.png` (ComfyUI's own
//      SaveImage counter-suffix convention) if it cannot control the exact
//      filename.
//   3. This backend polls `outDir` every `pollIntervalMs` (default 2s) up
//      to `opts.timeoutMs` for either name to appear and returns it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Backend, RunOptions, RunResult, UploadResult } from './types.js';
import { makeError, ERROR_CODES } from './types.js';

export interface FileBackendOptions {
  pollIntervalMs?: number;
  /** Generous default: a human or another agent is in the loop. */
  defaultTimeoutMs?: number;
  /** Where uploadImage() copies files an operator needs to submit alongside the graph. */
  uploadsDir?: string;
}

interface GraphNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

export class FileDropBackend implements Backend {
  readonly name = 'file' as const;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly uploadsDir: string;

  constructor(opts: FileBackendOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30 * 60 * 1000; // 30 minutes -- an operator is in the loop
    this.uploadsDir = opts.uploadsDir ?? path.join(process.cwd(), '_smoke', 'uploads');
  }

  /**
   * No live server to introspect in the file-drop model: whatever the
   * operator/plugin submits the graph to is responsible for its own node
   * availability. Intentionally a no-op.
   */
  async checkReady(_requiredNodeClasses: string[]): Promise<void> {
    return;
  }

  /** Stage a local file where the operator submitting the graph can find it. */
  async uploadImage(localPath: string): Promise<UploadResult> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(localPath);
    } catch (err) {
      throw makeError(
        ERROR_CODES.UPLOAD_FAILED,
        `portrait-forge: could not read local file ${localPath}: ${String((err as Error).message)}`,
        'confirm the canonical image path exists before uploading it',
      );
    }
    await fs.mkdir(this.uploadsDir, { recursive: true });
    const filename = path.basename(localPath);
    const dest = path.join(this.uploadsDir, filename);
    await fs.writeFile(dest, bytes);
    return { filename, subfolder: '', type: 'input' };
  }

  private extractGraphMeta(graph: Record<string, unknown>): { seed?: string; prefix?: string } {
    let seed: string | undefined;
    let prefix: string | undefined;
    for (const value of Object.values(graph)) {
      const node = value as GraphNode;
      if (!node || typeof node !== 'object' || !node.inputs) continue;
      if (node.class_type === 'KSampler' && node.inputs.seed !== undefined) {
        seed = String(node.inputs.seed);
      }
      if (node.class_type === 'SaveImage' && typeof node.inputs.filename_prefix === 'string') {
        prefix = node.inputs.filename_prefix;
      }
    }
    return { seed, prefix };
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async findOutput(outDir: string, prefix: string): Promise<string | undefined> {
    const exact = path.join(outDir, `${prefix}.png`);
    if (await this.pathExists(exact)) return exact;
    let entries: string[];
    try {
      entries = await fs.readdir(outDir);
    } catch {
      return undefined;
    }
    const match = entries.find((name) => name.startsWith(`${prefix}_`) && name.endsWith('.png'));
    return match ? path.join(outDir, match) : undefined;
  }

  async run(graph: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    await fs.mkdir(opts.outDir, { recursive: true });

    const { seed, prefix: extractedPrefix } = this.extractGraphMeta(graph);
    const prefix = extractedPrefix ?? `portrait-forge-${Date.now()}`;
    const promptId = `file:${prefix}`;

    const graphPath = path.join(opts.outDir, `${prefix}.graph.json`);
    const requestPath = path.join(opts.outDir, `${prefix}.request.json`);
    await fs.writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    await fs.writeFile(
      requestPath,
      JSON.stringify(
        {
          seed,
          prefix,
          workflowSha256: opts.workflowSha256,
          expectedOutput: `${prefix}.png (or ${prefix}_*.png)`,
          submittedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    const deadline = Date.now() + timeoutMs;
    let foundPath: string | undefined;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw makeError(ERROR_CODES.GENERATION_FAILED, 'portrait-forge: run aborted', 'the caller cancelled the request');
      }
      foundPath = await this.findOutput(opts.outDir, prefix);
      if (foundPath) break;
      await delay(this.pollIntervalMs);
    }
    if (!foundPath) {
      throw makeError(
        ERROR_CODES.GENERATION_TIMEOUT,
        `portrait-forge: timed out after ${timeoutMs}ms waiting for ${prefix}.png (or ${prefix}_*.png) in ${opts.outDir}`,
        `submit ${graphPath} (e.g. through the Comfy Cloud MCP plugin) and save its output image into ${opts.outDir} as ${prefix}.png`,
      );
    }

    return {
      images: [{ path: foundPath, filename: path.basename(foundPath) }],
      promptId,
      durationMs: Date.now() - start,
    };
  }
}
