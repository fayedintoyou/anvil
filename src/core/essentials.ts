import type { Recipe } from './types';
import { RAIDS } from './raids';

// The recipes a setup asks for first. They're what the raid table already needs: consumables and resistance
// gear, which is where the guild's crafting matters most. Anything else people should see first goes in
// EXTRA, by recipe name. Everything else is still there to log, just behind "show the rest".

const EXTRA: string[] = [];

const ESSENTIAL = new Set([...RAIDS.flatMap((raid) => [...raid.needs.map((n) => n.recipe), ...raid.gear]), ...EXTRA]);

export function isEssential(r: Recipe): boolean {
  return ESSENTIAL.has(r.name);
}

/** Every essential name, for checking the list still matches the recipe list. */
export const ESSENTIAL_NAMES: string[] = [...ESSENTIAL];
