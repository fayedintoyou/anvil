import { PROFESSIONS, type Roster } from '../src/core/types';

// The board: one message in a channel the guild picks, kept up to date by editing it. A single embed with
// a field per profession that anyone has, crafters highest skill first. Discord caps an embed at 6000
// characters, so each field stops at FIELD_MAX and says how many more there are.

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

export function boardMessage(roster: Roster, pageUrl: string) {
  const fields = PROFESSIONS.flatMap((p) => {
    const people = roster.characters
      .filter((c) => c.skills[p.id] !== undefined)
      .sort((a, b) => b.skills[p.id]! - a.skills[p.id]! || a.name.localeCompare(b.name));
    if (!people.length) return [];
    return [{ name: `${p.name} · ${people.length}`, value: crafterList(people.map((c) => `${c.name} ${c.skills[p.id]}`)) }];
  });
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
        footer: { text: 'anvil · updated' },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
