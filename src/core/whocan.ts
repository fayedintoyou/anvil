import type { Character, Recipe } from './types';

export interface WhoCan {
  /** Logged the recipe, or have the skill for a trainer recipe. */
  crafters: Character[];
  /** Not a trainer recipe and nobody's logged it, but these have the skill to learn it if it turns up. */
  couldLearn: Character[];
}

/** Who in the guild can make a recipe. A trainer recipe counts as known from the skill it needs;
 *  anything else (a drop, a vendor's pattern, a campsite) only when someone has logged it. */
export function whoCan(recipe: Recipe, characters: Character[]): WhoCan {
  const crafters: Character[] = [];
  const couldLearn: Character[] = [];
  for (const c of characters) {
    const skill = c.skills[recipe.prof];
    if (c.recipes.includes(recipe.id)) crafters.push(c);
    else if (skill !== undefined && skill >= recipe.skill) {
      (recipe.learned === 'trainer' ? crafters : couldLearn).push(c);
    }
  }
  const bySkill = (a: Character, b: Character) =>
    (b.skills[recipe.prof] ?? 0) - (a.skills[recipe.prof] ?? 0) || a.name.localeCompare(b.name);
  return { crafters: crafters.sort(bySkill), couldLearn: couldLearn.sort(bySkill) };
}
