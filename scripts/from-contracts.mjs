#!/usr/bin/env node
// Build a cast file from prompt-craft contracts (Director ruling 2026-09-02:
// descriptions are contract atoms, never hand-written prose). For every
// roster entry: resolve the character contract and its `extends` faction
// (faction atoms first, prompt-craft's own order), run `pcraft synth --json`
// as the validator and provenance witness, and emit an EntityDescription
// carrying `contract: { id, atoms, pcraftPrompt }`.
//
// Usage: node scripts/from-contracts.mjs --roster casts/<pack>.roster.json --contracts-dir <dir> --out casts/<pack>.json
// Roster: [{ "contract": "char:pilgrim", "id": "pilgrim", "name": "Suspicious Pilgrim", "kind": "npc", "tags": [...], "major": false }]
// Env: PCRAFT (path to the pcraft executable; default `pcraft` on PATH).
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const rosterPath = flag('--roster'); const contractsDir = flag('--contracts-dir'); const outPath = flag('--out');
if (!rosterPath || !contractsDir || !outPath) { console.error('usage: from-contracts --roster <json> --contracts-dir <dir> --out <json>'); process.exit(1); }
const pcraft = process.env.PCRAFT ?? 'pcraft';

async function loadContracts(dir) {
  const byId = new Map();
  for (const sub of ['factions', 'characters']) {
    let files = [];
    try { files = await readdir(join(dir, sub)); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.contract.json'))) {
      const c = JSON.parse(await readFile(join(dir, sub, f), 'utf8'));
      byId.set(c.id, c);
    }
  }
  return byId;
}

function atomsOf(contract, byId) {
  const chain = [];
  for (let c = contract; c; c = c.extends ? byId.get(c.extends) : undefined) chain.unshift(c);
  const atoms = [];
  // A `palette` atom is verified by prompt-craft's own deterministic pixel
  // check, not by a vision question -- a VLM asked "does this show a palette
  // of grave grey and bruise violet" answers by impression (measured
  // 2026-09-02: the ash ghoul failed its faction palette on the vision lens
  // alone, 13/14 atoms passing). Here it shapes the prompt and is asked as
  // an advisory (not required) question; `pcraft gate` remains the palette
  // authority.
  const required = (a) => a.severity === 'required' && a.check_type !== 'palette';
  for (const c of chain) {
    for (const a of c.must_have ?? []) atoms.push({ id: a.id, claim: a.claim, expected: 'yes', required: required(a) });
  }
  for (const c of chain) {
    for (const a of c.must_not ?? []) atoms.push({ id: a.id, claim: a.claim, expected: 'no', required: required(a) });
  }
  return atoms;
}

function synth(id) {
  const r = spawnSync(pcraft, ['synth', '--contract', id, '--contracts-dir', contractsDir, '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pcraft synth ${id} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  const out = r.stdout; const i = out.indexOf('{');
  return JSON.parse(out.slice(i));
}

const roster = JSON.parse(await readFile(rosterPath, 'utf8'));
const byId = await loadContracts(contractsDir);
const cast = [];
for (const entry of roster) {
  const contract = byId.get(entry.contract);
  if (!contract) throw new Error(`roster names ${entry.contract} but no such contract under ${contractsDir}`);
  const result = synth(entry.contract);
  const atoms = atomsOf(contract, byId);
  cast.push({
    id: entry.id, name: entry.name, kind: entry.kind, tags: entry.tags ?? [], packId: entry.packId ?? roster.packId ?? 'starter-fantasy',
    ...(entry.faction ? { faction: entry.faction } : {}), ...(entry.major !== undefined ? { major: entry.major } : {}),
    ...(entry.shapeTilt ? { shapeTilt: entry.shapeTilt } : {}),
    contract: { id: entry.contract, atoms, pcraftPrompt: result.prompt },
  });
  console.log(`${entry.id}: ${entry.contract} -> ${atoms.length} atoms (${atoms.filter((a) => a.expected === 'no').length} must_not); pcraft synth ok`);
}
await writeFile(outPath, JSON.stringify(cast, null, 2) + '\n');
console.log(`wrote ${outPath} (${cast.length} entities)`);
