// Builder A -- src/workflow/pin.ts
// Load a pinned ComfyUI workflow file, fill its named slots, and expose the
// workflow's SHA-256 (over the UNFILLED file) plus the pinned constants that
// make a portrait reproducible. design B2 §1 (findings 12-21): "the workflow
// is a file"; "the workflow's SHA-256 is part of every portrait's manifest."

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** design B2 §1, finding 17: a pinned dial -- the house-style LoRA strength. */
export const STYLE_STRENGTH = 0.85;

export type SlotValue = string | number | bigint;

export interface WorkflowSlots {
  [key: string]: SlotValue;
}

export interface PinnedWorkflow {
  /** The filled ComfyUI API-format graph, ready to POST to /prompt. */
  graph: Record<string, unknown>;
  /** The raw, unfilled file contents (slots still present). */
  raw: string;
  /** SHA-256 hex digest of `raw` -- the value that belongs in the manifest. */
  sha256: string;
}

const SLOT_TOKEN = /"\{\{(\w+)\}\}"/g;
const UNFILLED_TOKEN = /\{\{\w+\}\}/;

/** Load a workflow file's raw text (slots unfilled). */
export async function loadWorkflow(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/** SHA-256 hex digest of a workflow file's raw (unfilled) contents. */
export function workflowSha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Fill every `"{{slotName}}"` token in a raw workflow file with the given
 * value, then parse the result as the ComfyUI API-format graph. A slot
 * value is spliced in unquoted (as a JSON number/bigint literal) when it is
 * a number or bigint, and JSON-string-escaped otherwise. Any slot present
 * in the file but missing from `slots`, or any placeholder left unfilled
 * after substitution, throws -- a partially-filled workflow must never be
 * submitted silently.
 */
export function fillSlots(raw: string, slots: WorkflowSlots): Record<string, unknown> {
  const filled = raw.replace(SLOT_TOKEN, (_match, key: string) => {
    if (!(key in slots)) {
      throw new Error(`portrait-forge: missing slot value for {{${key}}}`);
    }
    const value = slots[key];
    return typeof value === 'number' || typeof value === 'bigint' ? String(value) : JSON.stringify(value);
  });
  const leftover = filled.match(UNFILLED_TOKEN);
  if (leftover) {
    throw new Error(`portrait-forge: unfilled slot remains: ${leftover[0]}`);
  }
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed._meta;
  return parsed;
}

/** Load a workflow file, hash it, and fill its slots in one call. */
export async function pinWorkflow(path: string, slots: WorkflowSlots): Promise<PinnedWorkflow> {
  const raw = await loadWorkflow(path);
  const sha256 = workflowSha256(raw);
  const graph = fillSlots(raw, slots);
  return { graph, raw, sha256 };
}

export interface PortraitConstants {
  baseModel: string;
  weightDtype: string;
  clip: string;
  clipType: string;
  vae: string;
  lora: string;
  styleStrength: number;
  shift: number;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  denoise: number;
  width: number;
  height: number;
}

export interface VariantConstants {
  editModel: string;
  weightDtype: string;
  clip: string;
  clipType: string;
  vae: string;
  shift: number;
  cfgNormStrength: number;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  denoise: number;
  referenceLatentsMethod: string;
}

/**
 * The constants pinned into `workflows/qwen-sfhd.portrait.json` and
 * `workflows/qwen-edit.variant.json`, read back out as plain data so a
 * manifest writer (Builder C) never needs to re-parse the workflow file to
 * report what generated a portrait. Values mirror the JSON files exactly;
 * keep them in lockstep if either changes.
 */
export function pinnedConstants(): { portrait: PortraitConstants; variant: VariantConstants } {
  return {
    portrait: {
      baseModel: 'qwen_image_2512_fp8_e4m3fn.safetensors',
      weightDtype: 'default',
      clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      clipType: 'qwen_image',
      vae: 'qwen_image_vae.safetensors',
      lora: 'sfhd_style_v1_000001250.safetensors',
      styleStrength: STYLE_STRENGTH,
      shift: 3.1,
      sampler: 'euler',
      scheduler: 'simple',
      steps: 50,
      cfg: 4.0,
      denoise: 1.0,
      width: 832,
      height: 1216,
    },
    variant: {
      editModel: 'qwen_image_edit_2511_fp8mixed.safetensors',
      weightDtype: 'default',
      clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      clipType: 'qwen_image',
      vae: 'qwen_image_vae.safetensors',
      shift: 3.1,
      cfgNormStrength: 1.0,
      sampler: 'euler',
      scheduler: 'simple',
      steps: 40,
      cfg: 4.0,
      denoise: 1.0,
      referenceLatentsMethod: 'index_timestep_zero',
    },
  };
}
