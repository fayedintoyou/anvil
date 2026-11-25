import { PROFESSIONS, type Character, type ProfessionId, type Recipe, type Roster } from '../src/core/types';
import { professionName } from '../src/core/professions';
import type { WhoCan } from '../src/core/whocan';
import { recipe as recipeById } from '../src/core/recipes';

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

function crafterLine(c: Character, r: Recipe): string {
  const how = c.recipes.includes(r.id) ? 'logged' : `${professionName(r.prof)} ${c.skills[r.prof]}`;
  return `- **${c.name}** (${c.ownerName}) · ${how} · updated ${ago(c.updated)}`;
}

export function whoCanText(r: Recipe, result: WhoCan): string {
  const head = `**${r.name}** · ${professionName(r.prof)} ${r.skill} · ${LEARNED_TEXT[r.learned]}`;
  const lines = [head];
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
    return `- **${c.name}** ${c.skills[prof]} (${c.ownerName})${extra}`;
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
  '- `/whocan`: who can make something.',
  '- `/crafters`: everyone with a profession. `/mine`: what you’ve logged.',
  '- `/board`: a message in a channel that anvil keeps up to date (Manage Server).',
].join('\n');
