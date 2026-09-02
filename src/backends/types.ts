// Builder A -- src/backends/types.ts
// The shared contract every backend (local ComfyUI, Comfy Cloud, file-drop)
// implements. BUILD_SPEC.md: `Backend = { name; run(graph, opts):
// Promise<{ images: Array<{ path, filename }>; promptId; durationMs }> }`.

export type BackendName = 'local' | 'cloud' | 'file';

export interface ImageOutput {
  /** Absolute local path the image was written to. */
  path: string;
  /** The filename as reported by the backend (SaveImage's output name). */
  filename: string;
}

export interface RunOptions {
  /** Directory downloaded/produced images are written into (created if missing). */
  outDir: string;
  /** How long to wait for a result before giving up, in ms. Backend-specific default applies if omitted. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * The pinned workflow file's SHA-256 (from `pinnedWorkflow.sha256`). Only
   * `FileDropBackend` uses it (written into its `.request.json` sidecar so
   * the operator/plugin submitting the graph elsewhere can cross-check it
   * against the manifest); other backends ignore it.
   */
  workflowSha256?: string;
}

export interface RunResult {
  images: ImageOutput[];
  promptId: string;
  durationMs: number;
}

export interface UploadResult {
  filename: string;
  subfolder: string;
  type: string;
}

export interface Backend {
  readonly name: BackendName;
  /** Verify every node class a workflow needs is registered before submitting it. */
  checkReady(requiredNodeClasses: string[]): Promise<void>;
  /** Upload a local image so a workflow can reference it (e.g. the variant's canonical image). */
  uploadImage(localPath: string): Promise<UploadResult>;
  /** Submit a filled graph and return its output image(s). */
  run(graph: Record<string, unknown>, opts: RunOptions): Promise<RunResult>;
}

export interface PortraitForgeError extends Error {
  code: string;
  hint: string;
}

export function makeError(code: string, message: string, hint: string): PortraitForgeError {
  const err = new Error(message) as PortraitForgeError;
  err.code = code;
  err.hint = hint;
  return err;
}

/** Structured error codes, per BUILD_SPEC.md and the shared error convention (`error:` + `hint:`). */
export const ERROR_CODES = {
  COMFY_UNREACHABLE: 'E_COMFY_UNREACHABLE',
  COMFY_NODE_MISSING: 'E_COMFY_NODE_MISSING',
  CLOUD_KEY_MISSING: 'E_CLOUD_KEY_MISSING',
  CLOUD_UNREACHABLE: 'E_CLOUD_UNREACHABLE',
  UPLOAD_FAILED: 'E_UPLOAD_FAILED',
  GENERATION_FAILED: 'E_GENERATION_FAILED',
  GENERATION_TIMEOUT: 'E_GENERATION_TIMEOUT',
} as const;
