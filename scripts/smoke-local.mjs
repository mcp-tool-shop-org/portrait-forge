// Builder A -- one-off smoke script (not part of the package surface).
// Submits the pinned portrait workflow, then the variant workflow using the
// portrait as canonical, against the live local ComfyUI server. Run with:
//   node scripts/smoke-local.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinWorkflow } from '../dist/workflow/pin.js';
import { LocalComfyBackend } from '../dist/backends/local.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const workflowsDir = path.join(root, 'workflows');
const smokeDir = path.join(root, '_smoke');

const REQUIRED_PORTRAIT_CLASSES = [
  'UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoaderModelOnly', 'CLIPTextEncode',
  'ModelSamplingAuraFlow', 'KSampler', 'EmptySD3LatentImage', 'VAEDecode', 'SaveImage',
];
const REQUIRED_VARIANT_CLASSES = [
  'LoadImage', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow', 'CFGNorm',
  'FluxKontextImageScale', 'TextEncodeQwenImageEditPlus', 'FluxKontextMultiReferenceLatentMethod',
  'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage',
];

const backend = new LocalComfyBackend();

async function main() {
  console.log('== checkReady (portrait) ==');
  await backend.checkReady(REQUIRED_PORTRAIT_CLASSES);
  console.log('OK -- all portrait node classes present');

  console.log('== checkReady (variant) ==');
  await backend.checkReady(REQUIRED_VARIANT_CLASSES);
  console.log('OK -- all variant node classes present');

  console.log('== portrait smoke ==');
  const portraitPinned = await pinWorkflow(path.join(workflowsDir, 'qwen-sfhd.portrait.json'), {
    seed: 4242,
    positive: 'sfhd style, a suspicious pilgrim character concept, a wary hooded traveler in a dust-worn brown cloak clutching a wooden staff, wary watchful mood, plain pale background, bust shot',
    negative: 'low resolution, low quality, deformed limbs, deformed fingers, oversaturated, waxy skin, no facial detail, over-smoothed, ai look, chaotic composition, blurry text, distorted text',
    prefix: 'portrait-smoke',
  });
  const portraitStart = Date.now();
  const portraitResult = await backend.run(portraitPinned.graph, { outDir: smokeDir });
  const portraitMs = Date.now() - portraitStart;
  console.log(`portrait OK: ${portraitResult.images[0].path} (${portraitMs}ms, promptId=${portraitResult.promptId})`);

  console.log('== upload canonical for variant ==');
  const uploaded = await backend.uploadImage(portraitResult.images[0].path);
  console.log(`uploaded as ${uploaded.filename}`);

  console.log('== variant smoke ==');
  const variantPinned = await pinWorkflow(path.join(workflowsDir, 'qwen-edit.variant.json'), {
    canonical_image: uploaded.filename,
    edit_prompt: 'the same character, wounded, a cut across the brow',
    seed: 4242,
    prefix: 'variant-smoke',
  });
  const variantStart = Date.now();
  const variantResult = await backend.run(variantPinned.graph, { outDir: smokeDir, timeoutMs: 15 * 60 * 1000 });
  const variantMs = Date.now() - variantStart;
  console.log(`variant OK: ${variantResult.images[0].path} (${variantMs}ms, promptId=${variantResult.promptId})`);

  console.log('\n=== SUMMARY ===');
  console.log(`portrait: ${portraitMs}ms -> ${portraitResult.images[0].path}`);
  console.log(`variant:  ${variantMs}ms -> ${variantResult.images[0].path}`);
}

main().catch((err) => {
  console.error('SMOKE FAILED');
  console.error('code:', err.code);
  console.error('message:', err.message);
  console.error('hint:', err.hint);
  process.exit(1);
});
