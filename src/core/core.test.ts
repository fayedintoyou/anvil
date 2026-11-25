import { describe, expect, it } from 'vitest';
import { PROFESSIONS, MAX_SKILL } from './types';
import { RECIPES, searchRecipes } from './recipes';
import { RAIDS } from './raids';

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

  it('takes the real skill where the source has a placeholder 1', () => {
    // Recipe Registry gives these thresholds of 1/260/290/320 and 1/280/282/285 (see scripts/recipes.mjs).
    expect(RECIPES.find((r) => r.name === 'Runecloth Bandage')?.skill).toBe(260);
    expect(RECIPES.find((r) => r.name === 'Tinker: Teleport')?.skill).toBe(280);
  });

  it('has every recipe the raid table names', () => {
    const names = new Set(RECIPES.map((r) => r.name));
    for (const r of RAIDS) for (const name of [...r.needs.map((n) => n.recipe), ...r.gear]) expect(names.has(name), name).toBe(true);
  });

  it('puts names that start with the search first', () => {
    expect(searchRecipes('mooncl')[0].name).toBe('Mooncloth');
    expect(searchRecipes('titans flask')[0].name).toBe('Flask of the Titans');
  });
});
