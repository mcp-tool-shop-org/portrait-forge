import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createOllamaLens, createSiglipLens, hasPairwise, type ChildProcessLike } from '../../src/gate/lenses.js';
import type { Question } from '../../src/gate/questions.js';

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'species',
    text: 'This portrait shows a human.',
    targetPhrase: 'a human',
    contrastAlternatives: ['a dragon', 'a robot'],
    expected: 'yes',
    required: true,
    kind: 'species',
    ...overrides,
  };
}

/** A fake `scripts/siglip_lens.py` child process: echoes back a canned
 * result for each request line it receives, keyed by request `op`, without
 * spawning Python or touching the GPU. */
function makeFakeSiglipProcess(responder: (req: Record<string, unknown>) => unknown) {
  const stdout = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
  const written: string[] = [];
  const proc: ChildProcessLike = {
    stdin: {
      write: (chunk: unknown) => {
        const line = String(chunk);
        written.push(line);
        const req = JSON.parse(line) as Record<string, unknown>;
        const result = responder(req);
        // Respond asynchronously, like a real child process would.
        queueMicrotask(() => {
          stdout.emit('data', `${JSON.stringify({ id: req.id, result })}\n`);
        });
        return true;
      },
      end: () => {},
    },
    stdout,
    stderr: new EventEmitter(),
    once: () => proc,
    kill: () => true,
  };
  return { proc, written };
}

describe('createSiglipLens', () => {
  it('calls image_verify with the target phrase and contrast alternatives for ask()', async () => {
    const { proc, written } = makeFakeSiglipProcess((req) => {
      expect(req.op).toBe('verify');
      expect(req.target).toBe('a human');
      expect(req.alternatives).toEqual(['a dragon', 'a robot']);
      return { present: true, target_score: 0.7, best_alternative: 'a dragon', margin: 0.5, confidence: 'high' };
    });
    const lens = createSiglipLens({ spawnFn: () => proc });
    const result = await lens.ask('/fake/image.png', makeQuestion());
    expect(result.answer).toBe('yes');
    expect(result.score).toBe(0.7);
    expect(written).toHaveLength(1);
  });

  it('maps present:false to answer "no"', async () => {
    const { proc } = makeFakeSiglipProcess(() => ({ present: false, target_score: 0.1 }));
    const lens = createSiglipLens({ spawnFn: () => proc });
    const result = await lens.ask('/fake/image.png', makeQuestion({ expected: 'no' }));
    expect(result.answer).toBe('no');
  });

  it('calls image_compare for sameness and thresholds on similarity', async () => {
    const { proc } = makeFakeSiglipProcess((req) => {
      expect(req.op).toBe('compare');
      expect(req.image_a).toBe('/fake/a.png');
      expect(req.image_b).toBe('/fake/b.png');
      return { similarity: 0.92 };
    });
    const lens = createSiglipLens({ spawnFn: () => proc });
    const result = await lens.same('/fake/a.png', '/fake/b.png');
    expect(result.same).toBe(true);
    expect(result.score).toBe(0.92);
  });

  it('reports not-same below the similarity floor', async () => {
    const { proc } = makeFakeSiglipProcess(() => ({ similarity: 0.2 }));
    const lens = createSiglipLens({ spawnFn: () => proc });
    const result = await lens.same('/fake/a.png', '/fake/b.png');
    expect(result.same).toBe(false);
  });

  it('reuses a single spawned process across multiple calls', async () => {
    let spawnCount = 0;
    const { proc } = makeFakeSiglipProcess(() => ({ similarity: 0.5 }));
    const lens = createSiglipLens({
      spawnFn: () => {
        spawnCount += 1;
        return proc;
      },
    });
    await lens.same('/a.png', '/b.png');
    await lens.same('/a.png', '/c.png');
    expect(spawnCount).toBe(1);
  });

  it('rejects in-flight calls if the process exits', async () => {
    const stdout = new EventEmitter();
    const exitHandlers: Array<(code: number) => void> = [];
    const proc: ChildProcessLike = {
      stdin: { write: () => true, end: () => {} },
      stdout,
      stderr: new EventEmitter(),
      once: (event, listener) => {
        if (event === 'exit') exitHandlers.push(listener as (code: number) => void);
        return proc;
      },
      kill: () => true,
    };
    const lens = createSiglipLens({ spawnFn: () => proc });
    const pending = lens.same('/a.png', '/b.png');
    for (const h of exitHandlers) h(1);
    await expect(pending).rejects.toThrow(/exited/);
  });
});

describe('createOllamaLens', () => {
  function makeFetch(content: unknown) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: { content: JSON.stringify(content) } }),
    })) as unknown as typeof fetch;
  }

  const readImage = async () => Buffer.from('fake-png-bytes');

  it('posts to /api/chat with images, format json, keep_alive 0, temperature 0', async () => {
    const fetchFn = makeFetch({ answer: 'yes' });
    const lens = createOllamaLens({ fetchFn, readImage, host: 'http://localhost:11434' });
    await lens.ask('/fake/image.png', makeQuestion());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(String(init.body));
    expect(body.format).toBe('json');
    expect(body.keep_alive).toBe(0);
    expect(body.options.temperature).toBe(0);
    expect(body.messages[0].images).toEqual([Buffer.from('fake-png-bytes').toString('base64')]);
  });

  it('answers yes/no for ask()', async () => {
    const lensYes = createOllamaLens({ fetchFn: makeFetch({ answer: 'yes' }), readImage });
    const lensNo = createOllamaLens({ fetchFn: makeFetch({ answer: 'no' }), readImage });
    expect((await lensYes.ask('/a.png', makeQuestion())).answer).toBe('yes');
    expect((await lensNo.ask('/a.png', makeQuestion())).answer).toBe('no');
  });

  it('treats any non-"yes" answer as "no" (never throws on a malformed answer)', async () => {
    const lens = createOllamaLens({ fetchFn: makeFetch({ answer: 'maybe' }), readImage });
    expect((await lens.ask('/a.png', makeQuestion())).answer).toBe('no');
  });

  it('answers same() with a boolean', async () => {
    const lens = createOllamaLens({ fetchFn: makeFetch({ same: true }), readImage });
    expect((await lens.same('/a.png', '/b.png')).same).toBe(true);
  });

  it('answers pairwise() with a/b and exposes it via hasPairwise', async () => {
    const lens = createOllamaLens({ fetchFn: makeFetch({ winner: 'b' }), readImage });
    expect(hasPairwise(lens)).toBe(true);
    const result = await lens.pairwise('/a.png', '/b.png', 'a knight in plate armor');
    expect(result.winner).toBe('b');
  });

  it('throws a descriptive error on a non-ok HTTP response', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch;
    const lens = createOllamaLens({ fetchFn, readImage });
    await expect(lens.ask('/a.png', makeQuestion())).rejects.toThrow(/500/);
  });
});
