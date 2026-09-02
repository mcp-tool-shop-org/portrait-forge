# portrait-forge — build spec (v0.1.0, private)

Law for the builders: `E:/AI/claude-rpg/docs/living-world-slice-b2.md` (the
Director-ratified design; cite its findings by number in code comments where a
rule lives) and this file (the module contract). Three builders, exclusive
file ownership, TypeScript ESM, Node ≥ 20, no runtime dependencies beyond
Node built-ins (fetch, child_process, fs). Vitest for tests; every module
tested against fakes (no GPU in tests). `npm run verify` = typecheck + tests.

## Rig facts (measured 2026-09-01; builders re-verify against the live server)

- Local ComfyUI 0.23.0 at `http://127.0.0.1:8188` (portable; started with
  `--disable-smart-memory`). Models present: `qwen_image_2512_bf16.safetensors`
  (and fp8), `qwen_image_edit_2511_fp8mixed.safetensors` (diffusion_models);
  `qwen_2.5_vl_7b_fp8_scaled.safetensors` (text_encoders); `qwen_image_vae.
  safetensors` (vae); `sfhd_style_v1_000001250.safetensors` (loras). Confirm
  exact node input names via `GET /object_info` — never hard-code a node
  input you did not read from it.
- Verifier lenses: (a) SigLIP2 via `ai-eyes-mcp` (Python, `E:/AI/ai-eyes-mcp`,
  `src/ai_eyes_mcp/engine.py` + `server.py` functions `image_contains`,
  `image_verify` (target vs alternatives → relative verdict), `image_compare`,
  `image_rank`); (b) a local vision LLM on Ollama (`gemma4:31b`, `qwen3.6:35b-a3b`
  both report the `vision` capability) via `POST /api/chat` with base64
  `images`, `keep_alive: 0`.
- Comfy Cloud: the same API-format graph; auth by an API key the operator
  supplies in `COMFY_CLOUD_API_KEY` (never in a file). Endpoint shape from
  the official docs at build time; if the docs are unreachable, implement
  the adapter against the documented ComfyUI HTTP shape (`POST /prompt`,
  `GET /history/{id}`, `GET /view`) behind a base URL and mark it
  "unverified live" in the README until a key exists.

## Modules and ownership

### Builder A — backends + workflow (`src/backends/**`, `src/workflow/**`, `workflows/**`)
- `workflows/qwen-sfhd.portrait.json`: the ONE pinned API-format graph:
  UNETLoader(qwen_image_2512_bf16) → LoraLoaderModelOnly(sfhd, strength
  `STYLE_STRENGTH` constant) → ModelSamplingAuraFlow (the Qwen shift the
  templates use) → CLIPLoader(qwen_2.5_vl_7b, type qwen_image) → CLIPTextEncode
  (positive / negative) → EmptySD3LatentImage 832×1216 → KSampler (fixed
  sampler, scheduler, steps, cfg, denoise 1.0; seed injected) → VAEDecode →
  SaveImage (filename prefix injected). Plus `workflows/qwen-edit.variant.json`
  for variants: LoadImage(canonical) + the Qwen-Image-Edit 2511 text-encode
  node the server exposes (`TextEncodeQwenImageEditPlus` or its sibling —
  read /object_info) with the edit prompt. Every placeholder is a named
  slot (`{{seed}}`, `{{positive}}`, `{{negative}}`, `{{prefix}}`,
  `{{canonical_image}}`, `{{edit_prompt}}`).
- `src/workflow/pin.ts`: load a workflow file, fill slots, compute the
  workflow's SHA-256 over the unfilled file, expose `pinnedConstants()`
  (model names, LoRA + strength, sampler, scheduler, steps, cfg, size).
- `src/backends/types.ts`: `Backend = { name: 'local' | 'cloud'; run(graph,
  opts): Promise<{ images: Array<{ path, filename }>; promptId; durationMs }> }`.
- `src/backends/local.ts`: ComfyUI HTTP — `POST /prompt`, poll `GET
  /history/{prompt_id}` until outputs, download via `GET /view?filename=&
  subfolder=&type=output` into the caller's directory; upload the canonical
  for variants via `POST /upload/image`. Timeouts, retries with backoff,
  structured errors (`E_COMFY_UNREACHABLE`, `E_COMFY_NODE_MISSING` when
  /object_info lacks a required node — checked once at startup).
- `src/backends/cloud.ts`: same contract against Comfy Cloud with
  `COMFY_CLOUD_API_KEY`; LoRA upload once if the API supports it (document
  what it does and does not support); `E_CLOUD_KEY_MISSING` when unset.
- Tests: a fake ComfyUI HTTP server (node:http) that records the posted
  graph, returns a history with one output, and serves a PNG; assert slot
  filling, the SHA-256, node presence check, and the download path.

