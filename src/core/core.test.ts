import { describe, expect, it } from 'vitest';
import { PROFESSIONS, MAX_SKILL } from './types';
import { RECIPES, searchRecipes } from './recipes';

// The recipe list is generated (scripts/recipes.mjs) from two addons' data; these checks catch a source
// changing shape under a rebuild. Behaviour is covered end to end in e2e/run.mjs.
describe('recipe list', () => {
  it('has every recipe once, in a known profession, at a reachable skill', () => {
    expect(RECIPES.length).toBeGreaterThan(2000);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    const ids = new Set<string>(PROFESSIONS.map((p) => p.id));
    for (const r of RECIPES) {
      expect(ids.has(r.prof), `${r.name}: ${r.prof}`).toBe(true);
      expect(r.skill >= 1 && r.skill <= MAX_SKILL, `${r.name}: ${r.skill}`).toBe(true);
    }
  });

  it('knows trainer recipes from the rest', () => {
    const silk = RECIPES.find((r) => r.name === 'Bolt of Silk Cloth');
    const mooncloth = RECIPES.find((r) => r.name === 'Mooncloth');
    expect(silk?.learned).toBe('trainer');
    expect(mooncloth?.learned).not.toBe('trainer');
    expect(RECIPES.filter((r) => r.learned === 'campsite').length).toBeGreaterThanOrEqual(30);
  });

  it('puts names that start with the search first', () => {
    expect(searchRecipes('mooncl')[0].name).toBe('Mooncloth');
    expect(searchRecipes('titans flask')[0].name).toBe('Flask of the Titans');
  });
});
