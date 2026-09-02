// Builder A -- src/backends/local.ts
// The portable ComfyUI on this rig: POST /prompt, poll GET /history/{id},
// download GET /view, upload the canonical via POST /upload/image. design B2
// §1 (findings 12-19): "the same graph submitted to [the] local [backend]";
// the manifest records `backend`. Rig fact (2026-09-01): ComfyUI 0.23.0 at
// http://127.0.0.1:8188, started with --disable-smart-memory.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Backend, RunOptions, RunResult, UploadResult } from './types.js';
import { makeError, ERROR_CODES } from './types.js';

export interface LocalBackendOptions {
  baseUrl?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** Default poll ceiling when RunOptions.timeoutMs is not given. */
  defaultTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

interface HistoryImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: HistoryImageRef[] }>;
  status?: { status_str?: string; messages?: unknown[] };
}

export class LocalComfyBackend implements Backend {
  readonly name = 'local' as const;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(opts: LocalBackendOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.COMFY_LOCAL_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.clientId = opts.clientId ?? 'portrait-forge';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60 * 1000; // 10 minutes
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 500;
  }

  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.fetchImpl(url, init);
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await delay(this.retryBaseDelayMs * 2 ** attempt);
        }
      }
    }
    throw makeError(
      ERROR_CODES.COMFY_UNREACHABLE,
      `portrait-forge: could not reach local ComfyUI at ${this.baseUrl}: ${String((lastErr as Error)?.message ?? lastErr)}`,
      'confirm ComfyUI is running (--listen 127.0.0.1 --port 8188) and COMFY_LOCAL_URL is unset or points at it',
    );
  }

  /** design B2 §1: a startup check that every node class the workflow uses is registered. */
  async checkReady(requiredNodeClasses: string[]): Promise<void> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/object_info`);
    if (!res.ok) {
      throw makeError(
        ERROR_CODES.COMFY_UNREACHABLE,
        `portrait-forge: /object_info returned ${res.status}`,
        'confirm the local ComfyUI server is healthy',
      );
    }
    const info = (await res.json()) as Record<string, unknown>;
    const missing = requiredNodeClasses.filter((cls) => !(cls in info));
    if (missing.length > 0) {
      throw makeError(
        ERROR_CODES.COMFY_NODE_MISSING,
        `portrait-forge: ComfyUI is missing required node class(es): ${missing.join(', ')}`,
        'install/enable the custom nodes providing these classes, or update ComfyUI, then retry',
      );
    }
  }

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
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), path.basename(localPath));
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await this.fetchWithRetry(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeError(
        ERROR_CODES.UPLOAD_FAILED,
        `portrait-forge: /upload/image returned ${res.status}: ${text.slice(0, 500)}`,
        'confirm ComfyUI has write access to its input directory',
      );
    }
    const body = (await res.json()) as { name: string; subfolder?: string; type?: string };
    return { filename: body.name, subfolder: body.subfolder ?? '', type: body.type ?? 'input' };
  }

  async run(graph: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const submitRes = await this.fetchWithRetry(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => '');
      throw makeError(
        ERROR_CODES.GENERATION_FAILED,
        `portrait-forge: /prompt rejected the graph (${submitRes.status}): ${text.slice(0, 2000)}`,
        're-check the graph against a fresh GET /object_info; a node input name or value is likely stale',
      );
    }
    const submitBody = (await submitRes.json()) as {
      prompt_id: string;
      node_errors?: Record<string, unknown>;
    };
    if (submitBody.node_errors && Object.keys(submitBody.node_errors).length > 0) {
      throw makeError(
        ERROR_CODES.GENERATION_FAILED,
        `portrait-forge: ComfyUI reported node errors: ${JSON.stringify(submitBody.node_errors)}`,
        'fix the named node inputs in the workflow file',
      );
    }
    const promptId = submitBody.prompt_id;

    const deadline = Date.now() + timeoutMs;
    let history: HistoryEntry | undefined;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw makeError(ERROR_CODES.GENERATION_FAILED, 'portrait-forge: run aborted', 'the caller cancelled the request');
      }
      const histRes = await this.fetchWithRetry(`${this.baseUrl}/history/${promptId}`);
      if (histRes.ok) {
        const body = (await histRes.json()) as Record<string, HistoryEntry>;
        const entry = body[promptId];
        if (entry?.status?.status_str === 'error') {
          throw makeError(
            ERROR_CODES.GENERATION_FAILED,
            `portrait-forge: ComfyUI run ${promptId} failed: ${JSON.stringify(entry.status)}`,
            'check the ComfyUI server console for the underlying exception',
          );
        }
        if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
          history = entry;
          break;
        }
      }
      await delay(this.pollIntervalMs);
    }
    if (!history) {
      throw makeError(
        ERROR_CODES.GENERATION_TIMEOUT,
        `portrait-forge: timed out waiting for /history/${promptId} after ${timeoutMs}ms`,
        'increase RunOptions.timeoutMs, or check whether ComfyUI is stuck/queued behind other jobs',
      );
    }

    await fs.mkdir(opts.outDir, { recursive: true });
    const images: RunResult['images'] = [];
    for (const output of Object.values(history.outputs ?? {})) {
      for (const img of output.images ?? []) {
        const params = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder ?? '',
          type: img.type ?? 'output',
        });
        const viewRes = await this.fetchWithRetry(`${this.baseUrl}/view?${params.toString()}`);
        if (!viewRes.ok) {
          throw makeError(
            ERROR_CODES.GENERATION_FAILED,
            `portrait-forge: /view returned ${viewRes.status} for ${img.filename}`,
            'the output file may have been cleaned up between generation and download',
          );
        }
        const buf = Buffer.from(await viewRes.arrayBuffer());
        const destPath = path.join(opts.outDir, img.filename);
        await fs.writeFile(destPath, buf);
        images.push({ path: destPath, filename: img.filename });
      }
    }

    return { images, promptId, durationMs: Date.now() - start };
  }
}
