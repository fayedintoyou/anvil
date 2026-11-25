import { MAX_PRIMARY, MAX_SKILL, type Character, type ProfessionId } from './types';
import { profession } from './professions';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A WoW character name: 2 to 12 letters, shown capitalised the way the game shows it. */
export function checkCharacterName(raw: unknown): Checked<string> {
  const name = typeof raw === 'string' ? raw.trim().normalize('NFC') : '';
  if (!/^\p{L}{2,12}$/u.test(name)) {
    return { ok: false, error: 'A character name is 2 to 12 letters, with no spaces or numbers.' };
  }
  const lower = name.toLocaleLowerCase();
  return { ok: true, value: lower.charAt(0).toLocaleUpperCase() + lower.slice(1) };
}

export function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function checkSkill(raw: unknown): Checked<number> {
  const skill = Number(raw);
  if (!Number.isInteger(skill) || skill < 1 || skill > MAX_SKILL) {
    return { ok: false, error: `Skill is a whole number from 1 to ${MAX_SKILL}.` };
  }
  return { ok: true, value: skill };
}

/** A third primary profession is turned away with the two it would join, so the reply can say which
 *  to drop. */
export function checkPrimaryLimit(skills: Character['skills'], adding: ProfessionId): Checked<null> {
  if (!profession(adding)?.primary || skills[adding] !== undefined) return { ok: true, value: null };
  const primaries = (Object.keys(skills) as ProfessionId[]).filter((p) => profession(p)?.primary);
  if (primaries.length < MAX_PRIMARY) return { ok: true, value: null };
  const names = primaries.map((p) => profession(p)!.name).join(' and ');
  return { ok: false, error: `That character already has ${names}. Drop one first with /prof drop.` };
}
