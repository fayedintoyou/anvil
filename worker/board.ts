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
// Discord refuses an embed over 6000 characters in all, or a field over 1024. The professions' crafters get
// whatever the rest of the board leaves, shared evenly, with a little to spare.
const EMBED_MAX = 6000;
const EMBED_SPARE = 100;
const FIELD_MAX = 1024;
const EXTRA_MAX = 1000;

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

/** Up to MAX_LINES whole lines, within EXTRA_MAX characters, saying how many didn't fit. */
function lines(list: string[]): string {
  let shown = list.slice(0, MAX_LINES);
  const more = (n: number) => (n ? `\n…and ${n} more` : '');
  while (shown.length > 1 && shown.join('\n').length + more(list.length - shown.length).length > EXTRA_MAX) shown = shown.slice(0, -1);
  return (shown.join('\n') + more(list.length - shown.length)).slice(0, EXTRA_MAX);
}

/** Collecting recipes: each profession's share the guild can make, in its heading. */
export function boardMessage(roster: Roster, pageUrl: string, extras: BoardExtras = { requests: [], cooldowns: [], bounties: [] }) {
  const covered = coverage(roster.characters);
  const professions = PROFESSIONS.flatMap((p) => {
    const people = roster.characters
      .filter((c) => c.skills[p.id] !== undefined)
      .sort((a, b) => b.skills[p.id]! - a.skills[p.id]! || a.name.localeCompare(b.name));
    if (!people.length) return [];
    // Each character is tagged to its owner's Discord account: a mention, which doesn't ping anyone here.
    const entries = people.map((c) => {
      const text = `${c.name} ${c.skills[p.id]} (<@${c.owner}>)`;
      return isStale(c) ? `*${text}*` : text;
    });
    return [{ name: `${p.name} · ${people.length} · ${covered[p.id].percent}%`, entries }];
  });
  const fields: { name: string; value: string }[] = [];
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
  const title = (roster.guildName || 'Guild crafters').slice(0, 200);
  const footer = roster.characters.some((c) => isStale(c)) ? `Italic: not updated in ${STALE_DAYS}+ days · anvil · updated` : 'anvil · updated';
  const description = professions.length || fields.length
    ? `Who can craft what. Log yours with \`/prof set\` and \`/recipe add\`; ask \`/whocan\`. [Recipes and more](${pageUrl}).`
    : `Nobody’s logged anything yet. Start with \`/prof set\`, and this fills in by itself. [The guild page](${pageUrl}).`;
  const used =
    title.length +
    description.length +
    footer.length +
    professions.reduce((n, p) => n + p.name.length, 0) +
    fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const share = Math.min(FIELD_MAX, Math.floor((EMBED_MAX - EMBED_SPARE - used) / Math.max(1, professions.length)));
  fields.unshift(...professions.map((p) => ({ name: p.name, value: crafterList(p.entries, share) })));
  return {
    content: '',
    embeds: [
      {
        title,
        url: pageUrl,
        color: LAMP,
        description,
        fields,
        footer: { text: footer },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
