// Prompt slot template (design law §1, findings 12-21).
//
// The prompt is a slot template with FROZEN wording (finding 21): only the
// fillers vary, never the connective text or the slot order. Fillers come
// from the engine's entity description, its tags, its faction, and the
// pack's shape-language tilt (the sprite-foundry HD art-direction bible
// §3) -- never from the narrator's prose (design law §1).
import { createHash } from 'node:crypto';

export type EntityKind = 'npc' | 'monster' | 'petitioner' | 'player';

// design law §3: "the pack's shape-language tilt (the bible §3)."
export type ShapeTilt =
  | 'rounded'
  | 'balanced'
  | 'angular'
  | 'jagged'
  | 'asymmetric'
  | 'broken';

export interface EntityDescription {
  id: string;
  name: string;
  kind: EntityKind;
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
  shapeTilt?: ShapeTilt;
  // BUILD_SPEC.md Builder B, src/prompt/slots.ts: shot = bust for minor,
  // three-quarter for major (`desc.kind === 'monster' || major`).
  major?: boolean;
  /**
   * Director ruling 2026-09-02: descriptions come from prompt-craft
   * contracts (typed, depictable, individually checkable atoms), never
   * hand-written prose. When present, the contract's atoms ARE the content:
   * every expected-yes atom joins the positive prompt in contract order,
   * every expected-no atom joins the negative prompt, and the gate asks one
   * question per atom (src/gate/questions.ts). The slot fields above are
   * then ignored; the style token and the shot stay this tool's.
   */
  contract?: ContractSpec;
}

/** One prompt-craft atom as this tool consumes it (must_have -> 'yes', must_not -> 'no'). */
export interface ContractAtom {
  id: string;
  claim: string;
  expected: 'yes' | 'no';
  /** prompt-craft severity 'required' -> true; 'optional' -> false. */
  required: boolean;
}

export interface ContractSpec {
  /** The prompt-craft contract id, e.g. `char:pilgrim`. */
  id: string;
  /** Resolved atoms, faction-inherited ones first (prompt-craft's own resolution order). */
  atoms: ContractAtom[];
  /** Optional provenance: the prompt `pcraft synth` produced for the same contract. */
  pcraftPrompt?: string;
}

export interface SlotValues {
  styleToken: string;
  speciesBodyClass: string;
  age: string;
  face: string;
  hairHead: string;
  garb: string;
  mood: string;
  paletteAccent: string;
  shot: string;
}

export interface BuiltPrompt {
  positive: string;
  negative: string;
  slots: SlotValues;
}

// The LoRA trigger phrase, read verbatim from the training config's sample
// prompts -- every one of them opens "sfhd style, ..."
// (E:/AI/training/output/sfhd_style_v1/config.yaml, `sample.prompts`, all
// six entries; cited per BUILD_SPEC.md Builder B, src/prompt/slots.ts).
export const STYLE_TOKEN = 'sfhd style';

// Frozen negative prompt (design law §1, finding 21: "only fillers vary" --
// the negative prompt carries no per-entity fillers at all, so it is
// simply constant).
const FROZEN_NEGATIVE =
  'blurry, deformed anatomy, extra limbs, mismatched eyes, text, watermark, signature, lowres, jpeg artifacts';

// design law §3: shot = bust for minor named characters, three-quarter for
// major ones ("fidelity matched to the writing's density," finding 37).
const BUST_SHOT = 'bust character concept, plain pale background';
const THREE_QUARTER_SHOT = 'three-quarter character concept, plain pale background';

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isMajor(desc: EntityDescription): boolean {
  // BUILD_SPEC.md Builder B, src/prompt/slots.ts: literally
  // `desc.kind === 'monster' || major`.
  return desc.kind === 'monster' || desc.major === true;
}

/**
 * Build the frozen-wording prompt for one entity description.
 *
 * FROZEN slot order (design law §1, finding 21):
 * [style token] [species/body class] [age] [face] [hair/head] [garb]
 * [mood] [palette accent] [shot: bust, three-quarter, plain ground].
 *
 * Same description -> same prompt every time (no randomness, no clock
 * reads). A changed field changes only that field's slot text; every
 * other slot's text is untouched.
 */
