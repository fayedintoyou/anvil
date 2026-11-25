// Checks src/core/recipes.json against Wowhead's WoW Forever database, through its public tooltip
// service (the one its link previews use). For every recipe: is the spell in Forever, under the same name?
// For recipes taught by an item: does the item say the same skill? Recipe Registry's skipped recipes are
// looked up too. Answers are cached in .wowhead-cache.json, so a rerun only asks about what's new.
//
//   node scripts/audit.mjs            → audit-report.json and a summary

import { readFileSync, writeFileSync } from 'node:fs';
import { PROFESSIONS, gently, loadCache, loadRegistry, saveCache, wowheadTooltip } from './sources.mjs';

const REPORT = new URL('../audit-report.json', import.meta.url);
const recipes = JSON.parse(readFileSync(new URL('../src/core/recipes.json', import.meta.url), 'utf8'));
const registry = await loadRegistry();
const cache = loadCache();
const PROF_NAME = Object.fromEntries(Object.entries(PROFESSIONS).map(([name, id]) => [id, name === 'Firstaid' ? 'First Aid' : name]));

const tooltip = (kind, id) => wowheadTooltip(kind, id, cache);

const report = { notOnWowhead: [], renamed: [], skillDiffers: [], itemMissing: [], skippedButOnWowhead: [] };
const listed = new Set(recipes.map((r) => r[0]));

await gently(cache, recipes, async ([id, name, prof, skill, learned]) => {
  const spell = await tooltip('spell', id);
  if (!spell) return void report.notOnWowhead.push({ id, name, prof, skill, learned });
  if (spell.name !== name) report.renamed.push({ id, ours: name, wowhead: spell.name });
  const itemId = registry[id]?.recipeItemId;
  if (!itemId) return;
  const item = await tooltip('item', itemId);
  if (!item) return void report.itemMissing.push({ id, name, itemId });
  const m = new RegExp(`Requires ${PROF_NAME[prof]} \\((\\d+)\\)`).exec(item.text);
  if (m && Number(m[1]) !== skill) report.skillDiffers.push({ id, name, prof, ours: skill, wowhead: Number(m[1]), item: item.name });
});

// Recipes the build left out (marked removed, or with no name): does Forever have them after all?
const skipped = Object.keys(registry).map(Number).filter((id) => !listed.has(id));
await gently(cache, skipped, async (id) => {
  const spell = await tooltip('spell', id);
  if (spell) report.skippedButOnWowhead.push({ id, wowhead: spell.name, removed: Boolean(registry[id].removed) });
});

writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.length])));
