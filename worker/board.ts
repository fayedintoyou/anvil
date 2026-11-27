import { PROFESSIONS, type Roster } from '../src/core/types';
import { STALE_DAYS, isStale } from '../src/core/stale';
import { recipe as recipeById } from '../src/core/recipes';
import { coverage } from '../src/core/coverage';
import type { CooldownTimer, RequestRow } from './guild-object';

// The board: one message in a channel the guild picks, kept up to date by editing it. A single embed with
// a field per profession that anyone has, crafters highest skill first. Discord caps an embed at 6000
// characters, so each field stops at FIELD_MAX and says how many more there are. Characters nobody has
// updated in a month are in italics, since their skills may be behind.

const LAMP = 0xffb35c;
// The professions share this much of the embed, each up to Discord's 1024 per field and never under 400:
// a guild with few professions shows more crafters in each.
const CRAFTERS_BUDGET = 3600;
const FIELD_MIN = 400;
const FIELD_MAX = 1024;

function crafterList(entries: string[], max: number): string {
  let text = '';
  for (let i = 0; i < entries.length; i++) {
    const next = text ? `${text} · ${entries[i]}` : entries[i];
    const rest = entries.length - i - 1;
    // Leave room to say how many didn't fit.
    if (next.length > max - (rest ? 16 : 0)) return `${text} · and ${entries.length - i} more`;
    text = next;
  }
  return text;
}

/** The board's other two sections: open requests from /want, and cooldown timers. */
export interface BoardExtras {
  requests: RequestRow[];
  cooldowns: CooldownTimer[];
  bounties: { recipe: number; reward: string }[];
}

const MAX_LINES = 10;

function lines(list: string[]): string {
  const shown = list.slice(0, MAX_LINES);
  if (list.length > MAX_LINES) shown.push(`…and ${list.length - MAX_LINES} more`);
  return shown.join('\n').slice(0, 1000);
}

/** Collecting recipes: each profession's share the guild can make, in its heading. */
export function boardMessage(roster: Roster, pageUrl: string, extras: BoardExtras = { requests: [], cooldowns: [], bounties: [] }) {
  const covered = coverage(roster.characters);
  const shown = PROFESSIONS.filter((p) => roster.characters.some((c) => c.skills[p.id] !== undefined)).length;
  const fieldMax = Math.min(FIELD_MAX, Math.max(FIELD_MIN, Math.floor(CRAFTERS_BUDGET / Math.max(1, shown))));
  const fields = PROFESSIONS.flatMap((p) => {
    const people = roster.characters
      .filter((c) => c.skills[p.id] !== undefined)
      .sort((a, b) => b.skills[p.id]! - a.skills[p.id]! || a.name.localeCompare(b.name));
    if (!people.length) return [];
    // Each character is tagged to its owner's Discord account: a mention, which doesn't ping anyone here.
    const entry = (c: (typeof people)[number]) => {
      const text = `${c.name} ${c.skills[p.id]} (<@${c.owner}>)`;
      return isStale(c) ? `*${text}*` : text;
    };
    return [{ name: `${p.name} · ${people.length} · ${covered[p.id].percent}%`, value: crafterList(people.map(entry), fieldMax) }];
  });
  if (extras.requests.length) {
    fields.push({
      name: `Requests · ${extras.requests.length}`,
      value: lines(
        extras.requests.map((q) => {
          const what = recipeById(q.recipe)?.name ?? 'something';
          const many = q.quantity > 1 ? `${q.quantity} × ` : '';
          return `${many}${what} for ${q.asker_name} (<@${q.asker}>) · ${q.status === 'claimed' ? `${q.claimer_name} is making it` : 'open'}`;
        }),
      ),
    });
  }
  if (extras.bounties.length) {
    fields.push({
      name: `Bounties · ${extras.bounties.length}`,
      value: lines(extras.bounties.map((b) => `${recipeById(b.recipe)?.name ?? 'a recipe'}${b.reward ? ` · ${b.reward}` : ''}`)),
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
