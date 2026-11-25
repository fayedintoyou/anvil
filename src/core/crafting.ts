import type { Character, ProfessionId, Recipe } from './types';
import { recipe as recipeById } from './recipes';
import reagentData from './reagents.json';
import wowhead from './wowhead.json';

// What recipes take, and which have long cooldowns. Both are generated: reagents.json by `npm run
// recipes`, wowhead.json (item names, cooldown lengths) by `npm run wowhead`.

const REAGENTS = reagentData as unknown as Record<string, [number, number][]>;
const ITEMS = wowhead.items as Record<string, string>;
const COOLDOWN_S = wowhead.cooldowns as Record<string, number>;

export interface Reagent {
  id: number;
  name: string;
  count: number;
}

export function reagents(r: Recipe): Reagent[] {
  return (REAGENTS[r.id] ?? []).map(([id, count]) => ({ id, name: ITEMS[id] ?? `item ${id}`, count }));
}

export function reagentText(r: Recipe): string {
  return reagents(r)
    .map((g) => (g.count > 1 ? `${g.count} ${g.name}` : g.name))
    .join(', ');
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
