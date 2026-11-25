import { PROFESSIONS, type Character, type ProfessionId } from './types';
import { RECIPES } from './recipes';
import { whoCan } from './whocan';

/** How much of each profession the guild can make between them: recipes with at least one crafter, out of
 *  all of that profession's recipes. The board and page show it as a percentage to collect toward. */
export function coverage(characters: Character[]): Record<ProfessionId, { have: number; total: number; percent: number }> {
  const out = {} as Record<ProfessionId, { have: number; total: number; percent: number }>;
  for (const p of PROFESSIONS) out[p.id] = { have: 0, total: 0, percent: 0 };
  for (const r of RECIPES) {
    const c = out[r.prof];
    c.total++;
    if (whoCan(r, characters).crafters.length) c.have++;
  }
  for (const c of Object.values(out)) c.percent = c.total ? Math.floor((c.have / c.total) * 100) : 0;
  return out;
}
