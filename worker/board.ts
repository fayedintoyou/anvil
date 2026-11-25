import { PROFESSIONS, type Roster } from '../src/core/types';
import { STALE_DAYS, isStale } from '../src/core/stale';
import { recipe as recipeById } from '../src/core/recipes';
import type { CooldownTimer, RequestRow } from './guild-object';

// The board: one message in a channel the guild picks, kept up to date by editing it. A single embed with
// a field per profession that anyone has, crafters highest skill first. Discord caps an embed at 6000
// characters, so each field stops at FIELD_MAX and says how many more there are. Characters nobody has
// updated in a month are in italics, since their skills may be behind.

const LAMP = 0xffb35c;
const FIELD_MAX = 400;

function crafterList(entries: string[]): string {
  let text = '';
  for (let i = 0; i < entries.length; i++) {
    const next = text ? `${text} · ${entries[i]}` : entries[i];
    const rest = entries.length - i - 1;
    // Leave room to say how many didn't fit.
    if (next.length > FIELD_MAX - (rest ? 16 : 0)) return `${text} · and ${entries.length - i} more`;
    text = next;
  }
  return text;
}

/** The board's other two sections: open requests from /want, and cooldown timers. */
export interface BoardExtras {
  requests: RequestRow[];
  cooldowns: CooldownTimer[];
}

const MAX_LINES = 10;

function lines(list: string[]): string {
  const shown = list.slice(0, MAX_LINES);
  if (list.length > MAX_LINES) shown.push(`…and ${list.length - MAX_LINES} more`);
  return shown.join('\n').slice(0, 1000);
}

export function boardMessage(roster: Roster, pageUrl: string, extras: BoardExtras = { requests: [], cooldowns: [] }) {
  const fields = PROFESSIONS.flatMap((p) => {
    const people = roster.characters
      .filter((c) => c.skills[p.id] !== undefined)
      .sort((a, b) => b.skills[p.id]! - a.skills[p.id]! || a.name.localeCompare(b.name));
    if (!people.length) return [];
    const entry = (c: (typeof people)[number]) => (isStale(c) ? `*${c.name} ${c.skills[p.id]}*` : `${c.name} ${c.skills[p.id]}`);
    return [{ name: `${p.name} · ${people.length}`, value: crafterList(people.map(entry)) }];
  });
  if (extras.requests.length) {
    fields.push({
      name: `Requests · ${extras.requests.length}`,
      value: lines(
        extras.requests.map((q) => {
          const what = recipeById(q.recipe)?.name ?? 'something';
          return `${what} for ${q.asker_name} · ${q.status === 'claimed' ? `${q.claimer_name} is making it` : 'open'}`;
        }),
      ),
    });
  }
  if (extras.cooldowns.length) {
    const now = Date.now();
    fields.push({
      name: 'Cooldowns',
      value: lines(
        extras.cooldowns.map((t) => `${t.character} · ${t.name} · ${t.ends <= now ? '**ready**' : `<t:${Math.floor(t.ends / 1000)}:R>`}`),
      ),
    });
  }
  const description = fields.length
    ? `Who can craft what. Log yours with \`/prof set\` and \`/recipe add\`; ask \`/whocan\`. [Recipes and more](${pageUrl}).`
    : `Nobody’s logged anything yet. Start with \`/prof set\`, and this fills in by itself. [The guild page](${pageUrl}).`;
  return {
    content: '',
    embeds: [
      {
        title: (roster.guildName || 'Guild crafters').slice(0, 200),
        url: pageUrl,
        color: LAMP,
        description,
        fields,
        footer: {
          text: roster.characters.some((c) => isStale(c)) ? `Italic: not updated in ${STALE_DAYS}+ days · anvil · updated` : 'anvil · updated',
        },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
