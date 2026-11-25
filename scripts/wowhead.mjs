// Builds src/core/wowhead.json from Wowhead's WoW Forever tooltips: the names of the items recipes take
// (src/core/reagents.json has only their ids), and which recipes have a long cooldown, and how long.
// Run `npm run wowhead` after `npm run recipes`. Answers are cached in .wowhead-cache.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { gently, loadCache, wowheadTooltip } from './sources.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recipes = read('../src/core/recipes.json');
const reagents = read('../src/core/reagents.json');
const cache = loadCache();

// Cooldowns shorter than this (Transmute: Iron to Gold's hour) aren't worth tracking.
const MIN_COOLDOWN_S = 20 * 3600;
const UNIT_S = { min: 60, hr: 3600, hour: 3600, day: 86400 };

const itemIds = [...new Set(Object.values(reagents).flatMap((list) => list.map(([id]) => id)))].sort((a, b) => a - b);
const items = {};
await gently(cache, itemIds, async (id) => {
  const item = await wowheadTooltip('item', id, cache);
  if (item) items[id] = item.name;
});

const cooldowns = {};
await gently(cache, recipes, async ([id]) => {
  const spell = await wowheadTooltip('spell', id, cache);
  const m = spell && /([\d.]+) (min|hr|hour|day)s? cooldown/.exec(spell.text);
  if (!m) return;
  const seconds = Math.round(Number(m[1]) * UNIT_S[m[2]]);
  if (seconds >= MIN_COOLDOWN_S) cooldowns[id] = seconds;
});

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => Number(a) - Number(b)));
writeFileSync(
  new URL('../src/core/wowhead.json', import.meta.url),
  `${JSON.stringify({ items: sorted(items), cooldowns: sorted(cooldowns) }, null, 1)}\n`,
);
const missing = itemIds.filter((id) => !items[id]);
console.log(`${Object.keys(items).length} item names, ${Object.keys(cooldowns).length} cooldowns; no name for items ${missing.join(', ') || 'none'}`);
