// What each raid tends to need from the guild's crafters: consumables per raider (fractions for things
// only some take, like a tank's flask), and resistance gear worth having someone able to make. Recipes are
// by name; src/core/core.test.ts checks each one is in the recipe list. Imports nothing, so the command
// list (worker/commands.ts) can load it under plain Node.

export interface RaidNeed {
  recipe: string;
  /** How many per raider: 2 for potions everyone drinks twice, 0.1 for one in ten. */
  each: number;
}

export interface Raid {
  key: string;
  name: string;
  size: number;
  needs: RaidNeed[];
  /** Resistance gear and enchants: listed as gaps when nobody can make them. */
  gear: string[];
}

export const RAIDS: Raid[] = [
  {
    key: 'mc',
    name: 'Molten Core',
    size: 40,
    needs: [
      { recipe: 'Greater Fire Protection Potion', each: 1 },
      { recipe: 'Major Healing Potion', each: 2 },
      { recipe: 'Major Mana Potion', each: 1 },
    ],
    gear: ['Enchant Cloak - Greater Fire Resistance', 'Enchant Cloak - Fire Resistance'],
  },
  {
    key: 'ony',
    name: 'Onyxia’s Lair',
    size: 40,
    needs: [
      { recipe: 'Greater Fire Protection Potion', each: 1 },
      { recipe: 'Major Healing Potion', each: 1 },
    ],
    gear: ['Enchant Cloak - Greater Fire Resistance'],
  },
  {
    key: 'bwl',
    name: 'Blackwing Lair',
    size: 40,
    needs: [
      { recipe: 'Greater Fire Protection Potion', each: 1 },
      { recipe: 'Major Healing Potion', each: 2 },
      { recipe: 'Major Mana Potion', each: 1 },
      { recipe: 'Flask of the Titans', each: 0.1 },
      { recipe: 'Elixir of the Mongoose', each: 0.5 },
    ],
    gear: ['Enchant Cloak - Greater Fire Resistance'],
  },
  {
    key: 'zg',
    name: 'Zul’Gurub',
    size: 20,
    needs: [
      { recipe: 'Major Healing Potion', each: 1 },
      { recipe: 'Major Mana Potion', each: 1 },
    ],
    gear: [],
  },
  {
    key: 'aq20',
    name: 'Ruins of Ahn’Qiraj',
    size: 20,
    needs: [
      { recipe: 'Major Healing Potion', each: 1 },
      { recipe: 'Major Mana Potion', each: 1 },
    ],
    gear: [],
  },
  {
    key: 'aq40',
    name: 'Temple of Ahn’Qiraj',
    size: 40,
    needs: [
      { recipe: 'Greater Nature Protection Potion', each: 2 },
      { recipe: 'Major Healing Potion', each: 2 },
      { recipe: 'Major Mana Potion', each: 1 },
      { recipe: 'Elixir of the Mongoose', each: 0.5 },
      { recipe: 'Flask of the Titans', each: 0.1 },
    ],
    gear: ['Enchant Cloak - Greater Nature Resistance'],
  },
  {
    key: 'naxx',
    name: 'Naxxramas',
    size: 40,
    needs: [
      { recipe: 'Greater Frost Protection Potion', each: 1 },
      { recipe: 'Greater Shadow Protection Potion', each: 1 },
      { recipe: 'Major Healing Potion', each: 2 },
      { recipe: 'Major Mana Potion', each: 1 },
      { recipe: 'Flask of the Titans', each: 0.1 },
      { recipe: 'Flask of Supreme Power', each: 0.2 },
      { recipe: 'Flask of Distilled Wisdom', each: 0.2 },
    ],
    gear: ['Enchant Shield - Frost Resistance'],
  },
];

export function raid(key: string): Raid | undefined {
  return RAIDS.find((r) => r.key === key);
}
