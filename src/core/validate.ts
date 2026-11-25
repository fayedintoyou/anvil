import { MAX_NAME, MAX_PRIMARY, MAX_SKILL, type Character, type ProfessionId } from './types';
import { profession } from './professions';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A WoW Forever character name: a first name of 2 to 12 letters, capitalised the way the game shows it,
 *  and an optional surname of letter words (with ' or - inside), each word starting with a capital. */
export function checkCharacterName(raw: unknown): Checked<string> {
  const words = typeof raw === 'string' ? raw.normalize('NFC').trim().split(/\s+/) : [];
  const [first = '', ...surname] = words;
  const fits =
    /^\p{L}{2,12}$/u.test(first) &&
    surname.every((w) => /^\p{L}+(?:['’-]\p{L}+)*$/u.test(w)) &&
    words.join(' ').length <= MAX_NAME;
  if (!fits) {
    return {
      ok: false,
      error: `A character name is a first name of 2 to 12 letters, then a surname if you have one (${MAX_NAME} characters in all).`,
    };
  }
  const lower = first.toLocaleLowerCase();
  const capital = (w: string) => w.charAt(0).toLocaleUpperCase() + w.slice(1);
  return { ok: true, value: [capital(lower), ...surname.map(capital)].join(' ') };
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
