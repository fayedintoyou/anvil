import { DurableObject } from 'cloudflare:workers';
import type { Character, ProfessionId, Roster } from '../src/core/types';
import { checkPrimaryLimit, nameKey } from '../src/core/validate';
import { professionName } from '../src/core/professions';
import { recipe as recipeById } from '../src/core/recipes';
import { discordApi, type Actor } from './discord';
import { boardMessage } from './board';

// One object per Discord server. Its SQLite storage holds the characters people have logged, their
// profession skills, the recipes logged for them, and the page's settings. Each method's reads and writes
// run with no await between them, so two people changing things at once can't lose either change. If the
// guild has a board, a change sets an alarm, and the alarm edits the board: one edit for a burst of changes.

export type Outcome = { ok: true; message: string } | { ok: false; error: string };

interface CharacterRow extends Record<string, SqlStorageValue> {
  key: string;
  name: string;
  owner: string;
  owner_name: string;
  updated: number;
}

const PAGE_KEY_LENGTH = 12;
const BOARD_DELAY_MS = 30_000;
const BOARD_SETTINGS = ['boardChannel', 'boardMessage'];
const CANT_POST =
  'I can’t post here. In this channel’s settings → Permissions, give anvil View Channel, Send Messages and Embed Links, then try again.';

function randomKey(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(PAGE_KEY_LENGTH));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export class GuildObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        key TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, owner_name TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        character TEXT NOT NULL, profession TEXT NOT NULL, skill INTEGER NOT NULL, PRIMARY KEY (character, profession)
      );
      CREATE TABLE IF NOT EXISTS recipes (
        character TEXT NOT NULL, recipe INTEGER NOT NULL, PRIMARY KEY (character, recipe)
      );
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private setting(name: string): string | undefined {
    return this.sql.exec<{ value: string }>('SELECT value FROM settings WHERE name = ?', name).toArray()[0]?.value;
  }

  private setSetting(name: string, value: string) {
    this.sql.exec('INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)', name, value);
  }

  private row(name: string): CharacterRow | undefined {
    return this.sql.exec<CharacterRow>('SELECT * FROM characters WHERE key = ?', nameKey(name)).toArray()[0];
  }

  private characters(): Character[] {
    const skills = new Map<string, Character['skills']>();
    for (const s of this.sql.exec<{ character: string; profession: string; skill: number }>('SELECT * FROM skills')) {
      const map = skills.get(s.character) ?? {};
      map[s.profession as ProfessionId] = s.skill;
      skills.set(s.character, map);
    }
    const recipes = new Map<string, number[]>();
    for (const r of this.sql.exec<{ character: string; recipe: number }>('SELECT * FROM recipes ORDER BY recipe')) {
      recipes.set(r.character, [...(recipes.get(r.character) ?? []), r.recipe]);
    }
    return this.sql
      .exec<CharacterRow>('SELECT * FROM characters ORDER BY key')
      .toArray()
      .map((c) => ({
        owner: c.owner,
        ownerName: c.owner_name,
        name: c.name,
        skills: skills.get(c.key) ?? {},
        recipes: recipes.get(c.key) ?? [],
        updated: c.updated,
      }));
  }

  /** The character, if this person may change it: its owner, or anyone with Manage Server. */
  private editable(actor: Actor, name: string): { ok: true; row: CharacterRow } | { ok: false; error: string } {
    const row = this.row(name);
    if (!row) return { ok: false, error: `Nobody’s logged a character called ${name} here yet.` };
    if (row.owner !== actor.id && !actor.manager) {
      return { ok: false, error: `${row.name} belongs to ${row.owner_name}. Only they, or someone with Manage Server, can change it.` };
    }
    return { ok: true, row };
  }

  private touch(key: string, actor: Actor) {
    // Someone with Manage Server editing another person's character leaves the owner as it was.
    this.sql.exec(
      'UPDATE characters SET updated = ?, owner_name = CASE WHEN owner = ? THEN ? ELSE owner_name END WHERE key = ?',
      Date.now(),
      actor.id,
      actor.name,
      key,
    );
  }

  async roster(): Promise<Roster> {
    return { guildName: this.setting('title') ?? '', characters: this.characters() };
  }

  /** The page's secret key, made the first time someone asks for the page. */
  async pageKey(): Promise<string> {
    let key = this.setting('pageKey');
    if (!key) {
      key = randomKey();
      this.setSetting('pageKey', key);
    }
    return key;
  }

  async checkPageKey(key: string): Promise<boolean> {
    const stored = this.setting('pageKey');
    return Boolean(stored) && stored === key;
  }

  async setTitle(actor: Actor, title: string): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Naming the page needs Manage Server.' };
    this.setSetting('title', title);
    await this.boardChanged();
    return { ok: true, message: `The page is now called “${title}”.` };
  }

  async setSkill(actor: Actor, name: string, prof: ProfessionId, skill: number): Promise<Outcome> {
    let row = this.row(name);
    if (row && row.owner !== actor.id && !actor.manager) {
      return { ok: false, error: `${row.name} belongs to ${row.owner_name}. Only they, or someone with Manage Server, can change it.` };
    }
    if (row) {
      const skills = Object.fromEntries(
        this.sql
          .exec<{ profession: string; skill: number }>('SELECT profession, skill FROM skills WHERE character = ?', row.key)
          .toArray()
          .map((s) => [s.profession, s.skill]),
      );
      const limit = checkPrimaryLimit(skills, prof);
      if (!limit.ok) return limit;
    } else {
      this.sql.exec(
        'INSERT INTO characters (key, name, owner, owner_name, updated) VALUES (?, ?, ?, ?, ?)',
        nameKey(name),
        name,
        actor.id,
        actor.name,
        Date.now(),
      );
      row = this.row(name)!;
    }
    this.sql.exec('INSERT OR REPLACE INTO skills (character, profession, skill) VALUES (?, ?, ?)', row.key, prof, skill);
    this.touch(row.key, actor);
    await this.boardChanged();
    return { ok: true, message: `${row.name}: ${professionName(prof)} ${skill}.` };
  }

  async dropProfession(actor: Actor, name: string, prof: ProfessionId): Promise<Outcome> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const { row } = found;
    const had = this.sql.exec('DELETE FROM skills WHERE character = ? AND profession = ?', row.key, prof).rowsWritten;
    if (!had) return { ok: false, error: `${row.name} doesn’t have ${professionName(prof)} logged.` };
    // Recipes of that profession go with it.
    const dropped = this.sql
      .exec<{ recipe: number }>('SELECT recipe FROM recipes WHERE character = ?', row.key)
      .toArray()
      .filter((r) => recipeById(r.recipe)?.prof === prof);
    for (const r of dropped) this.sql.exec('DELETE FROM recipes WHERE character = ? AND recipe = ?', row.key, r.recipe);
    this.touch(row.key, actor);
    await this.boardChanged();
    const also = dropped.length ? ` and ${dropped.length} logged recipe${dropped.length === 1 ? '' : 's'}` : '';
    return { ok: true, message: `Dropped ${professionName(prof)}${also} from ${row.name}.` };
  }

  async forget(actor: Actor, name: string): Promise<Outcome> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const { key, name: shown } = found.row;
    this.sql.exec('DELETE FROM recipes WHERE character = ?', key);
    this.sql.exec('DELETE FROM skills WHERE character = ?', key);
    this.sql.exec('DELETE FROM characters WHERE key = ?', key);
    await this.boardChanged();
    return { ok: true, message: `Forgot ${shown} and everything logged for them.` };
  }

  async addRecipe(actor: Actor, name: string, recipeId: number): Promise<Outcome> {
    const r = recipeById(recipeId);
    if (!r) return { ok: false, error: 'Pick a recipe from the list as you type.' };
    const found = this.editable(actor, name);
    if (!found.ok) {
      return this.row(name) ? found : { ok: false, error: `Log ${name}’s ${professionName(r.prof)} first with /prof set.` };
    }
    const { row } = found;
    const skill = this.sql
      .exec<{ skill: number }>('SELECT skill FROM skills WHERE character = ? AND profession = ?', row.key, r.prof)
      .toArray()[0]?.skill;
    if (skill === undefined) return { ok: false, error: `Log ${row.name}’s ${professionName(r.prof)} first with /prof set.` };
    if (skill < r.skill) {
      return {
        ok: false,
        error: `${r.name} needs ${professionName(r.prof)} ${r.skill}, and ${row.name} has ${skill}. Update it with /prof set if that’s changed.`,
      };
    }
    this.sql.exec('INSERT OR IGNORE INTO recipes (character, recipe) VALUES (?, ?)', row.key, r.id);
    this.touch(row.key, actor);
    await this.boardChanged();
    const note = r.learned === 'trainer' ? ' (A trainer teaches this one, so the skill alone already counted.)' : '';
    return { ok: true, message: `Logged ${r.name} for ${row.name}.${note}` };
  }

  async removeRecipe(actor: Actor, name: string, recipeId: number): Promise<Outcome> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const { row } = found;
    const removed = this.sql.exec('DELETE FROM recipes WHERE character = ? AND recipe = ?', row.key, recipeId).rowsWritten;
    if (!removed) return { ok: false, error: `${row.name} doesn’t have that recipe logged.` };
    this.touch(row.key, actor);
    await this.boardChanged();
    return { ok: true, message: `Took ${recipeById(recipeId)?.name ?? 'that recipe'} off ${row.name}.` };
  }

  // ---------- The board ----------

  private pageUrl(): string | undefined {
    const [origin, guildId, key] = [this.setting('origin'), this.setting('guildId'), this.setting('pageKey')];
    return origin && guildId && key ? `${origin}/g/${guildId}/${key}` : undefined;
  }

  private clearBoard() {
    for (const name of BOARD_SETTINGS) this.sql.exec('DELETE FROM settings WHERE name = ?', name);
  }

  /** After a change, edit the board a little later, so a burst of changes is one edit. */
  private async boardChanged() {
    if (!this.setting('boardMessage')) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + Number(this.env.BOARD_DELAY_MS ?? BOARD_DELAY_MS));
    }
  }

  /** Posts the board in a channel, and takes down the one it replaces. */
  async setBoard(actor: Actor, guildId: string, channelId: string, origin: string): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Putting up the board needs Manage Server.' };
    if (!this.env.DISCORD_BOT_TOKEN) return { ok: false, error: 'The board isn’t switched on for this anvil yet.' };
    await this.pageKey();
    this.setSetting('guildId', guildId);
    this.setSetting('origin', origin);
    const response = await discordApi(this.env, 'POST', `/channels/${channelId}/messages`, boardMessage(await this.roster(), this.pageUrl()!));
    if (response.status === 403 || response.status === 404) return { ok: false, error: CANT_POST };
    if (!response.ok) return { ok: false, error: `Discord wouldn’t take the board (${response.status}). Try again in a moment.` };
    const posted = await response.json<{ id: string }>();
    const [oldChannel, oldMessage] = BOARD_SETTINGS.map((name) => this.setting(name));
    this.setSetting('boardChannel', channelId);
    this.setSetting('boardMessage', posted.id);
    if (oldChannel && oldMessage) await discordApi(this.env, 'DELETE', `/channels/${oldChannel}/messages/${oldMessage}`).catch(() => {});
    return {
      ok: true,
      message: `The board is up in <#${channelId}>. It updates itself about 30 seconds after anyone logs something, so it’s worth pinning.`,
    };
  }

  async stopBoard(actor: Actor): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Taking down the board needs Manage Server.' };
    const [channel, message] = BOARD_SETTINGS.map((name) => this.setting(name));
    if (!channel || !message) return { ok: false, error: 'There’s no board up. Post one with /board.' };
    this.clearBoard();
    await this.ctx.storage.deleteAlarm();
    await discordApi(this.env, 'DELETE', `/channels/${channel}/messages/${message}`).catch(() => {});
    return { ok: true, message: 'Took the board down.' };
  }

  async alarm() {
    const [channel, message] = BOARD_SETTINGS.map((name) => this.setting(name));
    const url = this.pageUrl();
    if (!channel || !message || !url) return;
    const response = await discordApi(this.env, 'PATCH', `/channels/${channel}/messages/${message}`, boardMessage(await this.roster(), url));
    if (response.status === 403 || response.status === 404) {
      // Someone deleted the message, or anvil can't see the channel any more: stop until /board is run again.
      if (this.setting('boardMessage') === message) this.clearBoard();
      return;
    }
    // Anything else (Discord busy, rate limited) throws, and the alarm is retried.
    if (!response.ok) throw new Error(`Discord answered ${response.status} to a board edit.`);
  }
}
