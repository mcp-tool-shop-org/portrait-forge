// contracts.ts — TYPE-ONLY declarations of the other builders' module surfaces,
// worded exactly as BUILD_SPEC.md states them. Builder C (this worktree) codes
// against these so `src/ensure.ts` and `src/cli.ts` compile and are testable
// with fakes before Builder A (backends + workflow) and Builder B (prompt +
// gate + registry) land. Every declaration below carries a `NEEDS:` comment
// naming the real file that must export it; at merge, delete this file's
// declaration and import the real one instead (or re-export it here).
//
// design law: E:/AI/claude-rpg/docs/living-world-slice-b2.md

// ---------------------------------------------------------------------------
// Builder B — src/prompt/slots.ts (design §1)
// ---------------------------------------------------------------------------

/** NEEDS: src/prompt/slots.ts: export type EntityDescription (verbatim per spec). */
export type EntityDescription = {
  id: string;
  name: string;
  kind: 'npc' | 'monster' | 'petitioner' | 'player';
  species?: string;
  bodyClass?: string;
  age?: string;
  face?: string;
  hair?: string;
  garb?: string;
  mood?: string;
  palette?: string;
  tags: string[];
  faction?: string;
  packId: string;
  shapeTilt?: 'rounded' | 'balanced' | 'angular' | 'jagged' | 'asymmetric' | 'broken';
};

/** NEEDS: src/prompt/slots.ts: export function buildPrompt(desc): PromptResult.
 *  The spec's `buildPrompt(desc)` does not take a round/reslot argument; the
 *  second-round re-slot (drop palette, widen shot — design §3) is spec'd as
 *  ensure.ts's job ("second round with a re-slotted prompt"), so this
 *  contract adds an optional `reslot` flag Builder C's orchestrator passes.
 *  NEEDS: confirm with Builder B whether buildPrompt itself should own the
 *  reslot transform, or whether ensure.ts should mutate `desc` before calling
 *  the unchanged buildPrompt(desc) — this file assumes the latter is safer
 *  (buildPrompt stays a pure function of desc) and ensure.ts constructs a
 *  reslotted EntityDescription copy instead of passing a second argument.
 */
export type PromptResult = {
  positive: string;
  negative: string;
  slots: Record<string, string>;
};
export type BuildPrompt = (desc: EntityDescription) => PromptResult;

/** NEEDS: src/prompt/slots.ts: export function descriptionHash(desc): string
 *  — SHA-256 hex of the canonical JSON of the slots that affect the image. */
export type DescriptionHash = (desc: EntityDescription) => string;

/** NEEDS: src/prompt/slots.ts: export function deriveSeed(packId, entityId,
 *  descriptionHash): number — first 8 bytes of SHA-256 as an unsigned int. */
export type DeriveSeed = (packId: string, entityId: string, descriptionHash: string) => number;

// ---------------------------------------------------------------------------
// Builder B — src/gate/questions.ts (design §3)
// ---------------------------------------------------------------------------

/** NEEDS: src/gate/questions.ts: export type Question (verbatim per spec). */
export type Question = {
  id: string;
  text: string;
  expected: 'yes' | 'no';
  required: boolean;
  kind: 'species' | 'sex' | 'age' | 'hair' | 'garment' | 'prop' | 'mood' | 'distractor';
};

/** NEEDS: src/gate/questions.ts: export function buildQuestions(desc): Question[]
 *  — fixed count (8), balanced polarity (>= 2 expected 'no'), no negation. */
export type BuildQuestions = (desc: EntityDescription) => Question[];

/** NEEDS: src/gate/questions.ts (or a new file): export function
 *  buildVariantQuestions(desc, kind): Question[]. The spec's ensureVariant
 *  line reads "sameness check (both lenses) + the variant's own questions" —
 *  BUILD_SPEC.md never names the function that produces a variant's own
 *  question set (only buildQuestions(desc) is specified, which has no `kind`
 *  parameter and cannot ask "is this the wounded variant"). This contract
 *  assumes a sibling function with a `kind` parameter exists; NEEDS: Builder
 *  B to confirm the name/shape, or state that ensureVariant should instead
 *  reuse buildQuestions(desc) unmodified and rely on sameness alone for the
 *  kind-specific check (spec text argues against that reading, since it
 *  calls out "the variant's own questions" as distinct from sameness). */
export type BuildVariantQuestions = (desc: EntityDescription, kind: string) => Question[];

// ---------------------------------------------------------------------------
// Builder B — src/gate/lenses.ts
// ---------------------------------------------------------------------------

