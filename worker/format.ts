import { PROFESSIONS, type Character, type ProfessionId, type Recipe, type Roster } from '../src/core/types';
import { professionName } from '../src/core/professions';
import type { WhoCan } from '../src/core/whocan';
import { recipe as recipeById, wowheadUrl } from '../src/core/recipes';
import { isStale } from '../src/core/stale';
import { colourAt, makesCount, reagentText } from '../src/core/crafting';
import { RECIPES } from '../src/core/recipes';
import type { Changes, CooldownTimer, RequestRow } from './guild-object';
import { buttons, type Button } from './discord';

// Discord replies, as Discord markdown. Times use Discord's <t:…:R> so each reader sees "3 days ago".

const LEARNED_TEXT: Record<Recipe['learned'], string> = {
  trainer: 'trainer',
  drop: 'drop',
  vendor: 'vendor',
  quest: 'quest',
  reputation: 'reputation',
  campsite: 'campsite',
  other: 'found in the world',
};

const ago = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

/** The recipe's name, linked to Wowhead. The angle brackets stop Discord from adding a preview. */
const recipeLink = (r: Recipe) => `[**${r.name}**](<${wowheadUrl(r)}>)`;

function crafterLine(c: Character, r: Recipe): string {
  const how = c.recipes.includes(r.id) ? 'logged' : `${professionName(r.prof)} ${c.skills[r.prof]}`;
  return `- **${c.name}** (${c.ownerName}) · ${how} · updated ${ago(c.updated)}`;
}

export function whoCanText(r: Recipe, result: WhoCan): string {
  const head = `${recipeLink(r)} · ${professionName(r.prof)} ${r.skill} · ${LEARNED_TEXT[r.learned]}`;
  const lines = [head];
  const takes = reagentText(r);
  if (takes) lines.push(`Takes: ${takes}`);
  if (result.crafters.length) {
    lines.push(...result.crafters.slice(0, 15).map((c) => crafterLine(c, r)));
    if (result.crafters.length > 15) lines.push(`…and ${result.crafters.length - 15} more.`);
  } else {
    lines.push(r.learned === 'trainer' ? `Nobody here has ${professionName(r.prof)} ${r.skill} logged yet.` : 'Nobody’s logged this one yet.');
  }
  if (result.couldLearn.length) {
    const names = result.couldLearn.slice(0, 10).map((c) => `${c.name} (${c.skills[r.prof]})`).join(', ');
    lines.push(`Has the skill to learn it if the recipe turns up: ${names}.`);
  }
  return lines.join('\n');
}

export function craftersText(prof: ProfessionId, roster: Roster): string {
  const people = roster.characters
    .filter((c) => c.skills[prof] !== undefined)
    .sort((a, b) => b.skills[prof]! - a.skills[prof]! || a.name.localeCompare(b.name));
  if (!people.length) return `Nobody’s logged ${professionName(prof)} yet. Add yours with /prof set.`;
  const lines = people.slice(0, 25).map((c) => {
    const logged = c.recipes.filter((id) => recipeById(id)?.prof === prof).length;
    const extra = logged ? ` · ${logged} logged recipe${logged === 1 ? '' : 's'}` : '';
    const old = isStale(c) ? ` · not updated since ${ago(c.updated)}` : '';
    return `- **${c.name}** ${c.skills[prof]} (${c.ownerName})${extra}${old}`;
  });
  if (people.length > 25) lines.push(`…and ${people.length - 25} more on the guild page (/anvil).`);
  return [`**${professionName(prof)}** · ${people.length} crafter${people.length === 1 ? '' : 's'}`, ...lines].join('\n');
}

export function mineText(characters: Character[]): string {
  if (!characters.length) {
    return 'Nothing logged yet. Start with `/prof set character:<name> profession:<…> skill:<1–300>`.';
  }
  return characters
    .map((c) => {
      const skills = PROFESSIONS.filter((p) => c.skills[p.id] !== undefined)
        .map((p) => `${p.name} ${c.skills[p.id]}`)
        .join(', ');
      const recipes = c.recipes.map((id) => recipeById(id)?.name).filter(Boolean);
      return `**${c.name}**: ${skills || 'no professions'}${recipes.length ? `\n  Logged: ${recipes.join(', ')}` : ''}`;
    })
    .join('\n');
}

