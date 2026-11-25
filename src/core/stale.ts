import type { Character } from './types';

/** A character nobody has updated in this long may have out-of-date skills: the board and page say so. */
export const STALE_DAYS = 30;

export function isStale(c: Character, now = Date.now()): boolean {
  return now - c.updated > STALE_DAYS * 24 * 60 * 60 * 1000;
}