/** NEEDS: src/gate/lenses.ts: export type Lens (verbatim per spec). */
export type Lens = {
  name: string;
  family: 'siglip' | 'ollama';
  ask(imagePath: string, q: Question): Promise<{ answer: 'yes' | 'no'; score?: number }>;
  same(imageA: string, imageB: string): Promise<{ same: boolean; score?: number }>;
};

// ---------------------------------------------------------------------------
// Builder B — src/gate/accept.ts (design §3)
// ---------------------------------------------------------------------------

/** One rendered candidate awaiting judgment. Not spec'd by name in
 *  BUILD_SPEC.md; ensure.ts needs a handle per generated image to carry it
 *  through style-gate -> judge -> accept. NEEDS: confirm this shape (or an
 *  equivalent) is what judge()'s `candidates` parameter expects. */
export type Candidate = {
  index: number;
  seed: number;
  imagePath: string;
};

/** NEEDS: src/gate/accept.ts: export function judge(candidates, questions,
 *  lenses): Promise<Verdict[]>. The spec states judge's *behavior* precisely
 *  (a required question passes only if BOTH lenses agree with `expected`;
 *  rank by passed count; ties broken by the Ollama lens's pairwise call) but
 *  not Verdict's field names. This contract's Verdict is Builder C's best
 *  reconstruction from that behavior description; NEEDS: Builder B to
 *  confirm field names so ensure.ts's manifest-writing code (which reads
 *  `verdict.candidate`, `verdict.requiredPassed`, `verdict.answers`) lines up
 *  without an adapter. */
export type LensAnswer = { lens: string; answer: 'yes' | 'no'; score?: number };
export type QuestionVerdict = { question: Question; lensAnswers: LensAnswer[] };
export type Verdict = {
  candidate: Candidate;
  passedCount: number;
  /** true iff every required question passed (both lenses agreeing) — the
   *  spec's accept condition ("the best candidate with every required
   *  question passed, else null"). */
  requiredPassed: boolean;
  answers: QuestionVerdict[];
};
export type Judge = (candidates: Candidate[], questions: Question[], lenses: Lens[]) => Promise<Verdict[]>;

/** NEEDS: src/gate/accept.ts: export function styleGate(imagePath,
 *  referencePlates): Promise<{ pass: boolean; score: number }> — the spec
 *  names styleGate and its two args and its behavior (threshold constant;
 *  below it the candidate is rejected as off-look) but not its return shape.
 *  This contract's `{ pass, score }` is Builder C's best guess; NEEDS:
 *  Builder B to confirm (ensure.ts reads both fields for the manifest's
 *  `accepted.styleScore`). */
export type StyleGate = (imagePath: string, referencePlates: string[]) => Promise<{ pass: boolean; score: number }>;

// ---------------------------------------------------------------------------
// Builder A — src/backends/types.ts
// ---------------------------------------------------------------------------

/** NEEDS: src/backends/types.ts: export type Backend. Widened per the
 *  coordinator's mid-build addition beyond BUILD_SPEC.md's original 'local'
 *  | 'cloud': a third 'file' backend (`src/backends/file.ts`) drops the
 *  filled graph as `<outDir>/<prefix>.graph.json` and waits for
 *  `<outDir>/<prefix>.png` to appear, so an operator can run the graph
 *  through the Comfy Cloud MCP plugin by hand and drop the output back. */
export type Backend = {
  name: 'local' | 'cloud' | 'file';
  run(graph: unknown, opts: RunOpts): Promise<RunResult>;
};

/** The spec gives Backend.run(graph, opts) but never spells out `opts`'s
 *  shape. ensure.ts needs to pass a seed and an output filename prefix per
 *  candidate (design §1: SaveImage's "filename prefix injected"; §2: "seed
 *  injected"). NEEDS: Builder A to confirm RunOpts's real field names —
 *  this contract's `seed` / `prefix` are Builder C's best guess from the
 *  workflow description in BUILD_SPEC.md's rig-facts section. `outDir` /
 *  `waitMs` are this session's addition for the 'file' backend's CLI flags
 *  (`--out <dir>`, `--wait-ms <n>`) — NEEDS: Builder A confirm whether
 *  src/backends/file.ts reads these per-call (as here) or only at
 *  construction time (this contract's cli.ts passes both, to cover either
 *  choice). */
export type RunOpts = {
  seed: number;
  prefix: string;
  outDir?: string;
  waitMs?: number;
};

/** NEEDS: src/backends/file.ts: export function createFileBackend(opts: {
 *  outDir: string; waitMs?: number }): Backend — Builder C's assumed factory
 *  name for cli.ts's composition root (see cli.ts's `composeRealDeps`,
 *  which imports this dynamically and duck-types the export rather than
 *  hard-binding to this exact signature, precisely because the name is
 *  unconfirmed). Confirm at merge or adapt the one call site. */