export function buildPrompt(desc: EntityDescription): BuiltPrompt {
  if (desc.contract) return buildContractPrompt(desc);
  const speciesBodyClass = [desc.species, desc.bodyClass]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(' ');
  const age = (desc.age ?? '').trim();
  const face = (desc.face ?? '').trim();
  const hairHead = (desc.hair ?? '').trim();
  const garb = (desc.garb ?? '').trim();
  const mood = (desc.mood ?? '').trim();
  const paletteAccent = (desc.palette ?? '').trim();
  const shot = isMajor(desc) ? THREE_QUARTER_SHOT : BUST_SHOT;

  const slots: SlotValues = {
    styleToken: STYLE_TOKEN,
    speciesBodyClass,
    age,
    face,
    hairHead,
    garb,
    mood,
    paletteAccent,
    shot,
  };

  // FROZEN connective wording and order -- do not reorder these entries.
  const positive = [
    slots.styleToken,
    slots.speciesBodyClass,
    slots.age,
    slots.face,
    slots.hairHead,
    slots.garb,
    slots.mood,
    slots.paletteAccent,
    slots.shot,
  ]
    .filter(isNonEmpty)
    .join(', ');

  return { positive, negative: FROZEN_NEGATIVE, slots };
}

/**
 * Contract path (Director ruling 2026-09-02): `[style token] [every
 * expected-yes atom claim, contract order] [shot]`; the negative prompt is
 * every expected-no atom claim plus the frozen technical negatives. The
 * SlotValues record carries the joined claims under `speciesBodyClass` and
 * the shot under `shot` so manifests and tests keep one shape; the other
 * slots are empty by construction.
 */
function buildContractPrompt(desc: EntityDescription): BuiltPrompt {
  const atoms = desc.contract?.atoms ?? [];
  const yes = atoms.filter((a) => a.expected === 'yes').map((a) => a.claim.trim()).filter(isNonEmpty);
  const no = atoms.filter((a) => a.expected === 'no').map((a) => a.claim.trim()).filter(isNonEmpty);
  const shot = isMajor(desc) ? THREE_QUARTER_SHOT : BUST_SHOT;
  const slots: SlotValues = {
    styleToken: STYLE_TOKEN,
    speciesBodyClass: yes.join(', '),
    age: '',
    face: '',
    hairHead: '',
    garb: '',
    mood: '',
    paletteAccent: '',
    shot,
  };
  const positive = [STYLE_TOKEN, ...yes, shot].join(', ');
  const negative = [...no, FROZEN_NEGATIVE].join(', ');
  return { positive, negative, slots };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep(record[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON of exactly the slots that affect the
 * rendered image (design law §5: "regenerate only when descriptionHash
 * differs"). `id`, `name`, and `packId` are excluded: they key the
 * registry path, not the pixels.
 */
export function descriptionHash(desc: EntityDescription): string {
  // Contract path: the atoms are the whole description; the slot fields are
  // ignored by buildPrompt, so they must not move the hash either.
  const relevant = desc.contract ? {
    contract: { id: desc.contract.id, atoms: desc.contract.atoms },
    kind: desc.kind,
    major: isMajor(desc),
  } : {
    kind: desc.kind,
    species: desc.species ?? null,
    bodyClass: desc.bodyClass ?? null,
    age: desc.age ?? null,
    face: desc.face ?? null,
    hair: desc.hair ?? null,
    garb: desc.garb ?? null,
    mood: desc.mood ?? null,
    palette: desc.palette ?? null,
    tags: [...desc.tags].sort(),
    faction: desc.faction ?? null,
    shapeTilt: desc.shapeTilt ?? null,
    major: isMajor(desc),
  };
  const canonical = JSON.stringify(sortKeysDeep(relevant));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derived seed: `hash(packId, entityId, descriptionHash)` (design law §2,
 * findings 9 & 3 -- "a fixed seed is a reproducibility aid, not the
 * consistency mechanism"). Per BUILD_SPEC.md Builder B, src/prompt/slots.ts:
 * "first 8 bytes of SHA-256 as an unsigned int (fits ComfyUI's seed)."
 * Returned as a bigint so the full unsigned 64-bit range survives without
 * the precision loss a `number` would introduce above 2^53.
 */
export function deriveSeed(packId: string, entityId: string, descHash: string): bigint {
  const digest = createHash('sha256').update(`${packId}:${entityId}:${descHash}`).digest();
  return digest.readBigUInt64BE(0);
}
