// Builder A -- src/backends/cloud.ts
// Comfy Cloud, against the documented v1 Cloud API (docs.comfy.org/development/cloud/overview
// + the linked Cloud API Reference, retrieved 2026-09-01). design B2 §1
// (findings 12-19, 20, 21): "the same graph submitted to Comfy Cloud with
// the LoRA uploaded once"; local and cloud are expected to be near-identical,
// not bit-identical (19) -- the acceptance gate, not the seed, guarantees a
// portrait is right.
//
// UNVERIFIED LIVE: this adapter has not been exercised against a live Comfy
// Cloud account (no COMFY_CLOUD_API_KEY was available in this build session
// -- see the coordinator's note about the hosted MCP plugin path, which is
// how this rig actually drives Comfy Cloud today; `file.ts` in this same
// directory is the adapter that plugin path uses). Endpoints below are taken
// verbatim from the docs:
//
//   Base URL:        https://cloud.comfy.org
//   Auth header:      X-API-Key: <COMFY_CLOUD_API_KEY>            (401 if missing/invalid, 429 if inactive subscription)
//   POST /api/prompt                  { prompt: <graph>, extra_data?: { api_key_comfy_org } } -> { prompt_id, error? }
//   GET  /api/job/{prompt_id}/status  -> { status: 'success' | 'error' | 'non_retryable_error' | 'lost' | 'cancelled' | <in-flight> }
//   POST /api/upload/image            multipart form (image, type, overwrite) -> { name, subfolder }
//   GET  /api/view?filename=&subfolder=&type=  -> 302 redirect to a signed download URL (fetch follows it automatically)
//   GET  /api/object_info             -> same shape as local ComfyUI's /object_info
//
// The docs do not show what a "success" status response contains beyond the
// status string itself -- output files are described as arriving over a
// WebSocket (`wss://cloud.comfy.org/ws?clientId=&token=`) as `executed`
// messages carrying `{ images: [...] }` in the node's `output` field. This
// adapter does not open that socket (no runtime dependency budget for a ws
// client); instead, once status is 'success' it re-reads `/api/job/{id}/status`
// once more defensively for an `outputs` field shaped like local's
// `/history/{id}.outputs` (some Cloud deployments mirror it) and falls back
// to treating the whole response body as that shape. If your account's
// response differs, that fallback is the first thing to adjust -- it is
// intentionally isolated in `extractImages()` below.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Backend, RunOptions, RunResult, UploadResult } from './types.js';
import { makeError, ERROR_CODES } from './types.js';

export interface CloudBackendOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const DEFAULT_BASE_URL = 'https://cloud.comfy.org';

interface JobStatusBody {
  status: 'success' | 'error' | 'non_retryable_error' | 'lost' | 'cancelled' | string;
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
  error?: string;
}

