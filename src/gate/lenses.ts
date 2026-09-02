// The two acceptance-gate lenses (BUILD_SPEC.md Builder B, src/gate/lenses.ts;
// design law §3). Both lenses answer the same Question shape so `judge`
// (src/gate/accept.ts) can require both to agree before a required
// question passes.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { Question } from './questions.js';

export interface LensAnswer {
  answer: 'yes' | 'no';
  score?: number;
}

export interface LensSameness {
  same: boolean;
  score?: number;
}

export interface Lens {
  name: string;
  family: 'siglip' | 'ollama';
  ask(imagePath: string, question: Question): Promise<LensAnswer>;
  same(imageA: string, imageB: string): Promise<LensSameness>;
}

/** The Ollama lens additionally answers the pairwise tie-break (design law
 * §3, finding 28: "ties broken by the Ollama lens's pairwise ... call").
 * Not part of the base `Lens` interface -- only the Ollama lens implements
 * it; `accept.ts` narrows to this type before calling it. */
export interface PairwiseLens extends Lens {
  pairwise(imageA: string, imageB: string, description: string): Promise<{ winner: 'a' | 'b'; raw: unknown }>;
}

export function hasPairwise(lens: Lens): lens is PairwiseLens {
  return typeof (lens as Partial<PairwiseLens>).pairwise === 'function';
}

// ---------------------------------------------------------------------------
// SigLIP lens -- drives scripts/siglip_lens.py as a long-lived child process
// speaking newline-delimited JSON on stdin/stdout.
// ---------------------------------------------------------------------------

/** Minimal shape of a child process the SigLIP lens needs. Real
 * `child_process.spawn(...)` satisfies this; tests inject a fake double
 * (no GPU, no Python interpreter, in CI). */
export interface ChildProcessLike {
  stdin: Pick<Writable, 'write' | 'end'>;
  stdout: Pick<Readable, 'on'>;
  stderr?: Pick<Readable, 'on'> | null;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
  kill(): boolean | void;
}

export type SpawnFn = (command: string, args: string[]) => ChildProcessLike;

interface RpcResponse {
  id: string | null;
  result?: unknown;
  error?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Two levels up from src/gate/ is the repo root; scripts/siglip_lens.py
// lives there in both the src tree and the tsc-mirrored dist tree.
const DEFAULT_SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'siglip_lens.py');
// Measured on this rig (2026-09-01): the ai-eyes-mcp Python 3.11 venv is
// where `import ai_eyes_mcp.engine` resolves (see final report). Override
// via SIGLIP_PYTHON in any other environment.
const DEFAULT_PYTHON_PATH = 'E:/AI/ai-eyes-mcp/.venv/Scripts/python.exe';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `r${requestCounter}-${Date.now()}`;
}

export interface SiglipLensOptions {
  pythonPath?: string;
  scriptPath?: string;
  /** Injectable for tests -- defaults to the real `child_process.spawn`. */
  spawnFn?: SpawnFn;
}

/**
 * Drives `scripts/siglip_lens.py` as a long-lived child process so the
 * SigLIP2 model loads once per lens instance, not once per question
 * (loading is multi-second -- see ai_eyes_mcp.engine._ensure_loaded_locked).
 * For a yes/no question this lens calls `image_verify` with the question's
 * `targetPhrase` against its `contrastAlternatives`; for sameness it calls
 * `image_compare` (module contract, BUILD_SPEC.md Builder B).
 */
