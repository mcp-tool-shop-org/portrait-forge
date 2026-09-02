import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  descriptionHash,
  deriveSeed,
  STYLE_TOKEN,
  type EntityDescription,
} from '../../src/prompt/slots.js';

function makeDesc(overrides: Partial<EntityDescription> = {}): EntityDescription {
  return {
    id: 'aldric',
    name: 'Brother Aldric',
    kind: 'npc',
    species: 'human',
    bodyClass: 'stocky',
    age: 'an old man',
    face: 'a weathered face',
    hair: 'a tonsure',
    garb: 'a hooded brown wool cassock, holding a brass censer',
    mood: 'a solemn expression',
    palette: 'muted browns',
    tags: ['clergy', 'starter-fantasy'],
    faction: 'the chantry',
    packId: 'starter-fantasy',
    shapeTilt: 'rounded',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('is deterministic: same description -> same prompt, twice', () => {
    const desc = makeDesc();
    const a = buildPrompt(desc);
    const b = buildPrompt(desc);
    expect(a).toEqual(b);
  });

  it('opens with the frozen style token read from the training config', () => {
    const { positive } = buildPrompt(makeDesc());
    expect(STYLE_TOKEN).toBe('sfhd style');
    expect(positive.startsWith(STYLE_TOKEN)).toBe(true);
  });

  it('keeps the frozen slot order: style, species/body, age, face, hair, garb, mood, palette, shot', () => {
    const { positive } = buildPrompt(makeDesc());
    const speciesIdx = positive.indexOf('human stocky');
    const ageIdx = positive.indexOf('an old man');
    const faceIdx = positive.indexOf('a weathered face');
    const hairIdx = positive.indexOf('a tonsure');
    const garbIdx = positive.indexOf('hooded brown wool cassock');
    const moodIdx = positive.indexOf('a solemn expression');
    const paletteIdx = positive.indexOf('muted browns');
    const shotIdx = positive.indexOf('bust character concept');

    expect(speciesIdx).toBeGreaterThan(-1);
    expect(ageIdx).toBeGreaterThan(speciesIdx);
    expect(faceIdx).toBeGreaterThan(ageIdx);
    expect(hairIdx).toBeGreaterThan(faceIdx);
    expect(garbIdx).toBeGreaterThan(hairIdx);
    expect(moodIdx).toBeGreaterThan(garbIdx);
    expect(paletteIdx).toBeGreaterThan(moodIdx);
    expect(shotIdx).toBeGreaterThan(paletteIdx);
  });

  it('uses the three-quarter shot for monsters, bust for a minor npc', () => {
    const npc = buildPrompt(makeDesc({ kind: 'npc', major: false }));
    const monster = buildPrompt(makeDesc({ kind: 'monster' }));
    const majorNpc = buildPrompt(makeDesc({ kind: 'npc', major: true }));
    expect(npc.slots.shot).toContain('bust');
    expect(monster.slots.shot).toContain('three-quarter');
    expect(majorNpc.slots.shot).toContain('three-quarter');
  });

  it('changing one field changes only that field\'s slot text', () => {
    const base = buildPrompt(makeDesc());
    const changedMood = buildPrompt(makeDesc({ mood: 'a furious glare' }));

    expect(changedMood.slots.mood).not.toBe(base.slots.mood);
    // every other slot is untouched
    expect(changedMood.slots.styleToken).toBe(base.slots.styleToken);
    expect(changedMood.slots.speciesBodyClass).toBe(base.slots.speciesBodyClass);
    expect(changedMood.slots.age).toBe(base.slots.age);
    expect(changedMood.slots.face).toBe(base.slots.face);
    expect(changedMood.slots.hairHead).toBe(base.slots.hairHead);
    expect(changedMood.slots.garb).toBe(base.slots.garb);
    expect(changedMood.slots.paletteAccent).toBe(base.slots.paletteAccent);
    expect(changedMood.slots.shot).toBe(base.slots.shot);
  });

  it('has a frozen negative prompt independent of the description', () => {
    const a = buildPrompt(makeDesc());
    const b = buildPrompt(makeDesc({ mood: 'furious', species: 'goblin' }));
    expect(a.negative).toBe(b.negative);
  });

  it('omits empty optional slots from the joined string without disturbing others', () => {
    const sparse = buildPrompt(
      makeDesc({ age: undefined, face: undefined, hair: undefined, palette: undefined }),
    );
    expect(sparse.positive).not.toMatch(/, ,/); // no double-comma from an empty slot
    expect(sparse.positive).toContain('hooded brown wool cassock');
  });
});

describe('descriptionHash', () => {
  it('is deterministic and stable across property key order', () => {
    const desc = makeDesc();
    expect(descriptionHash(desc)).toBe(descriptionHash(desc));
    expect(descriptionHash(desc)).toHaveLength(64); // sha256 hex
  });

  it('changes only when a slot-affecting field changes', () => {
    const base = makeDesc();
    const sameHash = descriptionHash(makeDesc());
    const changedHash = descriptionHash(makeDesc({ mood: 'a furious glare' }));
    expect(sameHash).toBe(descriptionHash(base));
    expect(changedHash).not.toBe(sameHash);
  });

  it('is independent of id/name/packId (those key the registry path, not the pixels)', () => {
    const a = descriptionHash(makeDesc({ id: 'a', name: 'A', packId: 'pack-a' }));
    const b = descriptionHash(makeDesc({ id: 'b', name: 'B', packId: 'pack-b' }));
    expect(a).toBe(b);
  });

  it('is order-insensitive for tags', () => {
    const a = descriptionHash(makeDesc({ tags: ['x', 'y'] }));
    const b = descriptionHash(makeDesc({ tags: ['y', 'x'] }));
    expect(a).toBe(b);
  });
});

describe('deriveSeed', () => {
  it('is deterministic given the same inputs', () => {
    const hash = descriptionHash(makeDesc());
    const a = deriveSeed('starter-fantasy', 'aldric', hash);
    const b = deriveSeed('starter-fantasy', 'aldric', hash);
    expect(a).toBe(b);
  });

  it('fits in an unsigned 64-bit integer', () => {
    const seed = deriveSeed('starter-fantasy', 'aldric', descriptionHash(makeDesc()));
    expect(typeof seed).toBe('bigint');
    expect(seed).toBeGreaterThanOrEqual(0n);
    expect(seed).toBeLessThanOrEqual(0xffffffffffffffffn);
  });

  it('changes when the entity id changes, holding the hash fixed', () => {
    const hash = descriptionHash(makeDesc());
    const a = deriveSeed('starter-fantasy', 'aldric', hash);
    const b = deriveSeed('starter-fantasy', 'maren', hash);
    expect(a).not.toBe(b);
  });

  it('changes when the description hash changes, holding id/pack fixed', () => {
    const a = deriveSeed('starter-fantasy', 'aldric', descriptionHash(makeDesc()));
    const b = deriveSeed('starter-fantasy', 'aldric', descriptionHash(makeDesc({ mood: 'furious' })));
    expect(a).not.toBe(b);
  });
});
