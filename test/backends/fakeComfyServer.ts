// Builder A -- test helper: a fake ComfyUI-shaped HTTP server (node:http),
// parameterized to also answer the Comfy Cloud v1 shape (`/api/...` prefix,
// `/api/job/{id}/status` instead of `/history/{id}`, `X-API-Key` auth) so the
// same fixture backs both `local.test.ts` and `cloud.test.ts`. Records every
// posted graph and every uploaded file for assertions.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A minimal valid 1x1 PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000155ff9d4d0000000049454e44ae426082',
  'hex',
);

export interface FakeComfyServerOptions {
  objectInfoClasses: string[];
  promptId?: string;
  outputFilename?: string;
  /** '' for the local ComfyUI shape, '/api' for the Comfy Cloud shape. */
  apiPrefix?: string;
  /** When set, every request must carry this value in the X-API-Key header. */
  requireApiKey?: string;
  /** Milliseconds after /prompt (or /api/prompt) before history/status reports success. */
  readyAfterMs?: number;
}

export interface FakeComfyServer {
  server: Server;
  url: string;
  postedGraphs: Array<Record<string, unknown>>;
  uploadedFiles: Array<{ filename: string; bytes: Buffer }>;
  close(): Promise<void>;
}

export function startFakeComfyServer(opts: FakeComfyServerOptions): Promise<FakeComfyServer> {
  const prefix = opts.apiPrefix ?? '';
  const promptId = opts.promptId ?? 'test-prompt-id';
  const outputFilename = opts.outputFilename ?? 'ComfyUI_00001_.png';
  const readyAfterMs = opts.readyAfterMs ?? 20;
  const postedGraphs: Array<Record<string, unknown>> = [];
  const uploadedFiles: Array<{ filename: string; bytes: Buffer }> = [];
  let readyAt = 0;

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (opts.requireApiKey && req.headers['x-api-key'] !== opts.requireApiKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (url.pathname === `${prefix}/object_info` && req.method === 'GET') {
        const body: Record<string, unknown> = {};
        for (const cls of opts.objectInfoClasses) body[cls] = { input: { required: {} } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      if (url.pathname === `${prefix}/prompt` && req.method === 'POST') {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(data) as { prompt?: Record<string, unknown> };
          postedGraphs.push(parsed.prompt ?? {});
          readyAt = Date.now() + readyAfterMs;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ prompt_id: promptId }));
        });
        return;
      }

      if (url.pathname === `${prefix}/history/${promptId}` && req.method === 'GET') {
        if (Date.now() < readyAt) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            [promptId]: {
              status: { status_str: 'success' },
              outputs: { '13': { images: [{ filename: outputFilename, subfolder: '', type: 'output' }] } },
            },
          }),
        );
        return;
      }

      if (url.pathname === `${prefix}/job/${promptId}/status` && req.method === 'GET') {
        if (Date.now() < readyAt) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'running' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'success',
            outputs: { '13': { images: [{ filename: outputFilename, subfolder: '', type: 'output' }] } },
          }),
        );
        return;
      }

      if (url.pathname === `${prefix}/view` && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
        return;
      }

      if (url.pathname === `${prefix}/upload/image` && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          uploadedFiles.push({ filename: 'uploaded.png', bytes: body });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }));
        });
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        postedGraphs,
        uploadedFiles,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