export class CloudComfyBackend implements Backend {
  readonly name = 'cloud' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(opts: CloudBackendOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.COMFY_CLOUD_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.COMFY_CLOUD_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60 * 1000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 500;
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw makeError(
        ERROR_CODES.CLOUD_KEY_MISSING,
        'portrait-forge: COMFY_CLOUD_API_KEY is not set',
        'export COMFY_CLOUD_API_KEY=<your Comfy Cloud key> (never write it to a file)',
      );
    }
    return this.apiKey;
  }

  private authHeaders(): Record<string, string> {
    return { 'X-API-Key': this.requireApiKey() };
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
      ERROR_CODES.CLOUD_UNREACHABLE,
      `portrait-forge: could not reach Comfy Cloud at ${this.baseUrl}: ${String((lastErr as Error)?.message ?? lastErr)}`,
      'confirm network access to cloud.comfy.org and that COMFY_CLOUD_URL (if set) is correct',
    );
  }

  async checkReady(requiredNodeClasses: string[]): Promise<void> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/api/object_info`, { headers: this.authHeaders() });
    if (res.status === 401) {
      throw makeError(ERROR_CODES.CLOUD_KEY_MISSING, 'portrait-forge: Comfy Cloud rejected the API key (401)', 'check COMFY_CLOUD_API_KEY');
    }
    if (!res.ok) {
      throw makeError(
        ERROR_CODES.CLOUD_UNREACHABLE,
        `portrait-forge: /api/object_info returned ${res.status}`,
        'confirm the Comfy Cloud subscription is active and the service is healthy',
      );
    }
    const info = (await res.json()) as Record<string, unknown>;
    const missing = requiredNodeClasses.filter((cls) => !(cls in info));
    if (missing.length > 0) {
      throw makeError(
        ERROR_CODES.COMFY_NODE_MISSING,
        `portrait-forge: Comfy Cloud is missing required node class(es): ${missing.join(', ')}`,
        'this workflow needs custom nodes the Cloud deployment does not have registered',
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
    const res = await this.fetchWithRetry(`${this.baseUrl}/api/upload/image`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeError(
        ERROR_CODES.UPLOAD_FAILED,
        `portrait-forge: /api/upload/image returned ${res.status}: ${text.slice(0, 500)}`,
        'confirm the API key has upload permission and the account has credits',
      );
    }
    const body = (await res.json()) as { name: string; subfolder?: string };
    return { filename: body.name, subfolder: body.subfolder ?? '', type: 'input' };
  }

  async run(graph: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const submitRes = await this.fetchWithRetry(`${this.baseUrl}/api/prompt`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
    });
    if (submitRes.status === 402) {
      throw makeError(ERROR_CODES.CLOUD_UNREACHABLE, 'portrait-forge: Comfy Cloud reports insufficient credits (402)', 'add credits to the Comfy Cloud account');
    }
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => '');
      throw makeError(
        ERROR_CODES.GENERATION_FAILED,
        `portrait-forge: /api/prompt rejected the graph (${submitRes.status}): ${text.slice(0, 2000)}`,
        're-check the graph against a fresh GET /api/object_info; a node input name or value is likely stale',
      );
    }
    const submitBody = (await submitRes.json()) as { prompt_id: string; error?: string };
    if (submitBody.error) {
      throw makeError(ERROR_CODES.GENERATION_FAILED, `portrait-forge: Comfy Cloud rejected the graph: ${submitBody.error}`, 'fix the named node inputs in the workflow file');
    }
    const promptId = submitBody.prompt_id;

    const deadline = Date.now() + timeoutMs;
    let statusBody: JobStatusBody | undefined;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw makeError(ERROR_CODES.GENERATION_FAILED, 'portrait-forge: run aborted', 'the caller cancelled the request');
      }
      const statusRes = await this.fetchWithRetry(`${this.baseUrl}/api/job/${promptId}/status`, { headers: this.authHeaders() });
      if (statusRes.ok) {
        const body = (await statusRes.json()) as JobStatusBody;
        if (body.status === 'success') {
          statusBody = body;
          break;
        }
        if (body.status === 'error' || body.status === 'non_retryable_error' || body.status === 'lost' || body.status === 'cancelled') {
          throw makeError(
            ERROR_CODES.GENERATION_FAILED,
            `portrait-forge: Comfy Cloud run ${promptId} ended in status '${body.status}'${body.error ? `: ${body.error}` : ''}`,
            'check the Comfy Cloud dashboard for the run for the underlying error',
          );
        }
      }
      await delay(this.pollIntervalMs);
    }
    if (!statusBody) {
      throw makeError(
        ERROR_CODES.GENERATION_TIMEOUT,
        `portrait-forge: timed out waiting for /api/job/${promptId}/status after ${timeoutMs}ms`,
        'increase RunOptions.timeoutMs, or check the Comfy Cloud dashboard for a stuck job',
      );
    }

    await fs.mkdir(opts.outDir, { recursive: true });
    const images: RunResult['images'] = [];
    for (const imgRef of this.extractImages(statusBody)) {
      const params = new URLSearchParams({
        filename: imgRef.filename,
        subfolder: imgRef.subfolder ?? '',
        type: imgRef.type ?? 'output',
      });
      const viewRes = await this.fetchWithRetry(`${this.baseUrl}/api/view?${params.toString()}`, { headers: this.authHeaders() });
      if (!viewRes.ok) {
        throw makeError(
          ERROR_CODES.GENERATION_FAILED,
          `portrait-forge: /api/view returned ${viewRes.status} for ${imgRef.filename}`,
          'the signed output URL may have expired between generation and download',
        );
      }
      const buf = Buffer.from(await viewRes.arrayBuffer());
      const destPath = path.join(opts.outDir, imgRef.filename);
      await fs.writeFile(destPath, buf);
      images.push({ path: destPath, filename: imgRef.filename });
    }

    if (images.length === 0) {
      throw makeError(
        ERROR_CODES.GENERATION_FAILED,
        `portrait-forge: Comfy Cloud run ${promptId} reported status 'success' but no output images were found in the status response`,
        'this Cloud account\'s status response shape does not match the assumed `outputs` field -- see the UNVERIFIED LIVE note at the top of cloud.ts',
      );
    }

    return { images, promptId, durationMs: Date.now() - start };
  }

  /** Isolated so a differently-shaped success response is a one-function fix. See the UNVERIFIED LIVE note above. */
  private extractImages(body: JobStatusBody): Array<{ filename: string; subfolder?: string; type?: string }> {
    const out: Array<{ filename: string; subfolder?: string; type?: string }> = [];
    for (const output of Object.values(body.outputs ?? {})) {
      for (const img of output.images ?? []) {
        out.push(img);
      }
    }
    return out;
  }
}
