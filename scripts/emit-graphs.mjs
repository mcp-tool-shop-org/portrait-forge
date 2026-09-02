#!/usr/bin/env node
// Emit the N candidate graphs per cast entity WITHOUT running a backend --
// the operator submits them elsewhere (the Comfy Cloud MCP plugin, a
// remote ComfyUI) and later runs `portrait-forge accept --candidates <dir>`
// to gate what came back. Same prefix convention as the file backend
// (`<packId>-<entityId>-r0-<i>`), same seed law (design §2: seed, seed+1,
// seed+2), same pinned workflow (design §1). `--lora-name` rewrites the
// LoraLoaderModelOnly's `lora_name` for a server that stores the same LoRA
// under a different filename (Comfy Cloud's imported-model naming); the
// manifest still records the pinned local name plus the file's SHA-256.
//
// Usage: node scripts/emit-graphs.mjs --cast casts/starter-fantasy.json --out <dir> [--n 3] [--lora-name <name>] [--only id,id]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, descriptionHash, deriveSeed } from '../dist/prompt/slots.js';
import { loadWorkflow, workflowSha256, fillSlots } from '../dist/workflow/pin.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const castPath = flag('--cast');
const outDir = flag('--out');
const n = Number(flag('--n', '3'));
const loraName = flag('--lora-name');
const only = flag('--only') ? new Set(flag('--only').split(',')) : null;
if (!castPath || !outDir) {
  console.error('usage: emit-graphs --cast <json array> --out <dir> [--n 3] [--lora-name <name>] [--only id,id]');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(root, 'workflows', 'qwen-sfhd.portrait.json');
const template = await loadWorkflow(workflowPath);
const sha = workflowSha256(template);
const cast = JSON.parse(await readFile(castPath, 'utf8'));
await mkdir(outDir, { recursive: true });

const index = [];
for (const desc of cast) {
  if (only && !only.has(desc.id)) continue;
  const hash = descriptionHash(desc);
  const seedBase = Number(deriveSeed(desc.packId, desc.id, hash) & ((1n << 53n) - 1n));
  const prompt = buildPrompt(desc);
  for (let i = 0; i < n; i++) {
    const seed = seedBase + i;
    const prefix = `${desc.packId}-${desc.id}-r0-${i}`;
    // KSampler.seed is an INT input: pass a number so the filled graph carries a bare integer, not a quoted string.
    const graph = fillSlots(template, { seed, positive: prompt.positive, negative: prompt.negative, prefix });
    if (loraName) {
      for (const node of Object.values(graph)) {
        if (node.class_type === 'LoraLoaderModelOnly') node.inputs.lora_name = loraName;
      }
    }
    await writeFile(join(outDir, `${prefix}.graph.json`), JSON.stringify(graph, null, 2));
    index.push({ entityId: desc.id, prefix, seed, descriptionHash: hash, workflowSha256: sha, loraNameOverride: loraName ?? null });
  }
  await writeFile(join(outDir, `${desc.packId}-${desc.id}.prompt.json`), JSON.stringify({ descriptionHash: hash, seedBase, ...prompt }, null, 2));
}
await writeFile(join(outDir, 'index.json'), JSON.stringify({ emittedAt: new Date().toISOString(), workflowSha256: sha, graphs: index }, null, 2));
console.log(`emitted ${index.length} graphs to ${outDir} (workflow ${sha.slice(0, 12)})`);
