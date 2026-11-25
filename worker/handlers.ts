import type { ProfessionId, Recipe } from '../src/core/types';
import { isProfessionId, professionName } from '../src/core/professions';
import { isNotable, matchRecipeLines, recipe as recipeById, recipeLabel, searchRecipes } from '../src/core/recipes';
import { checkCharacterName, checkSkill, nameKey } from '../src/core/validate';
import { whoCan } from '../src/core/whocan';
import {
  actorOf,
  choices,
  commandOptions,
  followUp,
  message,
  modal,
  modalText,
  updateMessage,
  type Interaction,
  type Option,
} from './discord';
import {
  HELP,
  altText,
  changesText,
  cooldownsText,
  craftersText,
  levelText,
  mineText,
  requestMessage,
  wantText,
  whoCanText,
} from './format';
import { COOLDOWNS, recipeFromLink } from '../src/core/crafting';
import type { RequestAction } from './guild-object';

const get = (options: Option[], name: string) => options.find((o) => o.name === name)?.value;

/** What someone picked from a recipe autocomplete is its id; if they typed a name and sent it instead,
 *  take the best match. */
function pickRecipe(value: unknown, filter?: (r: Recipe) => boolean): Recipe | undefined {
  if (typeof value !== 'string') return undefined;
  const linked = recipeFromLink(value);
  if (linked && (!filter || filter(linked))) return linked;
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

  if (focused.name === 'cooldown') {
    const typedKey = typed.trim().toLowerCase();
    return choices(
      COOLDOWNS.filter((c) => c.name.toLowerCase().includes(typedKey)).map((c) => ({
        name: `${c.name} · ${Math.round(c.seconds / 3600)} h`,
        value: c.key,
      })),
    );
  }

  if (focused.name === 'recipe') {
    const toChoice = (r: Recipe) => ({ name: `${recipeLabel(r)} · ${professionName(r.prof)} ${r.skill}`, value: String(r.id) });
    if (i.data?.name === 'whocan' || i.data?.name === 'want') {
      // A pasted Wowhead or game link: offer the recipe it points at.
      const linked = recipeFromLink(typed);
      return choices(linked ? [toChoice(linked)] : searchRecipes(typed).map(toChoice));
    }

    // Adding or removing: only what makes sense for the character named so far, or the one it'll default to.
    const g = guild(env, i);
    const name = checkCharacterName(get(options, 'character') ?? (await g.lastUsed(actor.id)));
    const roster = await g.roster();
    const c = name.ok ? roster.characters.find((x) => nameKey(x.name) === nameKey(name.value)) : undefined;
    if (sub === 'remove') {
      return choices(searchRecipes(typed, (r) => Boolean(c?.recipes.includes(r.id))).map(toChoice));
    }
    const filter = (r: Recipe) =>
      isNotable(r) && (!c || (c.skills[r.prof] !== undefined && c.skills[r.prof]! >= r.skill && !c.recipes.includes(r.id)));
    // Trainer recipes don't need logging, but people look for them anyway: list them after the rest, saying
    // so, rather than leave them out and look as if anvil doesn't know them.
    const trainer = (r: Recipe) => !isNotable(r) && (!c || c.skills[r.prof] !== undefined);
    const trainerChoice = (r: Recipe) => {
      const has = c?.skills[r.prof];
      const why = has !== undefined && has >= r.skill ? 'counted from your skill' : `trainer, at ${professionName(r.prof)} ${r.skill}`;
      return { name: `${recipeLabel(r)} · ${why}, nothing to log`, value: String(r.id) };
    };
    const found = searchRecipes(typed, filter).map(toChoice);
    return choices([...found, ...searchRecipes(typed, trainer, 25 - found.length).map(trainerChoice)]);
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

  if (name === 'want') {
    const r = pickRecipe(get(options, 'recipe'));
    if (!r) return message('I couldn’t find that recipe. Pick one from the list as you type.');
    const note = String(get(options, 'note') ?? '').trim();
    const quantity = Number(get(options, 'quantity') ?? 1) || 1;
    const { text, mention } = wantText(r, whoCan(r, (await g.roster()).characters), actor.id, note, quantity);
    const { content, components } = requestMessage(await g.openRequest(actor, r.id, text, quantity));
    const reply = message(content, { ephemeral: false, mention });
    return { ...reply, data: { ...reply.data, components } };
  }

  if (name === 'crafters') {
    const prof = get(options, 'profession');
    if (!isProfessionId(prof)) return message('Pick a profession from the list.');
    return message(craftersText(prof, await g.roster()), { ephemeral: false });
  }

  if (name === 'alt') return message(altText(await g.roster()), { ephemeral: false });

  if (name === 'cooldown' && sub === 'list') return message(cooldownsText(await g.cooldownList()), { ephemeral: false });

  if (name === 'mine') {
    const reminders = get(options, 'reminders');
    if (typeof reminders === 'boolean') return reply(await g.setReminders(actor, reminders));
    const roster = await g.roster();
    return message(mineText(roster.characters.filter((c) => c.owner === actor.id)));
  }

  if (name === 'board') {
    if (get(options, 'stop') === true) return reply(await g.stopBoard(actor));
    if (!i.channel_id) return message('Run /board in the channel the board should go in.');
    return reply(await g.setBoard(actor, i.guild_id, i.channel_id, origin));
  }

  if (name === 'anvil') {
    const title = get(options, 'title');
    let named = '';
    if (typeof title === 'string' && title.trim()) {
      const value = title.trim().slice(0, 60);
      const result = await g.setTitle(actor, value);
      if (!result.ok) return message(result.error);
      named = `The page is now called **${value}**.\n\n`;
    }
    const key = await g.pageKey();
    return message(`${named}${HELP}\n\nThe guild page: ${origin}/g/${i.guild_id}/${key}`);
  }

  const named = get(options, 'character') ?? (sub === 'forget' ? undefined : await g.lastUsed(actor.id));
  if (named === undefined) return message('Which character? Add `character:` with its name once, and I’ll remember it after that.');
  const character = checkCharacterName(named);
  if (!character.ok) return message(character.error);

  if (name === 'level') {
    const prof = get(options, 'profession');
    if (!isProfessionId(prof)) return message('Pick a profession from the list.');
    const roster = await g.roster();
    const c = roster.characters.find((x) => nameKey(x.name) === nameKey(character.value));
    if (!c) return message(`Nobody’s logged a character called ${character.value} here yet.`);
    return message(levelText(c, prof, await g.openRequests()));
  }

  if (name === 'cooldown' && sub === 'used') {
    const hours = get(options, 'hours_left');
    return reply(await g.useCooldown(actor, character.value, String(get(options, 'cooldown') ?? ''), typeof hours === 'number' ? hours : undefined));
  }

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

  if (name === 'recipe' && sub === 'bulk') {
    const c = (await g.roster()).characters.find((x) => nameKey(x.name) === nameKey(character.value));
    if (!c) return message(`Log ${character.value}’s professions first with /prof set.`);
    return modal(`bulk:${c.name}`, `Recipes for ${c.name}`, 'One recipe per line', 'Mooncloth\nPattern: Runecloth Bag\nFlask of the Titans');
  }

  if (name === 'recipe' && sub === 'edit') {
    const link = await g.editLink(actor, character.value);
    if (!link.ok) return message(link.error);
    return message(
      `Tick off ${link.character}’s recipes here: ${origin}/e/${i.guild_id}/${link.token}\nThe link is just for you and works for two hours.`,
    );
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

/** The paste box's answer: every line matched to a recipe the character could have, then logged. Or
 *  the note a crafter puts on a request they've taken. */
export async function modalSubmit(env: Env, i: Interaction) {
  const actor = actorOf(i);
  const id = i.data?.custom_id ?? '';
  const noteFor = /^reqnote:(\d+)$/.exec(id);
  if (noteFor && i.guild_id && actor) {
    const result = await guild(env, i).noteRequest(actor, Number(noteFor[1]), modalText(i).trim().slice(0, 200));
    if (!result.ok) return message(result.error);
    const { content, components } = requestMessage(result.row);
    return updateMessage(content, components);
  }
  if (!i.guild_id || !actor || !id.startsWith('bulk:')) return message('That form has expired. Run the command again.');
  const name = id.slice('bulk:'.length);
  const { matched, unknown } = matchRecipeLines(modalText(i));
  // Trainer recipes come with the skill, so they're said to be counted already rather than logged.
  const result = await guild(env, i).changeRecipes(actor, name, matched.filter(isNotable).map((r) => r.id));
  if (!result.ok) return message(result.error);
  return message(changesText(result, unknown, matched.filter((r) => !isNotable(r)).map((r) => r.name)));
}

const ACTIONS: RequestAction[] = ['claim', 'unclaim', 'done', 'cancel'];
const NOTE = 'note';

/** A button on a /want post. The post is rewritten to match; finishing one also pings the asker, in a
 *  message of its own, since edits don't ping. That ping goes out after the reply, through `later`. */
export async function component(env: Env, i: Interaction, later: (work: Promise<unknown>) => void) {
  const actor = actorOf(i);
  const m = /^req:(\d+):(\w+)$/.exec(i.data?.custom_id ?? '');
  if (m?.[2] === NOTE) {
    return modal(`reqnote:${m[1]}`, 'A note on your request', 'Like “free for guild” or “bring the mats”', 'Free for guild');
  }
  if (!i.guild_id || !actor || !m || !ACTIONS.includes(m[2] as RequestAction)) return message('That button doesn’t work any more.');
  const result = await guild(env, i).requestAction(actor, Number(m[1]), m[2] as RequestAction);
  if (!result.ok) return message(result.error);
  const q = result.row;
  if (q.status === 'done' && q.asker !== q.claimer) {
    const what = recipeById(q.recipe)?.name ?? 'request';
    later(followUp(env, i, `<@${q.asker}> your **${what}** is ready, from <@${q.claimer}>.`, [q.asker]));
  }
  const { content, components } = requestMessage(q);
  return updateMessage(content, components);
}

