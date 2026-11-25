// Where anvil's recipe data comes from, and the small Lua reader for it. Shared by scripts/recipes.mjs,
// which builds the list, and scripts/audit.mjs, which checks it against Wowhead.

export const REGISTRY = {
  repo: 'colettamattia91-cloud/Recipe-Registry',
  commit: '9b7c27c4e2fa9df03e23b0629856779fab9bfbbc',
  path: 'RecipeRegistry_Forever/Data/Metadata/RecipeMetadata_Generated.lua',
};
export const NAMES = {
  repo: 'ImCheesecake/Altisan',
  commit: '0fe605b932001efa5f1f411e839939a425938755',
  dir: 'Libs/LibProfessionDB/Data/Forever',
};
export const PROFESSIONS = {
  Alchemy: 'alchemy', Blacksmithing: 'blacksmithing', Cooking: 'cooking', Enchanting: 'enchanting',
  Engineering: 'engineering', Firstaid: 'firstaid', Fishing: 'fishing', Herbalism: 'herbalism',
  Leatherworking: 'leatherworking', Mining: 'mining', Skinning: 'skinning', Tailoring: 'tailoring',
};
// Recipe Registry's sourceKind → anvil's `Learned`. "blueprint" recipes are the new Forever ones at
// skill 20 sold by profession suppliers, three or so per profession: the campsite recipes.
export const LEARNED = {
  trainer: 'trainer', drop: 'drop', worldDrop: 'drop', container: 'drop', vendor: 'vendor',
  quest: 'quest', blueprint: 'campsite', worldEvent: 'other',
};

export async function fetchText({ repo, commit }, path) {
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

export function tableAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`No ${marker}`);
  return parseTable(text, text.indexOf('{', at + marker.length - 1));
}

/** Recipe Registry's table of every recipe by spell id. */
export async function loadRegistry() {
  return tableAfter(await fetchText(REGISTRY, REGISTRY.path), 'recipesBySpellId = {');
}