export function createSiglipLens(options: SiglipLensOptions = {}): Lens {
  const pythonPath = options.pythonPath ?? process.env.SIGLIP_PYTHON ?? DEFAULT_PYTHON_PATH;
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const spawnFn: SpawnFn = options.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }));

  let child: ChildProcessLike | null = null;
  let buffer = '';
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  function failAllPending(err: Error): void {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  }

  function ensureStarted(): ChildProcessLike {
    if (child) return child;
    const proc = spawnFn(pythonPath, [scriptPath]);
    proc.stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let message: RpcResponse;
        try {
          message = JSON.parse(line) as RpcResponse;
        } catch {
          continue; // ignore stray non-JSON output on stdout
        }
        if (!message.id) continue;
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.result);
      }
    });
    proc.once('exit', (code) => {
      failAllPending(new Error(`siglip_lens.py exited unexpectedly (code ${String(code)})`));
      child = null;
    });
    proc.once('error', (err) => {
      failAllPending(err instanceof Error ? err : new Error(String(err)));
      child = null;
    });
    child = proc;
    return proc;
  }

  function call<T>(request: Record<string, unknown>): Promise<T> {
    const proc = ensureStarted();
    const id = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      proc.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  // Placeholder sameness floor -- design law §2 (findings 6, 8): the
  // masked-embedding citation was dropped at the different-family gate, so
  // this cosine-similarity floor is a LOCAL MEASUREMENT lever, not a cited
  // threshold. It has not yet been calibrated against a measured baseline
  // on the starter cast (see final report NEEDS line). The VLM pairwise
  // "same character" check (ollamaLens.same) is the primary identity gate;
  // this floor is a secondary signal.
  const SIGLIP_SAMENESS_THRESHOLD = 0.85;

  return {
    name: 'siglip',
    family: 'siglip',
    async ask(imagePath, question) {
      const result = await call<{ present: boolean; target_score?: number }>({
        op: 'verify',
        image: imagePath,
        target: question.targetPhrase,
        alternatives: question.contrastAlternatives,
      });
      return { answer: result.present ? 'yes' : 'no', score: result.target_score };
    },
    async same(imageA, imageB) {
      const result = await call<{ similarity: number }>({
        op: 'compare',
        image_a: imageA,
        image_b: imageB,
      });
      return { same: result.similarity >= SIGLIP_SAMENESS_THRESHOLD, score: result.similarity };
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama lens -- POST /api/chat with a base64 image, strict JSON out.
// ---------------------------------------------------------------------------

export interface OllamaLensOptions {
  host?: string;
  model?: string;
  /** Injectable for tests -- defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable for tests -- defaults to `node:fs/promises` readFile. */
  readImage?: (path: string) => Promise<Buffer>;
}

// Measured on this rig 2026-09-01: `gemma4:31b` (named in BUILD_SPEC.md as
// the vision model) reports capabilities `["completion","tools","thinking"]`
// -- NO "vision". `qwen3.6:35b-a3b` DOES report `vision` and is the closest
// local model in the same size class, so it is the default here. See final
// report NEEDS line: BUILD_SPEC.md's model claim is wrong against the rig.
const DEFAULT_OLLAMA_MODEL = 'qwen3.6:35b-a3b';

async function defaultReadImage(path: string): Promise<Buffer> {
  return readFile(path);
}

/**
 * `POST /api/chat` with `images: [base64]`, `format: 'json'`, `keep_alive: 0`,
 * temperature 0, asking a strict yes/no JSON for a question; a same/different
 * JSON for sameness; and a pairwise a/b JSON for the tie-break (module
 * contract, BUILD_SPEC.md Builder B).
 */
export function createOllamaLens(options: OllamaLensOptions = {}): PairwiseLens {
  const host = options.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = options.model ?? process.env.OLLAMA_VISION_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const fetchFn = options.fetchFn ?? fetch;
  const readImage = options.readImage ?? defaultReadImage;

  async function toBase64(imagePath: string): Promise<string> {
    const buf = await readImage(imagePath);
    return buf.toString('base64');
  }

  async function chatJson(prompt: string, images: string[]): Promise<Record<string, unknown>> {
    const res = await fetchFn(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images }],
        format: 'json',
        keep_alive: 0,
        options: { temperature: 0 },
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama /api/chat failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? '{}';
    return JSON.parse(content) as Record<string, unknown>;
  }

  return {
    name: 'ollama',
    family: 'ollama',
    async ask(imagePath, question) {
      const b64 = await toBase64(imagePath);
      const prompt =
        'Answer strictly as JSON: {"answer": "yes" | "no"}. ' +
        `Question: ${question.text} Look only at what is visually depicted.`;
      const parsed = await chatJson(prompt, [b64]);
      const answer = String(parsed.answer ?? '')
        .trim()
        .toLowerCase();
      return { answer: answer === 'yes' ? 'yes' : 'no' };
    },
    async same(imageA, imageB) {
      const [a, b] = await Promise.all([toBase64(imageA), toBase64(imageB)]);
      const prompt =
        'Answer strictly as JSON: {"same": true | false}. ' +
        'Are these two images the same individual character (allowing for a ' +
        'different pose, outfit, or damage), or a different character?';
      const parsed = await chatJson(prompt, [a, b]);
      return { same: Boolean(parsed.same) };
    },
    async pairwise(imageA, imageB, description) {
      const [a, b] = await Promise.all([toBase64(imageA), toBase64(imageB)]);
      const prompt =
        'Answer strictly as JSON: {"winner": "a" | "b"}. ' +
        'Which of these two images (the first is "a", the second is "b") better ' +
        `matches this description: ${description}`;
      const parsed = await chatJson(prompt, [a, b]);
      const winner = parsed.winner === 'b' ? 'b' : 'a';
      return { winner, raw: parsed };
    },
  };
}
