# portrait-forge

Consistent character portraits from text descriptions: one pinned ComfyUI
workflow (local ComfyUI, Comfy Cloud, or a file-drop hand-off), a house-style
LoRA, a question-based acceptance gate with a vision verifier, and a
per-entity registry so a face stays the same across sessions and variants.

**Private until it is proper.** Not on npm; consumed by path from sibling
repos (e.g. `claude-rpg`'s `runtime-foundry`, design law §6).

## Why a gate, not a model

A diffusion model asked for "an old village priest in a hooded brown wool
cassock" will sometimes draw a hood on a woman, or drop the censer, or age
the wrong decade. Nothing catches that except looking at the picture and
asking. So portrait-forge never trusts one generation: it renders several
candidates, asks a fixed set of yes/no questions about the entity's own
description (never an aesthetic score — design law §3), and only writes a
canonical portrait when a candidate passes every required question through
**two independent vision lenses that must agree**. If nothing passes after
one retry with a re-slotted prompt, the entity keeps a plain silhouette
rather than ship a wrong face (design law §3: "no wrong face ever ships").
Every subsequent request for that entity is a no-op until its description
actually changes — the registry is content-addressed by a hash of the
description, not by a timestamp.

## The pinning rule

The workflow is a checked-in ComfyUI API-format graph
(`workflows/qwen-sfhd.portrait.json` for the canonical portrait,
`workflows/qwen-edit.variant.json` for edits from a canonical), pinned to
one base model, one house-style LoRA at one strength, one sampler/scheduler/
steps/cfg, and one frame size. Its SHA-256 (computed over the **unfilled**
file, before slots are substituted) rides in every manifest, alongside the
LoRA's own name/sha256/strength. A portrait's provenance is always
reconstructible: given the manifest, you know exactly which graph, which
model, which LoRA, and which seed produced it. Local and Comfy Cloud runs of
the same graph are expected to be near-identical, not bit-identical — the
gate, not the seed, is what guarantees a portrait is right (design law §1).

## Three backends

| Backend | What it does | Env |
|---|---|---|
| `local` | Submits the graph to a local ComfyUI (`http://127.0.0.1:8188` by default) and polls for the output. | — |
| `cloud` | Submits the same graph to Comfy Cloud, uploading the LoRA once. | `COMFY_CLOUD_API_KEY` |
| `file` | Drops the filled graph as `<outDir>/<prefix>.graph.json` and waits for `<outDir>/<prefix>.png` to appear, so an operator can run the graph through the Comfy Cloud MCP plugin by hand and drop the output back. | `--out <dir>`, `--wait-ms <n>` |

`local`, `cloud`, and the workflow files themselves are Builder A's
(`src/backends/**`, `src/workflow/**`, `workflows/**`); this package's `cli.ts`
wires them in at a composition root once they exist (see **Development**
below — this is the "green expected at merge" part of the build).

## The gate

From the entity's own description the app builds eight positively-phrased,
atomic yes/no questions with balanced polarity (at least two whose correct
answer is "no" — a species, garment, or prop the entity does *not* have),
never a negation in the question text (design law §3). Two independent
vision lenses — SigLIP2 (via `ai-eyes`) and a local vision LLM on Ollama —
each answer every question against every candidate; a required question
passes only when **both** lenses agree with the expected answer. A style
gate separately checks each candidate against reference plates from the
house-style LoRA's own training samples, rejecting anything off-look even if
the questions pass. Three candidates render per round (seed, seed+1,
seed+2); if none clears both gates, one more round runs with a re-slotted
prompt (palette dropped, shot widened); if that also fails, the entity gets
a silhouette placeholder instead of a wrong face. Variants (wounded, older,
hooded, ...) are edited from the canonical image, never from a previous
variant, and must pass a sameness check on both lenses plus their own
question before they're written.

## The registry

```
<registryRoot>/<packId>/<entityId>/canonical.png
<registryRoot>/<packId>/<entityId>/variants/<kind>.png
<registryRoot>/<packId>/<entityId>/manifest.json
<registryRoot>/<packId>/<entityId>/silhouette.png   (only if the gate never accepted)
```

`manifest.json` (design law §5):

```jsonc
{
  "descriptionHash": "sha256 of the slots that affect the image",
  "prompt": { "positive": "...", "negative": "...", "slots": { "...": "..." } },
  "seed": 123456,
  "workflowId": "qwen-sfhd.portrait",
  "workflowSha256": "sha256 of the unfilled workflow file",
  "loras": [{ "name": "sfhd_style_v1", "sha256": "...", "strength": 0.8 }],
  "backend": "local | cloud | file",
  "model": "qwen_image_2512_bf16.safetensors",
  "accepted": { "questions": [{ "q": "...", "expected": "yes", "answer": "yes" }], "styleScore": 0.88 },
  "identity": { "wounded": 0.95 },
  "status": "accepted | silhouette"
}
```

Regeneration only happens when `descriptionHash` changes — an unchanged
entity is a registry read, not a render.

## CLI

```
portrait-forge ensure --entity <json|-> --backend local|cloud|file [--registry <dir>] [--n <n>] [--out <dir>] [--wait-ms <n>]
portrait-forge variant --entity <json|-> --kind <kind> [--backend local|cloud|file] [--registry <dir>] [--out <dir>] [--wait-ms <n>]
portrait-forge check --backend local|cloud|file [--out <dir>]
portrait-forge cast --file <json array> [--backend local|cloud|file] [--registry <dir>]
portrait-forge accept --entity <json|-> --candidates <dir> [--registry <dir>]
```

`--entity` takes a JSON file path, inline JSON (starting with `{`), or `-`
for stdin. `accept` runs *only* the gate (style gate + judge + accept +
registry write) over PNGs already sitting in a directory — this is how
candidates rendered outside this process (a hand-run through the Comfy
Cloud MCP plugin, or the `file` backend's drop-and-wait round trip) get
gated; the resulting manifest's `backend` field reads `"file"`.

Exit codes: `0` ok · `1` usage · `2` config · `3` backend unreachable ·
`4` gate failed (silhouette written, or a variant was rejected) · `5` lens
failure. Errors print `error: <message>` and, where there's an actionable
next step, `hint: <what to do>` to stderr.

## Standards compliance (workflow standards, scored 0–3)

- **PIN_PER_STEP — 2.** The workflow graph, its SHA-256, the LoRA
  name/sha256/strength, and the model name all ride in every manifest,
  so a render is provenance-replayable even though local/cloud aren't
  bit-identical (design law §1). What's not pinned per-step yet: the exact
  lens model versions (`gemma4:31b`, `qwen3.6:35b-a3b`) aren't recorded in
  the manifest today. Remediation: Builder B's `gate/lenses.ts` should stamp
  its model tag into each `Verdict`, owner Builder B, next slice.
- **ANDON_AUTHORITY — 2.** A candidate that fails the style gate or a
  required question never reaches the registry; two failed rounds halt at a
  silhouette rather than let a wrong face through (design law §3). Backend
  and lens failures propagate as typed errors (`BackendUnreachableError`,
  `LensFailureError`) that stop the run rather than silently degrading.
- **NAMED_COMPENSATORS — 2.** The only external effects this package
  performs are (a) files under the registry root and (b) Comfy Cloud render
  credits spent via `--backend cloud`. Undo table:

  | Action | Undo | Owner |
  |---|---|---|
  | `canonical.png` / `variants/<kind>.png` / `manifest.json` written under `<registryRoot>/<packId>/<entityId>/` | `rm -rf <registryRoot>/<packId>/<entityId>/` (or delete just the one file — the next `ensure` call regenerates from a fresh hash) | operator running the CLI |
  | `silhouette.png` written | same — delete the entity's directory, or fix the description and re-run `ensure` (a new `descriptionHash` bypasses the cached silhouette) | operator |
  | Comfy Cloud render credits spent (`--backend cloud`, and `check --backend cloud` if it ever probes live) | not reversible — credits are consumed on submission; no refund path exists | operator (budget owner); mitigate by dry-running against `--backend local` or `--backend file` first |
  | `<outDir>/<prefix>.graph.json` written by the `file` backend | `rm <outDir>/<prefix>.graph.json` (and the matching `.png` once dropped back) | operator |

- **DECOMPOSE_BY_SECRETS — 3.** `ensure.ts` takes every external
  dependency (prompt, questions, lenses, judge, style gate, registry,
  workflow pin, backend) as an injected `EnsureDeps`/`Backend` rather than
  importing concrete modules, so the acceptance-loop logic is one seam and
  each other builder's module is a separate, independently replaceable one;
  `cli.ts` is the only file that ever imports the real modules (dynamically,
  at its composition root), and command parsing is separate again from that
  wiring. Proven by this package's own tests: 39 tests, zero GPU, zero
  network, entirely against fakes.
- **UNCERTAINTY_GATED_HUMANS — 2.** A silhouette or a rejected variant is a
  visible, exit-coded signal (`4`) that a human should look at the entity's
  description or the rendered candidates before retrying — the CLI never
  silently ships a guess. What's missing: no contrastive framing yet
  ("you probably expected X, the gate rejected because Y") — the manifest's
  `accepted.questions` array has the raw material for it. Remediation:
  a `portrait-forge report <entity>` verb summarizing *why* the gate
  rejected each candidate, owner: whoever picks up the CLI next, no session
  assigned yet.
- **EXTERNAL_VERIFIER — 2.** SigLIP2 and a local Ollama vision model are two
  separate model families, neither of which authored the workflow or the
  prompt, gating every acceptance; a required question needs both to agree.
  Not yet at 3: neither lens's reasoning trace is currently recorded in the
  manifest (only the yes/no answer + score), so a human auditing a
  disputed acceptance can't see *why* a lens answered as it did.
  Remediation: `Lens.ask` recording its rationale string alongside the
  answer, owner Builder B, next slice.

## Development

```bash
npm install
npm run verify   # typecheck + vitest, against fakes (no GPU, no network)
```

This package was built in parallel with two sibling worktrees on the same
repo (`build/a`: backends + workflow; `build/b`: prompt + gate + registry).
Until those branches merge, `src/contracts.ts` holds type-only stand-ins for
their exports (each with a `NEEDS:` comment naming the real file and what's
unconfirmed), and `src/cli.ts`'s `composeRealDeps` wires them in via dynamic
`import()` so this package typechecks today without those files existing —
that wiring is exercised only when the CLI actually runs, and is
**green expected at merge**. `src/ensure.ts`'s orchestration itself takes
every dependency as an injected argument, so it (and its 39 tests) does not
depend on the merge at all.