export type CreateFileBackend = (opts: { outDir: string; waitMs?: number }) => Backend;
export type RunResult = {
  images: Array<{ path: string; filename: string }>;
  promptId: string;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Builder A — src/workflow/pin.ts
// ---------------------------------------------------------------------------

/** One LoRA entry as it appears in a manifest (design §5). */
export type LoraRef = { name: string; sha256: string; strength: number };

/** NEEDS: src/workflow/pin.ts: export function pinnedConstants(): PinnedConstants
 *  (model names, LoRA + strength, sampler, scheduler, steps, cfg, size — per
 *  spec's exact list). This contract adds `sha256` per-LoRA since the
 *  manifest wants it (design §5 `loras: [{ name, sha256, strength }]`) but
 *  the spec's prose list for pinnedConstants() only says "LoRA + strength" —
 *  NEEDS: Builder A confirm pinnedConstants() returns the LoRA sha256 too, or
 *  ensure.ts must compute/carry it from elsewhere. */
export type PinnedConstants = {
  models: string[];
  loras: LoraRef[];
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  size: [number, number];
};

/** NEEDS: src/workflow/pin.ts: exports to load a workflow file, fill its
 *  named slots ({{seed}}, {{positive}}, {{negative}}, {{prefix}},
 *  {{canonical_image}}, {{edit_prompt}}), and expose the workflow's own
 *  SHA-256 (computed over the UNFILLED file) plus pinnedConstants(). The
 *  spec names these as free functions in pin.ts, not a class; this contract
 *  groups them as `WorkflowPin` purely so ensure.ts has one injectable
 *  object in tests — NEEDS: Builder A confirm whether pin.ts's real exports
 *  are free functions (`loadWorkflow`, `fillSlots`, `workflowSha256`,
 *  `pinnedConstants`) that cli.ts should wrap into this shape itself, rather
 *  than pin.ts exporting the shape directly. */
export type WorkflowPin = {
  /** SHA-256 of the unfilled workflow file. */
  sha256: string;
  pinnedConstants(): PinnedConstants;
  /** Fill the named slots and return the runnable graph for Backend.run(). */
  fillSlots(slots: Record<string, string>): unknown;
};

// ---------------------------------------------------------------------------
// Builder B — src/registry/registry.ts (design §5)
// ---------------------------------------------------------------------------

/** Manifest content exactly as design §5 lists it. */
export type Manifest = {
  descriptionHash: string;
  prompt: PromptResult;
  seed: number;
  workflowId: string;
  workflowSha256: string;
  loras: LoraRef[];
  /** design §5 says 'local' | 'cloud' verbatim; widened to include 'file'
   *  for the coordinator's mid-build 'file' backend and the `accept` verb's
   *  externally-produced candidates (see contracts.ts's Backend type). */
  backend: 'local' | 'cloud' | 'file';
  model: string;
  accepted: {
    questions: Array<{ q: string; expected: 'yes' | 'no'; answer: 'yes' | 'no' }>;
    styleScore: number;
  };
  /** variant kind -> identity score. */
  identity: Record<string, number>;
  /** Not in design §5's literal field list, but BUILD_SPEC.md's registry
   *  bullet requires "silhouette.png written ... (status: 'silhouette')" —
   *  NEEDS: Builder B confirm this lives on Manifest (as here) vs. a
   *  sibling file. */
  status: 'accepted' | 'silhouette';
};

/** NEEDS: src/registry/registry.ts: the spec describes registry layout and
 *  `ensure()` semantics in prose but never names registry.ts's actual
 *  exported functions. This contract is Builder C's reconstruction of the
 *  minimum operations ensure.ts needs; NEEDS: Builder B confirm real names —
 *  ideally registry.ts exports exactly this shape (or cli.ts/ensure.ts gets
 *  a thin adapter at merge). */
export type RegistryPaths = {
  canonical: string;
  variantsDir: string;
  manifest: string;
  silhouette: string;
};
export type RegistryOps = {
  paths(root: string, packId: string, entityId: string): RegistryPaths;
  readManifest(root: string, packId: string, entityId: string): Promise<Manifest | null>;
  /** `sourcePath` is a temp file the backend wrote; registry copies/moves it
   *  to `canonical.png` and returns the final path. */
  writeCanonical(root: string, packId: string, entityId: string, sourcePath: string): Promise<string>;
  writeVariant(root: string, packId: string, entityId: string, kind: string, sourcePath: string): Promise<string>;
  writeManifest(root: string, packId: string, entityId: string, manifest: Manifest): Promise<string>;
  /** Writes the bundled placeholder silhouette and returns its path. */
  writeSilhouette(root: string, packId: string, entityId: string): Promise<string>;
};
