// Builds src/core/recipes.json, the recipe list anvil searches and reasons about, from two MIT-licensed
// WoW Forever addons (credited in NOTICE.md), pinned to commits so a rebuild gives the same list:
//
// - Recipe Registry's generated metadata: each recipe's profession, required skill, and how it's learned
//   (`sourceKind`, filled in by hand), plus which recipes are in the game files but not the game.
// - LibProfessionDB's English names, and which recipes come free with the profession.
//
// Run `npm run recipes` after moving the pins below to newer commits.

import { writeFileSync } from 'node:fs';

const REGISTRY = {
  repo: 'colettamattia91-cloud/Recipe-Registry',
  commit: '9b7c27c4e2fa9df03e23b0629856779fab9bfbbc',
  path: 'RecipeRegistry_Forever/Data/Metadata/RecipeMetadata_Generated.lua',
};
const NAMES = {
  repo: 'ImCheesecake/Altisan',
  commit: '3e55c165077ba55fab112222f202cd2b6c8da19c',
  dir: 'Libs/LibProfessionDB/Data/Forever',
};
const PROFESSIONS = {
  Alchemy: 'alchemy', Blacksmithing: 'blacksmithing', Cooking: 'cooking', Enchanting: 'enchanting',
  Engineering: 'engineering', Firstaid: 'firstaid', Fishing: 'fishing', Herbalism: 'herbalism',
  Leatherworking: 'leatherworking', Mining: 'mining', Skinning: 'skinning', Tailoring: 'tailoring',
};
// Recipe Registry's sourceKind → anvil's `Learned`. "blueprint" recipes are the new Forever ones at
// skill 20 sold by profession suppliers, three or so per profession: the campsite recipes.
const LEARNED = {
  trainer: 'trainer', drop: 'drop', worldDrop: 'drop', container: 'drop', vendor: 'vendor',
  quest: 'quest', blueprint: 'campsite', worldEvent: 'other',
};

async function fetchText({ repo, commit }, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

/** Reads one Lua table constructor starting at `start` (the `{`), as JSON-like values: tables with only
 *  positional entries become arrays, others objects. Enough for generated data files, not for Lua. */
function parseTable(text, start) {
  let i = start;
  const space = () => {
    for (;;) {
      while (/\s/.test(text[i])) i++;
      if (text.startsWith('--', i)) while (i < text.length && text[i] !== '\n') i++;
      else return;
    }
  };
  const value = () => {
    space();
    const c = text[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") {
      let out = '';
      i++;
      while (text[i] !== c) {
        if (text[i] === '\\') {
          i++;
          out += { n: '\n', t: '\t' }[text[i]] ?? text[i];
        } else out += text[i];
        i++;
      }
      i++;
      return out;
    }
    const m = /^(-?[0-9.]+(?:e-?\d+)?|true|false|nil)/.exec(text.slice(i, i + 40));
    if (!m) throw new Error(`Unexpected ${JSON.stringify(text.slice(i, i + 30))} at ${i}`);
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : Number(m[0]);
  };
  const table = () => {
    i++; // {
    const obj = {};
    const list = [];
    for (;;) {
      space();
      if (text[i] === '}') {
        i++;
        return Object.keys(obj).length ? obj : list;
      }
      let key;
      if (text[i] === '[') {
        i++;
        key = value();
        space();
        i++; // ]
        space();
        i++; // =
      } else {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(text.slice(i, i + 80));
        if (m) {
          key = m[1];
          i += m[0].length;
        }
      }
      const v = value();
      if (key === undefined) list.push(v);
      else obj[key] = v;
      space();
      if (text[i] === ',' || text[i] === ';') i++;
    }
  };
  return value();
}

function tableAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`No ${marker}`);
  return parseTable(text, text.indexOf('{', at + marker.length - 1));
}

const registry = tableAfter(await fetchText(REGISTRY, REGISTRY.path), 'recipesBySpellId = {');
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
const skipped = { removed: 0, unnamed: 0, noSkill: 0 };
const counts = {};
for (const [key, r] of Object.entries(registry)) {
  const id = Number(key);
  if (r.removed) {
    skipped.removed++;
    continue;
  }
  const name = names.get(id);
  if (!name) {
    skipped.unnamed++;
    continue;
  }
  const prof = r.profession === 'first_aid' ? 'firstaid' : r.profession;
  if (!Object.values(PROFESSIONS).includes(prof)) throw new Error(`Unknown profession ${r.profession}`);
  // Required skill: Recipe Registry's, else the lowest difficulty threshold, which is the same number.
  const skill = r.requiredSkill ?? r.skillLevels?.[0];
  if (!skill) {
    skipped.noSkill++;
    continue;
  }
  // Recipes that come with the profession count as taught. With no sourceKind, a recipe that no item
  // teaches is a trainer's; one an item teaches is unknown, so it must be logged like any other.
  const learned = automatic.has(id)
    ? 'trainer'
    : (LEARNED[r.sourceKind] ?? (r.sourceKind ? 'other' : r.recipeItemId ? 'other' : 'trainer'));
  counts[learned] = (counts[learned] ?? 0) + 1;
  rows.push([id, name, prof, skill, learned]);
}
rows.sort((a, b) => a[0] - b[0]);
writeFileSync(new URL('../src/core/recipes.json', import.meta.url), `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
console.log(`${rows.length} recipes`, counts, 'skipped', skipped);