export const HELP = [
  'anvil keeps track of who in the guild can craft what.',
  '- `/prof set`: your character’s profession and skill. Every recipe a trainer teaches up to that skill counts automatically. Name the character once; after that anvil uses the one you last changed.',
  '- `/recipe add`: recipes a skill doesn’t cover, like drops, vendor patterns, quests and campsite recipes.',
  '- `/recipe bulk`: paste a whole list at once. `/recipe edit`: a private page to tick them off.',
  '- `/whocan`: who can make something. `/want`: ask for it, pinging the people who can; they press a button to take it on.',
  '- `/cooldown used`: after a Mooncloth, transmute or Salt Shaker, so anvil can tell you when it’s ready.',
  '- `/crafters`: everyone with a profession. `/mine`: what you’ve logged.',
  '- `/board`: a message in a channel that anvil keeps up to date (Manage Server).',
].join('\n');

/** /want: the ask, in the channel, pinging whoever can make it (never the person asking). */
export function wantText(
  r: Recipe,
  result: WhoCan,
  askerId: string,
  note: string,
  quantity = 1,
): { text: string; mention: string[] } {
  const owners = [...new Set(result.crafters.map((c) => c.owner))].filter((id) => id !== askerId);
  const what = quantity > 1 ? `${quantity} × ${recipeLink(r)}` : recipeLink(r);
  const lines = [`<@${askerId}> is looking for ${what}${note ? `: “${note}”` : '.'}`];
  // Some recipes make more than one (a craft of Heavy Runecloth Bandage might make several).
  const crafts = Math.ceil(quantity / makesCount(r));
  const takes = reagentText(r, crafts);
  if (takes) lines.push(`Takes: ${takes}${crafts > 1 ? ` (${crafts} crafts)` : ''}`);
  if (owners.length) {
    const who = result.crafters.filter((c) => c.owner !== askerId).map((c) => c.name);
    lines.push(`${owners.map((id) => `<@${id}>`).join(' ')} can make it (${[...new Set(who)].join(', ')}).`);
  } else if (result.crafters.length) {
    lines.push('Only your own characters can make it.');
  } else {
    lines.push(r.learned === 'trainer' ? `Nobody here has ${professionName(r.prof)} ${r.skill} logged yet.` : 'Nobody’s logged this one yet.');
    if (result.couldLearn.length) {
      lines.push(`Has the skill to learn it, if the recipe turns up: ${result.couldLearn.map((c) => c.name).join(', ')}.`);
    }
  }
  return { text: lines.join('\n'), mention: owners };
}

const list = (names: string[], max = 12) =>
  names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');

/** What a paste or a save of the checklist did. */
export function changesText(c: Extract<Changes, { ok: true }>, unknown: string[] = [], fromSkill: string[] = []): string {
  const lines: string[] = [];
  if (c.added.length) lines.push(`Logged ${c.added.length} for ${c.character}: ${list(c.added)}.`);
  if (c.removed.length) lines.push(`Took ${c.removed.length} off ${c.character}: ${list(c.removed)}.`);
  if (!c.added.length && !c.removed.length) lines.push(`Nothing new for ${c.character}: those were all logged already.`);
  if (fromSkill.length) lines.push(`Already counted from the skill, since a trainer teaches them: ${list(fromSkill, 8)}.`);
  if (c.tooLow.length) lines.push(`Skipped, ${c.character} doesn’t have the skill yet: ${list(c.tooLow, 8)}.`);
  if (unknown.length) lines.push(`Didn’t recognise: ${list(unknown.map((u) => `“${u}”`), 8)}. Check the spelling, or add them with /recipe add.`);
  return lines.join('\n');
}


/** A /want post as it stands: the ask, then who's on it, with the buttons that fit. */
export function requestMessage(q: RequestRow): { content: string; components: unknown[] } {
  const id = (action: string) => `req:${q.id}:${action}`;
  let status: string;
  let list: Button[];
  if (q.status === 'open') {
    status = 'Open: press **I’ll make it** if you’re on it.';
    list = [
      { id: id('claim'), label: 'I’ll make it', style: 'primary' },
      { id: id('cancel'), label: 'Cancel', style: 'secondary' },
    ];
  } else if (q.status === 'claimed') {
    status = `**<@${q.claimer}> is making it.**`;
    list = [
      { id: id('done'), label: 'Done', style: 'success' },
      { id: id('note'), label: q.crafter_note ? 'Change note' : 'Add a note', style: 'secondary' },
      { id: id('unclaim'), label: 'Not making it', style: 'secondary' },
    ];
  } else if (q.status === 'done') {
    status = `**Made by <@${q.claimer}>.** ✓`;
    list = [];
  } else {
    status = '**Cancelled.**';
    list = [];
  }
  const note = q.crafter_note && q.status !== 'cancelled' ? `\n> ${q.claimer_name}: ${q.crafter_note}` : '';
  return { content: `${q.body}\n${status}${note}`, components: buttons(list) };
}

