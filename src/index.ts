// index.ts — public exports for programmatic use (e.g. claude-rpg's
// runtime-foundry adapter, design §6: "claude-rpg: runtime-foundry owns the
// adapter"). The CLI (src/cli.ts) is the primary consumer of everything
// exported here; this module exists so a caller can also drive
// ensurePortrait/ensureVariant/acceptCandidates directly from Node.

export {
  ensurePortrait,
  ensureVariant,
  acceptCandidates,
  defaultReslot,
  defaultEditPrompt,
  EnsureError,
  ConfigError,
  BackendUnreachableError,
  LensFailureError,
  NoCanonicalError,
  VariantRejectedError,
} from './ensure.js';
export type { EnsureDeps, EnsureOptions, AcceptOptions, EnsureResult } from './ensure.js';

export { composeRealDeps } from './cli.js';
export type { ComposedDeps } from './cli.js';

export type {
  EntityDescription,
  PromptResult,
  BuildPrompt,
  DescriptionHash,
  DeriveSeed,
  Question,
  BuildQuestions,
  BuildVariantQuestions,
  Lens,
  Candidate,
  Verdict,
  QuestionVerdict,
  LensAnswer,
  Judge,
  StyleGate,
  Backend,
  RunOpts,
  RunResult,
  CreateFileBackend,
  LoraRef,
  PinnedConstants,
  WorkflowPin,
  Manifest,
  RegistryPaths,
  RegistryOps,
} from './contracts.js';
