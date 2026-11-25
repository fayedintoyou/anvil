/** The twelve professions of WoW Forever: nine primary, of which a character trains two, and three
 *  secondary that anyone can learn alongside them. */
export const PROFESSIONS = [
  { id: 'alchemy', name: 'Alchemy', primary: true },
  { id: 'blacksmithing', name: 'Blacksmithing', primary: true },
  { id: 'enchanting', name: 'Enchanting', primary: true },
  { id: 'engineering', name: 'Engineering', primary: true },
  { id: 'herbalism', name: 'Herbalism', primary: true },
  { id: 'leatherworking', name: 'Leatherworking', primary: true },
  { id: 'mining', name: 'Mining', primary: true },
  { id: 'skinning', name: 'Skinning', primary: true },
  { id: 'tailoring', name: 'Tailoring', primary: true },
  { id: 'cooking', name: 'Cooking', primary: false },
  { id: 'fishing', name: 'Fishing', primary: false },
  { id: 'firstaid', name: 'First Aid', primary: false },
] as const;

export type ProfessionId = (typeof PROFESSIONS)[number]['id'];
export type Profession = (typeof PROFESSIONS)[number];

/** A character name with its surname, in characters. */
export const MAX_NAME = 32;
export const MAX_SKILL = 300;
export const MAX_PRIMARY = 2;

/** How a recipe is learned. Only `trainer` recipes are assumed known from a skill level; everything
 *  else someone has to log. */
export type Learned = 'trainer' | 'drop' | 'vendor' | 'quest' | 'reputation' | 'campsite' | 'other';

export interface Recipe {
  /** The crafting spell's id, stable across patches. Stored in logged recipes: don't renumber. */
  id: number;
  name: string;
  prof: ProfessionId;
  /** The skill needed to learn it. */
  skill: number;
  learned: Learned;
  /** What it makes, when that differs from the recipe's own name. */
  makes?: string;
}

export interface Character {
  /** Discord user id of the person who plays it. */
  owner: string;
  /** The owner's Discord display name when they last changed it. */
  ownerName: string;
  name: string;
  skills: Partial<Record<ProfessionId, number>>;
  /** Logged recipe ids: the ones a skill level doesn't imply. */
  recipes: number[];
  updated: number;
}

export interface Roster {
  guildName: string;
  characters: Character[];
}
