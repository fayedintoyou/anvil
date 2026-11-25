import type { Character, ProfessionId, Recipe } from './types';
import { recipe as recipeById } from './recipes';
import craftingData from './crafting.json';
import wowhead from './wowhead.json';

// What recipes take and make, how hard they are, and which have long cooldowns. All generated:
// crafting.json by `npm run recipes`, wowhead.json (item names, cooldown lengths) by `npm run wowhead`.

/** reagents [item, count], difficulty [orange, yellow, green, grey], made item, made count, teaching item */
type Row = [[number, number][], number[], number, number, number];
const CRAFTING = craftingData as unknown as Record<string, Row>;
const ITEMS = wowhead.items as Record<string, string>;
const COOLDOWN_S = wowhead.cooldowns as Record<string, number>;

export interface Reagent {
  id: number;
  name: string;
  count: number;
}

export function reagents(r: Recipe): Reagent[] {
  return (CRAFTING[r.id]?.[0] ?? []).map(([id, count]) => ({ id, name: ITEMS[id] ?? `item ${id}`, count }));
}

/** What it takes, for `times` crafts. */
export function reagentText(r: Recipe, times = 1): string {
  return reagents(r)
    .map((g) => (g.count * times > 1 ? `${g.count * times} ${g.name}` : g.name))
    .join(', ');
}

/** How many one craft makes. */
export function makesCount(r: Recipe): number {
  return CRAFTING[r.id]?.[3] ?? 1;
}

export type Colour = 'orange' | 'yellow' | 'green' | 'grey';

/** The recipe's colour at a skill: orange always gives a point, yellow usually, green sometimes, grey never. */
export function colourAt(r: Recipe, skill: number): Colour {
  const [, yellow, green, grey] = CRAFTING[r.id]?.[1] ?? [];
  if (yellow === undefined) return 'grey';
  if (skill < yellow) return 'orange';
  if (skill < green) return 'yellow';
  if (skill < grey) return 'green';
  return 'grey';
}

const byMade = new Map<number, number[]>();
const byTeacher = new Map<number, number>();
for (const [id, row] of Object.entries(CRAFTING)) {
  if (row[2]) byMade.set(row[2], [...(byMade.get(row[2]) ?? []), Number(id)]);
  if (row[4]) byTeacher.set(row[4], Number(id));
}

/** The recipes a game item has to do with: the ones that make it, or the one it teaches. */
export function recipesForItem(itemId: number): Recipe[] {
  const ids = [...(byMade.get(itemId) ?? []), ...(byTeacher.has(itemId) ? [byTeacher.get(itemId)!] : [])];
  return ids.map((id) => recipeById(id)).filter((r): r is Recipe => Boolean(r));
}

/** A recipe from something pasted: a Wowhead link to the spell, the item it makes or the pattern that
 *  teaches it, or an item link copied out of the game (|Hitem:14342:…|h[Mooncloth]|h). */
export function recipeFromLink(text: string): Recipe | undefined {
  const spell = /wowhead\.com\/(?:[a-z-]+\/)?spell=(\d+)/i.exec(text);
  if (spell) return recipeById(Number(spell[1]));
  const item = /wowhead\.com\/(?:[a-z-]+\/)?item=(\d+)/i.exec(text) ?? /\|?Hitem:(\d+)/.exec(text);
  if (item) return recipesForItem(Number(item[1]))[0];
  const enchant = /\|?Henchant:(\d+)/.exec(text);
  if (enchant) return recipeById(Number(enchant[1]));
  return undefined;
}

/** A timer someone can be waiting on. Transmutes of the same length share one timer in the game, so they
 *  share one here; the Salt Shaker's is on the item, which any leatherworker at 250 may carry. */
export interface Cooldown {
  key: string;
  name: string;
  prof: ProfessionId;
  skill: number;
  seconds: number;
  recipes: number[];
}

function buildCooldowns(): Cooldown[] {
  const groups = new Map<string, Recipe[]>();
  for (const [id, seconds] of Object.entries(COOLDOWN_S)) {
    const r = recipeById(Number(id));
    if (!r) continue;
    const key = r.name.startsWith('Transmute:') ? `transmute-${Math.round(seconds / 3600)}h` : `recipe-${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: Cooldown[] = [...groups].map(([key, list]) => {
    const short = list.map((r) => r.name.replace(/^Transmute: /, ''));
    const name = list.length === 1 ? list[0].name : list.length === 2 ? `Transmute: ${short.join(' or ')}` : 'Elemental transmutes';
    return {
      key,
      name,
      prof: list[0].prof,
      skill: Math.min(...list.map((r) => r.skill)),
      seconds: COOLDOWN_S[list[0].id],
      recipes: list.map((r) => r.id),
    };
  });
  out.push({ key: 'salt-shaker', name: 'Salt Shaker', prof: 'leatherworking', skill: 250, seconds: 3 * 86400, recipes: [] });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const COOLDOWNS = buildCooldowns();

export function cooldown(key: string): Cooldown | undefined {
  return COOLDOWNS.find((c) => c.key === key);
}

/** Whether a character can be waiting on this timer: they can make one of its recipes (trainer ones from
 *  skill, the rest logged), or for the Salt Shaker, have the leatherworking for it. */
export function hasCooldown(c: Character, cd: Cooldown): boolean {
  const skill = c.skills[cd.prof];
  if (skill === undefined) return false;
  if (!cd.recipes.length) return skill >= cd.skill;
  return cd.recipes.some((id) => {
    const r = recipeById(id);
    return r && skill >= r.skill && (r.learned === 'trainer' || c.recipes.includes(id));
  });
}