### Builder B — prompter + gate + registry (`src/prompt/**`, `src/gate/**`, `src/registry/**`)
- `src/prompt/slots.ts` (design §1): `EntityDescription = { id, name, kind:
  'npc' | 'monster' | 'petitioner' | 'player', species?, bodyClass?, age?,
  face?, hair?, garb?, mood?, palette?, tags: string[], faction?, packId,
  shapeTilt?: 'rounded' | 'balanced' | 'angular' | 'jagged' | 'asymmetric' |
  'broken' }`; `buildPrompt(desc): { positive, negative, slots }` with FROZEN
  connective wording and slot order `[style token] [species/body class]
  [age] [face] [hair/head] [garb] [mood] [palette accent] [shot]`; the
  style token is the LoRA's trigger word (read it from the training config:
  `E:/AI/training/output/sfhd_style_v1/config.yaml` — cite it); shot = bust
  for minor, three-quarter for major (`desc.kind === 'monster' || major`).
  `descriptionHash(desc)` = SHA-256 of the canonical JSON of the slots that
  affect the image. `deriveSeed(packId, entityId, descriptionHash)` = first
  8 bytes of SHA-256 as an unsigned int (fits ComfyUI's seed).
- `src/gate/questions.ts` (design §3): `buildQuestions(desc): Question[]` — a
  FIXED count of 8 atomic, positively phrased checks with balanced polarity
  (at least 2 whose expected answer is "no", drawn from a distractor list
  that never overlaps the description: wrong species, wrong signature
  garment, wrong prop); each `{ id, text, expected: 'yes' | 'no', required:
  boolean, kind: 'species' | 'sex' | 'age' | 'hair' | 'garment' | 'prop' |
  'mood' | 'distractor' }`. Negation never appears in `text` (finding 30).
- `src/gate/lenses.ts`: two lenses behind one interface `Lens = { name:
  string; family: 'siglip' | 'ollama'; ask(imagePath, q): Promise<{ answer:
  'yes' | 'no'; score?: number }>; same(imageA, imageB): Promise<{ same:
  boolean; score?: number }> }`. `siglipLens` shells out to a small Python
  helper `scripts/siglip_lens.py` (uses ai-eyes' engine: image_verify with
  the question's positive target vs its distractor alternatives; image_compare
  for sameness); `ollamaLens` posts to `/api/chat` with the image and a
  strict yes/no JSON instruction (`keep_alive: 0`). Both injectable for
  tests.
- `src/gate/accept.ts` (design §3): `judge(candidates, questions, lenses):
  Verdict[]` — per candidate, every question through every lens; a required
  question passes only if BOTH lenses agree with `expected`; rank by passed
  count; ties broken by the Ollama lens's pairwise "which better matches this
  description" (finding 28); `accept` = the best candidate with every
  required question passed, else `null`. Never any aesthetic score.
  `styleGate(imagePath, referencePlates)`: SigLIP `image_compare` against
  the reference plates (`references/sfhd/*.png` — copy 4 samples from
  `E:/AI/training/output/sfhd_style_v1/samples/`) with a threshold constant;
  a candidate below it is rejected as off-look.
- `src/registry/registry.ts` (design §5): `<root>/<packId>/<entityId>/
  canonical.png`, `variants/<kind>.png`, `manifest.json` exactly as the
  design lists; `ensure()` semantics: regenerate only when
  `descriptionHash` differs from the manifest; `silhouette.png` written from
  a bundled placeholder when the gate fails twice (`status: 'silhouette'`).
- Tests: prompt determinism (same desc → same prompt/seed/hash; a changed
  slot changes only that slot), question count and polarity invariants (no
  negation, ≥ 2 expected-no, 8 total), the judge with fake lenses (a
  candidate failing a required question is rejected; ties go to the
  pairwise call; no aesthetic input exists), registry idempotence.

### Builder C — orchestration + CLI + docs (`src/ensure.ts`, `src/cli.ts`, `src/index.ts`, `README.md`, `package.json`, configs)
- `ensurePortrait(desc, { backend, registryRoot, lenses, workflowDir, N = 3,
  rounds = 2 })`: registry check → prompt → N candidates (seed, seed+1,
  seed+2) through the backend → style gate → judge → accept → write
  canonical + manifest (with workflow SHA-256, LoRA name/sha256/strength,
  backend, model, the questions with expected/answers per lens, style
  score) → else second round with a re-slotted prompt (drop the palette
  slot, widen the shot) → else silhouette. `ensureVariant(desc, kind)`: edit
  from canonical through the variant workflow, sameness check (both lenses)
  + the variant's own questions, write `variants/<kind>.png` + manifest
  entry.
- CLI: `portrait-forge ensure --entity <json|-> --backend local|cloud
  [--registry <dir>] [--n 3]`, `portrait-forge variant --entity <json>
  --kind wounded`, `portrait-forge check --backend local` (object_info +
  models + lenses reachable), `portrait-forge cast --file <json array>`
  (batch). Exit codes 0 ok / 1 usage / 2 config / 3 backend unreachable /
  4 gate failed (silhouette written) / 5 lens failure. Errors print `error:`
  + `hint:`.
- README: what it is, the workflow pinning rule, the two backends, the
  gate, the registry, exit codes, and a **Standards compliance** section
  (six standards scored 0–3 with evidence; compensators: the only external
  effects are files under the registry root and cloud credits — name the
  undo).
- `package.json` (`@mcptoolshop/portrait-forge`, private, bin `portrait-forge`),
  `tsconfig.json`, `vitest.config.ts` (mirror `E:/AI/ai-playtest`'s).
- Tests: `ensure` end-to-end with a fake backend that returns fixture PNGs
  and fake lenses; the silhouette path; the variant path; CLI exit codes.

## Shared rules

- Every load-bearing rule cites the design finding in a comment (`// design
  §3, finding 26: balanced polarity`).
- No secrets in files; `COMFY_CLOUD_API_KEY` and `OLLAMA_HOST` from env.
- Commit on your own branch `build/<a|b|c>` with conventional messages; do
  not push; do not touch another builder's files; if you need a change in
  another builder's module, write it in your final report as
  `NEEDS: <file>: <what>` and code against the contract above.
- Report at the end: files, tests (count, green), the exact node names and
  model filenames you read from /object_info, anything in this spec that
  was wrong against the rig, and every `NEEDS:` line.
