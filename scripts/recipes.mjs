// Builds src/core/recipes.json, the recipe list anvil searches and reasons about, from two MIT-licensed
// WoW Forever addons (credited in NOTICE.md), pinned to commits so a rebuild gives the same list:
//
// - Recipe Registry's generated metadata: each recipe's profession, required skill, and how it's learned
//   (`sourceKind`, filled in by hand), plus which recipes are in the game files but not the game.
// - LibProfessionDB's English names, and which recipes come free with the profession.
//
// Run `npm run recipes` after moving the pins in scripts/sources.mjs to newer commits.

import { writeFileSync } from 'node:fs';

import { LEARNED, NAMES, PROFESSIONS, fetchText, loadRegistry, tableAfter } from './sources.mjs';

// Forever recipes LibProfessionDB has no English name for yet. Each is in Recipe Registry, not removed,
// and its teaching item is in Wowhead's WoW Forever database with the same skill (scripts/audit.mjs).
const MISSING_NAMES = {
  11447: 'Draught of Water Walking',
  1294289: 'Centaur Hoofwarmers',
};
const MAX_SKILL = 300;

const registry = await loadRegistry();
const names = new Map();
const professionOf = new Map();
for (const [file, prof] of Object.entries(PROFESSIONS)) {
  const table = tableAfter(await fetchText(NAMES, `${NAMES.dir}/enUS/${file}.lua`), 'lib:LoadNames(');
  for (const [id, entry] of Object.entries(table)) {
    names.set(Number(id), entry.name);
    professionOf.set(Number(id), prof);
  }
}
const automatic = new Set(
  Object.entries(tableAfter(await fetchText(NAMES, `${NAMES.dir}/_core/AcquireMethods.lua`), 'lib:LoadAcquireMethods('))
    .filter(([, method]) => method === 1)
    .map(([id]) => Number(id)),
);

const rows = [];
const crafting = {};
const skipped = { removed: 0, unnamed: 0, noSkill: 0, beyondCap: 0 };
const counts = {};
for (const [key, r] of Object.entries(registry)) {
  const id = Number(key);
  if (r.removed) {
    skipped.removed++;
    continue;
  }
  const name = names.get(id) ?? MISSING_NAMES[id];
  if (!name) {
    skipped.unnamed++;
    continue;
  }
  const prof = r.profession === 'first_aid' ? 'firstaid' : r.profession;
  if (!Object.values(PROFESSIONS).includes(prof)) throw new Error(`Unknown profession ${r.profession}`);
  // Required skill: Recipe Registry's, else the lowest difficulty threshold, which is the same number.
  // Without requiredSkill, a few recipes' thresholds start at a placeholder 1 (Runecloth Bandage:
  // 1/260/290/320, really learned at 260). Every recipe truly learned at 1 has requiredSkill, so a
  // leading 1 there means the next threshold is the real one.
  const levels = r.skillLevels ?? [];
  const skill = r.requiredSkill ?? (levels[0] === 1 && levels[1] ? levels[1] : levels[0]);
  if (!skill) {
    skipped.noSkill++;
    continue;
  }
  // Past Forever's skill cap: leftovers from later expansions in the game files (Smelt Elementium).
  if (skill > MAX_SKILL) {
    skipped.beyondCap++;
    continue;
  }
  // Recipes that come with the profession count as taught. With no sourceKind, a recipe that no item
  // teaches is a trainer's; one an item teaches is unknown, so it must be logged like any other.
  const learned = automatic.has(id)
    ? 'trainer'
    : (LEARNED[r.sourceKind] ?? (r.sourceKind ? 'other' : r.recipeItemId ? 'other' : 'trainer'));
  counts[learned] = (counts[learned] ?? 0) + 1;
  rows.push([id, name, prof, skill, learned]);
  // Difficulty: the skills where it turns orange, yellow, green and grey. A placeholder 1 (see above) is
  // dropped, and grey is then as far past green as green is past yellow.
  let difficulty = levels.length === 4 && levels[0] === 1 && !r.requiredSkill ? levels.slice(1) : levels.slice(0, 4);
  if (difficulty.length === 3) difficulty = [...difficulty, difficulty[2] + (difficulty[2] - difficulty[1])];
  crafting[id] = {
    reagents: (r.reagents ?? []).map((g) => [g.itemId, g.count]),
    difficulty,
    makes: r.createdItemId ?? 0,
    count: r.createdCount ?? 1,
    taughtBy: r.recipeItemId ?? 0,
  };
}
rows.sort((a, b) => a[0] - b[0]);
writeFileSync(new URL('../src/core/recipes.json', import.meta.url), `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
// Per recipe: reagents as [item id, count], difficulty (orange, yellow, green, grey), the item it makes
// and how many, and the item that teaches it (0 for none). Item names come from `npm run wowhead`.
writeFileSync(
  new URL('../src/core/crafting.json', import.meta.url),
  `{\n${Object.entries(crafting)
    .map(([id, c]) => `"${id}":${JSON.stringify([c.reagents, c.difficulty, c.makes, c.count, c.taughtBy])}`)
    .join(',\n')}\n}\n`,
);
console.log(`${rows.length} recipes`, counts, 'skipped', skipped);
