// Builder A -- test/backends/pin.test.ts
// Slot filling and SHA-256 stability for src/workflow/pin.ts.
// design B2 §1: "the workflow's SHA-256 is part of every portrait's
// manifest" -- the hash must be over the unfilled file, stable across
// different slot fills, and slot filling must never leave a token unfilled.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow, workflowSha256, fillSlots, pinWorkflow, pinnedConstants, STYLE_STRENGTH } from '../../src/workflow/pin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.join(here, '..', '..', 'workflows');
const portraitPath = path.join(workflowsDir, 'qwen-sfhd.portrait.json');
const variantPath = path.join(workflowsDir, 'qwen-edit.variant.json');

describe('pin.ts: portrait workflow slot filling', () => {
  it('fills every named slot with the supplied value', async () => {
    const raw = await loadWorkflow(portraitPath);
    const graph = fillSlots(raw, {
      seed: 4242,
      positive: 'sfhd style, a priest character concept',
      negative: 'blurry, low quality',
      prefix: 'portrait-test',
    });
    expect((graph['11'] as any).inputs.seed).toBe(4242);
    expect((graph['8'] as any).inputs.text).toBe('sfhd style, a priest character concept');
    expect((graph['9'] as any).inputs.text).toBe('blurry, low quality');
    expect((graph['13'] as any).inputs.filename_prefix).toBe('portrait-test');
  });

  it('strips the _meta block from the filled graph', async () => {
    const raw = await loadWorkflow(portraitPath);
    const graph = fillSlots(raw, { seed: 1, positive: 'x', negative: 'y', prefix: 'p' });
    expect(graph._meta).toBeUndefined();
  });

  it('leaves non-slot node graph structure (model/lora/size pins) untouched', async () => {
    const raw = await loadWorkflow(portraitPath);
    const graph = fillSlots(raw, { seed: 1, positive: 'x', negative: 'y', prefix: 'p' });
    expect((graph['3'] as any).inputs.unet_name).toBe('qwen_image_2512_fp8_e4m3fn.safetensors');
    expect((graph['6'] as any).inputs.lora_name).toBe('sfhd_style_v1_000001250.safetensors');
    expect((graph['6'] as any).inputs.strength_model).toBe(STYLE_STRENGTH);
    expect((graph['10'] as any).inputs.width).toBe(832);
    expect((graph['10'] as any).inputs.height).toBe(1216);
  });

  it('throws naming the missing slot when a value is not supplied', async () => {
    const raw = await loadWorkflow(portraitPath);
    expect(() => fillSlots(raw, { seed: 1, positive: 'x', negative: 'y' } as any)).toThrow(/prefix/);
  });

  it('a changed slot value changes only the graph fields it fills', async () => {
    const raw = await loadWorkflow(portraitPath);
    const a = fillSlots(raw, { seed: 1, positive: 'x', negative: 'neg', prefix: 'p' });
    const b = fillSlots(raw, { seed: 1, positive: 'CHANGED', negative: 'neg', prefix: 'p' });
    expect((b['8'] as any).inputs.text).toBe('CHANGED');
    // Everything else in the graph is identical.
    const aCopy = JSON.parse(JSON.stringify(a));
    const bCopy = JSON.parse(JSON.stringify(b));
    aCopy['8'].inputs.text = 'CHANGED';
    expect(bCopy).toEqual(aCopy);
  });
});

describe('pin.ts: variant workflow slot filling', () => {
  it('fills the canonical image, edit prompt, seed, and prefix slots', async () => {
    const raw = await loadWorkflow(variantPath);
    const graph = fillSlots(raw, {
      canonical_image: 'canonical.png',
      edit_prompt: 'the same character, wounded, a cut across the brow',
      seed: 4242,
      prefix: 'variant-test',
    });
    expect((graph['20'] as any).inputs.image).toBe('canonical.png');
    expect((graph['27'] as any).inputs.prompt).toBe('the same character, wounded, a cut across the brow');
    expect((graph['32'] as any).inputs.seed).toBe(4242);
    expect((graph['34'] as any).inputs.filename_prefix).toBe('variant-test');
  });

  it('negative branch always encodes an empty prompt, never the edit prompt', async () => {
    const raw = await loadWorkflow(variantPath);
    const graph = fillSlots(raw, {
      canonical_image: 'canonical.png',
      edit_prompt: 'wounded',
      seed: 1,
      prefix: 'p',
    });
    expect((graph['28'] as any).inputs.prompt).toBe('');
  });
});

describe('pin.ts: SHA-256', () => {
  it('is stable across repeated calls on the same raw text', async () => {
    const raw = await loadWorkflow(portraitPath);
    expect(workflowSha256(raw)).toBe(workflowSha256(raw));
  });

  it('is a 64-char hex digest', async () => {
    const raw = await loadWorkflow(portraitPath);
    expect(workflowSha256(raw)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change when slot fill values differ (hash is over the unfilled file)', async () => {
    const pinnedA = await pinWorkflow(portraitPath, { seed: 1, positive: 'a', negative: 'b', prefix: 'p1' });
    const pinnedB = await pinWorkflow(portraitPath, { seed: 999, positive: 'totally different', negative: 'd', prefix: 'p2' });
    expect(pinnedA.sha256).toBe(pinnedB.sha256);
  });

  it('differs between the two workflow files', async () => {
    const portrait = await pinWorkflow(portraitPath, { seed: 1, positive: 'a', negative: 'b', prefix: 'p' });
    const variant = await pinWorkflow(variantPath, { canonical_image: 'c.png', edit_prompt: 'e', seed: 1, prefix: 'p' });
    expect(portrait.sha256).not.toBe(variant.sha256);
  });
});

describe('pin.ts: pinnedConstants()', () => {
  it('reports the constants baked into the portrait workflow file', () => {
    const constants = pinnedConstants();
    expect(constants.portrait.baseModel).toBe('qwen_image_2512_fp8_e4m3fn.safetensors');
    expect(constants.portrait.lora).toBe('sfhd_style_v1_000001250.safetensors');
    expect(constants.portrait.styleStrength).toBe(STYLE_STRENGTH);
    expect(constants.portrait.sampler).toBe('euler');
    expect(constants.portrait.scheduler).toBe('simple');
    expect(constants.portrait.steps).toBe(50);
    expect(constants.portrait.cfg).toBe(4.0);
    expect(constants.portrait.denoise).toBe(1.0);
    expect(constants.portrait.width).toBe(832);
    expect(constants.portrait.height).toBe(1216);
  });

  it('reports the constants baked into the variant workflow file', () => {
    const constants = pinnedConstants();
    expect(constants.variant.editModel).toBe('qwen_image_edit_2511_fp8mixed.safetensors');
    expect(constants.variant.steps).toBe(40);
    expect(constants.variant.cfg).toBe(4.0);
    expect(constants.variant.referenceLatentsMethod).toBe('index_timestep_zero');
  });
});