export function cooldownsText(timers: CooldownTimer[]): string {
  if (!timers.length) return 'No cooldowns being tracked. After using one, run `/cooldown used`.';
  const now = Date.now();
  return timers
    .map((t) => `- **${t.character}** · ${t.name} · ${t.ends <= now ? 'ready' : `ready ${ago(t.ends)}`}`)
    .join('\n');
}

const COLOUR_WORD = { orange: 'orange', yellow: 'yellow', green: 'green', grey: 'grey' } as const;

/** /level: what this character can make that still gives skill-ups, and of that, what guildies have
 *  open requests for, which is the best place to spend the mats. */
export function levelText(c: Character, prof: ProfessionId, requests: RequestRow[]): string {
  const skill = c.skills[prof];
  if (skill === undefined) return `${c.name} doesn’t have ${professionName(prof)} logged.`;
  const known = RECIPES.filter(
    (r) => r.prof === prof && r.skill <= skill && (r.learned === 'trainer' || c.recipes.includes(r.id)),
  );
  const useful = known
    .map((r) => ({ r, colour: colourAt(r, skill) }))
    .filter((x) => x.colour === 'orange' || x.colour === 'yellow')
    .sort((a, b) => (a.colour === b.colour ? b.r.skill - a.r.skill : a.colour === 'orange' ? -1 : 1));
  const lines = [`**${c.name}** · ${professionName(prof)} ${skill}`];
  const asked = useful.filter((x) => requests.some((q) => q.recipe === x.r.id && q.status === 'open'));
  if (asked.length) {
    lines.push('Skill-ups someone’s asked for (see their /want):');
    lines.push(...asked.slice(0, 8).map((x) => `- **${x.r.name}** · ${COLOUR_WORD[x.colour]}`));
  }
  const rest = useful.filter((x) => !asked.includes(x));
  if (rest.length) {
    lines.push(asked.length ? 'Other skill-ups:' : 'Still skill-ups:');
    for (const colour of ['orange', 'yellow'] as const) {
      const names = rest.filter((x) => x.colour === colour).map((x) => x.r.name);
      if (names.length) lines.push(`- ${colour === 'orange' ? 'Orange (always)' : 'Yellow (usually)'}: ${list(names, 10)}`);
    }
  } else if (!asked.length) {
    lines.push('Nothing known still gives skill-ups. Time to visit a trainer or find new recipes.');
  }
  const next = RECIPES.filter((r) => r.prof === prof && r.learned === 'trainer' && r.skill > skill).sort((a, b) => a.skill - b.skill)[0];
  if (next) lines.push(`Next from a trainer: ${next.name} at ${next.skill}.`);
  return lines.join('\n');
}

/** /alt: each profession's best skill in the guild, the thinnest first, for whoever is choosing. */
export function altText(roster: Roster): string {
  const rows = PROFESSIONS.map((p) => {
    const skills = roster.characters.map((c) => c.skills[p.id]).filter((n): n is number => n !== undefined);
    return { p, best: skills.length ? Math.max(...skills) : 0, count: skills.length, maxed: skills.filter((n) => n >= 300).length };
  }).sort((a, b) => a.maxed - b.maxed || a.best - b.best || a.count - b.count);
  const describe = (x: (typeof rows)[number]) =>
    x.count ? `best ${x.best}, ${x.count} crafter${x.count === 1 ? '' : 's'}${x.maxed ? `, ${x.maxed} at 300` : ''}` : 'nobody';
  const primary = rows.filter((x) => x.p.primary);
  const short = primary.filter((x) => !x.maxed).slice(0, 3);
  const lines = ['**Professions the guild is short of**, thinnest first:'];
  lines.push(...primary.map((x) => `- ${x.p.name}: ${describe(x)}`));
  const secondary = rows.filter((x) => !x.p.primary);
  lines.push(`Secondary: ${secondary.map((x) => `${x.p.name} (${describe(x)})`).join(', ')}.`);
  if (short.length) lines.push(`A new alt would help most with ${short.map((x) => x.p.name).join(' or ')}.`);
  return lines.join('\n');
}
