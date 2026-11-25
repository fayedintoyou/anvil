import type { Character } from '../src/core/types';
import type { Raid } from '../src/core/raids';
import { RECIPES } from '../src/core/recipes';
import { reagentText, makesCount } from '../src/core/crafting';
import { professionName } from '../src/core/professions';
import { whoCan } from '../src/core/whocan';
import { buttons, type Button } from './discord';

// /raid prep: what a raid needs from the guild's crafters, for this many raiders, who can make each, and
// buttons to ask for it. Headcount comes from a muster poll when one is linked.

const byName = new Map(RECIPES.map((r) => [r.name, r]));

/** muster's poll ids: eight characters, from its own alphabet. */
const POLL = /(?:\/e\/)?([23456789abcdefghjkmnpqrstuvwxyz]{8})\/?$/;

export interface Muster {
  name: string;
  people: number;
}

/** A muster poll's name and how many have answered, through the MUSTER service binding (or MUSTER_API, in
 *  the end-to-end run). */
export async function readMuster(env: Env, link: string): Promise<Muster | { error: string }> {
  const id = POLL.exec(link.trim())?.[1];
  if (!id) return { error: 'That doesn’t look like a muster link. It’s the poll’s address, like https://muster.fayelore.com/e/abcd2345.' };
  try {
    const path = `/api/polls/${id}`;
    const response = env.MUSTER_API
      ? await fetch(`${env.MUSTER_API}${path}`)
      : await env.MUSTER.fetch(new Request(`https://muster.fayelore.com${path}`));
    if (response.status === 404) return { error: 'muster doesn’t have that poll. Check the link.' };
    if (!response.ok) return { error: 'muster didn’t answer. Try again in a moment, or give `raiders:` instead.' };
    const state = (await response.json()) as { poll: { name: string }; people: unknown[] };
    return { name: state.poll.name, people: state.people.length };
  } catch {
    return { error: 'muster didn’t answer. Try again in a moment, or give `raiders:` instead.' };
  }
}

export function raidPrep(raid: Raid, characters: Character[], heads: number, from?: Muster) {
  const source = from ? `${heads} signed up on “${from.name}”` : `${heads} raiders`;
  const lines = [`**${raid.name} prep** · ${source}`];
  const asks: Button[] = [];
  for (const need of raid.needs) {
    const r = byName.get(need.recipe);
    if (!r) continue;
    const quantity = Math.ceil(need.each * heads);
    const crafters = whoCan(r, characters).crafters;
    const takes = reagentText(r, Math.ceil(quantity / makesCount(r)));
    const who = crafters.length
      ? `${[...new Set(crafters.map((c) => c.name))].slice(0, 4).join(', ')} can make it`
      : `**nobody can make it yet** (${professionName(r.prof)} ${r.skill}, ${r.learned === 'trainer' ? 'trainer' : 'needs the recipe'})`;
    lines.push(`- **${r.name}** × ${quantity} · ${who}${takes ? `\n  Takes ${takes}` : ''}`);
    if (crafters.length && asks.length < 5) {
      asks.push({ id: `prep:${r.id}:${quantity}`, label: `Ask for ${quantity} × ${r.name}`.slice(0, 80), style: 'secondary' });
    }
  }
  const gaps = raid.gear.map((name) => byName.get(name)).filter((r) => r && !whoCan(r, characters).crafters.length);
  if (gaps.length) {
    lines.push(`Resistance gear nobody can make yet: ${gaps.map((r) => `${r!.name} (${professionName(r!.prof)} ${r!.skill})`).join(', ')}.`);
  }
  if (asks.length) lines.push('Press a button to post a request for it.');
  return { content: lines.join('\n'), components: buttons(asks) };
}
