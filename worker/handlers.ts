import type { ProfessionId, Recipe } from '../src/core/types';
import { isProfessionId, professionName } from '../src/core/professions';
import { isNotable, recipe as recipeById, recipeLabel, searchRecipes } from '../src/core/recipes';
import { checkCharacterName, checkSkill, nameKey } from '../src/core/validate';
import { whoCan } from '../src/core/whocan';
import { actorOf, choices, commandOptions, message, type Interaction, type Option } from './discord';
import { HELP, craftersText, mineText, whoCanText } from './format';

const get = (options: Option[], name: string) => options.find((o) => o.name === name)?.value;

/** What someone picked from a recipe autocomplete is its id; if they typed a name and sent it instead,
 *  take the best match. */
function pickRecipe(value: unknown, filter?: (r: Recipe) => boolean): Recipe | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\d+$/.test(value)) {
    const r = recipeById(Number(value));
    if (r && (!filter || filter(r))) return r;
  }
  return searchRecipes(value, filter, 1)[0];
}

function guild(env: Env, i: Interaction) {
  return env.GUILDS.getByName(i.guild_id!);
}

export async function autocomplete(env: Env, i: Interaction) {
  const { sub, options } = commandOptions(i);
  const focused = options.find((o) => o.focused);
  const typed = String(focused?.value ?? '');
  const actor = actorOf(i);
  if (!focused || !i.guild_id || !actor) return choices([]);

  if (focused.name === 'character') {
    const roster = await guild(env, i).roster();
    const typedKey = nameKey(typed.trim());
    return choices(
      roster.characters
        .filter((c) => (c.owner === actor.id || actor.manager) && nameKey(c.name).startsWith(typedKey))
        .sort((a, b) => Number(b.owner === actor.id) - Number(a.owner === actor.id) || a.name.localeCompare(b.name))
        .map((c) => ({ name: c.owner === actor.id ? c.name : `${c.name} (${c.ownerName})`, value: c.name })),
    );
  }

  if (focused.name === 'recipe') {
    const toChoice = (r: Recipe) => ({ name: `${recipeLabel(r)} · ${professionName(r.prof)} ${r.skill}`, value: String(r.id) });
    if (i.data?.name === 'whocan') return choices(searchRecipes(typed).map(toChoice));

    // Adding or removing: only what makes sense for the character named so far.
    const name = checkCharacterName(get(options, 'character'));
    const roster = await guild(env, i).roster();
    const c = name.ok ? roster.characters.find((x) => nameKey(x.name) === nameKey(name.value)) : undefined;
    if (sub === 'remove') {
      return choices(searchRecipes(typed, (r) => Boolean(c?.recipes.includes(r.id))).map(toChoice));
    }
    const filter = (r: Recipe) =>
      isNotable(r) && (!c || (c.skills[r.prof] !== undefined && c.skills[r.prof]! >= r.skill && !c.recipes.includes(r.id)));
    return choices(searchRecipes(typed, filter).map(toChoice));
  }
  return choices([]);
}

export async function command(env: Env, i: Interaction, origin: string) {
  const actor = actorOf(i);
  if (!i.guild_id || !actor) return message('Use anvil in your guild’s Discord server, not in a direct message.');
  const name = i.data?.name;
  const { sub, options } = commandOptions(i);
  const g = guild(env, i);

  if (name === 'whocan') {
    const r = pickRecipe(get(options, 'recipe'));
    if (!r) return message('I couldn’t find that recipe. Pick one from the list as you type.');
    return message(whoCanText(r, whoCan(r, (await g.roster()).characters)), { ephemeral: false });
  }

  if (name === 'crafters') {
    const prof = get(options, 'profession');
    if (!isProfessionId(prof)) return message('Pick a profession from the list.');
    return message(craftersText(prof, await g.roster()), { ephemeral: false });
  }

  if (name === 'mine') {
    const roster = await g.roster();
    return message(mineText(roster.characters.filter((c) => c.owner === actor.id)));
  }

  if (name === 'anvil') {
    const title = get(options, 'title');
    if (typeof title === 'string' && title.trim()) {
      const result = await g.setTitle(actor, title.trim().slice(0, 60));
      if (!result.ok) return message(result.error);
    }
    const key = await g.pageKey();
    return message(`${HELP}\n\nThe guild page: ${origin}/g/${i.guild_id}/${key}`);
  }

  const character = checkCharacterName(get(options, 'character'));
  if (!character.ok) return message(character.error);

  if (name === 'prof') {
    if (sub === 'forget') return reply(await g.forget(actor, character.value));
    const prof = get(options, 'profession');
    if (!isProfessionId(prof)) return message('Pick a profession from the list.');
    if (sub === 'drop') return reply(await g.dropProfession(actor, character.value, prof as ProfessionId));
    if (sub === 'set') {
      const skill = checkSkill(get(options, 'skill'));
      if (!skill.ok) return message(skill.error);
      return reply(await g.setSkill(actor, character.value, prof, skill.value));
    }
  }

  if (name === 'recipe') {
    const r = pickRecipe(get(options, 'recipe'));
    if (!r) return message('I couldn’t find that recipe. Pick one from the list as you type.');
    if (sub === 'add') return reply(await g.addRecipe(actor, character.value, r.id));
    if (sub === 'remove') return reply(await g.removeRecipe(actor, character.value, r.id));
  }

  return message('I don’t know that command. Try /anvil.');
}

function reply(outcome: { ok: true; message: string } | { ok: false; error: string }) {
  return message(outcome.ok ? outcome.message : outcome.error);
}
