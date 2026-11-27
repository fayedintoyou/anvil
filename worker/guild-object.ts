import { DurableObject } from 'cloudflare:workers';
import type { Character, ProfessionId, Roster } from '../src/core/types';
import { checkPrimaryLimit, nameKey } from '../src/core/validate';
import { professionName } from '../src/core/professions';
import { recipe as recipeById } from '../src/core/recipes';
import { discordApi, type Actor } from './discord';
import { boardMessage, type BoardExtras } from './board';
import { COOLDOWNS, cooldown as cooldownByKey, hasCooldown } from '../src/core/crafting';
import { STALE_DAYS } from '../src/core/stale';
import { whoCan } from '../src/core/whocan';
import { coverage } from '../src/core/coverage';

// One object per Discord server. Its SQLite storage holds the characters people have logged, their
// profession skills, the recipes logged for them, and the page's settings. Each method's reads and writes
// run with no await between them, so two people changing things at once can't lose either change. If the
// guild has a board, a change sets an alarm, and the alarm edits the board: one edit for a burst of changes.

export type Outcome = { ok: true; message: string } | { ok: false; error: string };

/** What a batch of recipe changes did: the paste box and the checklist page both report it. */
export type Changes =
  | { ok: true; character: string; added: string[]; removed: string[]; tooLow: string[] }
  | { ok: false; error: string };

export type RequestStatus = 'open' | 'claimed' | 'done' | 'cancelled';
export type RequestAction = 'claim' | 'unclaim' | 'done' | 'cancel';

export interface RequestRow extends Record<string, SqlStorageValue> {
  id: number;
  recipe: number;
  asker: string;
  asker_name: string;
  body: string;
  claimer: string | null;
  claimer_name: string | null;
  status: RequestStatus;
  quantity: number;
  crafter_note: string | null;
  created: number;
  updated: number;
}

export interface CooldownTimer {
  key: string;
  character: string;
  owner: string;
  cooldown: string;
  name: string;
  ends: number;
}

export interface EditView {
  guildName: string;
  character: Character;
  expires: number;
}

interface CharacterRow extends Record<string, SqlStorageValue> {
  key: string;
  name: string;
  owner: string;
  owner_name: string;
  updated: number;
}

const PAGE_KEY_LENGTH = 12;
const EDIT_TOKEN_LENGTH = 24;
const EDIT_LINK_MS = 2 * 60 * 60 * 1000;
const BOARD_DELAY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Open requests older than this drop off the board. */
const REQUEST_DAYS = 14;
const BOARD_SETTINGS = ['boardChannel', 'boardMessage'];
const CANT_POST =
  'I can’t post here. In this channel’s settings → Permissions, give anvil View Channel, Send Messages and Embed Links, then try again.';

function randomKey(length = PAGE_KEY_LENGTH): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
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
      CREATE TABLE IF NOT EXISTS last_used (owner TEXT PRIMARY KEY, character TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recipe INTEGER NOT NULL, asker TEXT NOT NULL, asker_name TEXT NOT NULL,
        body TEXT NOT NULL, claimer TEXT, claimer_name TEXT, status TEXT NOT NULL, created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        character TEXT NOT NULL, cooldown TEXT NOT NULL, ends INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (character, cooldown)
      );
      CREATE TABLE IF NOT EXISTS people (
        owner TEXT PRIMARY KEY, reminders INTEGER NOT NULL DEFAULT 1, nudged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, character TEXT, owner TEXT,
        recipe INTEGER, profession TEXT, before INTEGER, after INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bounties (
        recipe INTEGER PRIMARY KEY, reward TEXT NOT NULL, set_by TEXT NOT NULL, created INTEGER NOT NULL,
        finder TEXT, found_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS edit_links (
        token TEXT PRIMARY KEY, actor TEXT NOT NULL, character TEXT NOT NULL, expires INTEGER NOT NULL
      );
    `);
    this.addColumns('requests', { quantity: 'INTEGER NOT NULL DEFAULT 1', crafter_note: 'TEXT' });
  }

  /** Columns added to a table after it was first made: CREATE TABLE IF NOT EXISTS doesn't add them to a
   *  guild's existing one. */
  private addColumns(table: string, columns: Record<string, string>) {
    const have = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
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
    // Someone with Manage Server editing another person's character leaves the owner as it was, and doesn't
    // make it the character they get when they leave the name out.
    this.sql.exec(
      'UPDATE characters SET updated = ?, owner_name = CASE WHEN owner = ? THEN ? ELSE owner_name END WHERE key = ?',
      Date.now(),
      actor.id,
      actor.name,
      key,
    );
    this.sql.exec(
      'INSERT OR REPLACE INTO last_used (owner, character) SELECT owner, key FROM characters WHERE key = ? AND owner = ?',
      key,
      actor.id,
    );
  }

  /** The character someone means when they leave the name out: the one of theirs they last changed, or
   *  their only one. */
  async lastUsed(owner: string): Promise<string | undefined> {
    const last = this.sql
      .exec<{ name: string }>('SELECT c.name FROM last_used l JOIN characters c ON c.key = l.character WHERE l.owner = ?', owner)
      .toArray()[0]?.name;
    if (last) return last;
    const theirs = this.sql.exec<{ name: string }>('SELECT name FROM characters WHERE owner = ?', owner).toArray();
    return theirs.length === 1 ? theirs[0].name : undefined;
  }

  async roster(): Promise<Roster> {
    // A safety net: if the alarm ever stopped rescheduling itself, the next read starts it again, so
    // cooldowns, reminders and the digest can't go quiet for good.
    if ((await this.ctx.storage.getAlarm()) === null && this.sql.exec('SELECT 1 FROM characters LIMIT 1').toArray().length) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000 * Math.min(1, this.scale * 1000)); // a minute, or less when sped up
    }
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
    await this.changed();
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
    const before = this.sql
      .exec<{ skill: number }>('SELECT skill FROM skills WHERE character = ? AND profession = ?', row.key, prof)
      .toArray()[0]?.skill;
    this.sql.exec('INSERT OR REPLACE INTO skills (character, profession, skill) VALUES (?, ?, ?)', row.key, prof, skill);
    if (skill > (before ?? 0)) this.logEvent('skill', row, { profession: prof, before: before ?? 0, after: skill });
    this.touch(row.key, actor);
    await this.changed();
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
    await this.changed();
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
    this.sql.exec('DELETE FROM last_used WHERE character = ?', key);
    this.sql.exec('DELETE FROM edit_links WHERE character = ?', key);
    this.sql.exec('DELETE FROM cooldowns WHERE character = ?', key);
    await this.changed();
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
    if (r.learned === 'trainer') {
      // Nothing to log: the skill already counts it. Said plainly, since people reach for it expecting to.
      return {
        ok: true,
        message: `${r.name} is taught by trainers, so ${row.name}’s ${professionName(r.prof)} ${skill} already counts it. Nothing to log: /whocan lists ${row.name} for it.`,
      };
    }
    const firsts = this.learned(row, [r.id]);
    this.touch(row.key, actor);
    this.announceFirsts(row.name, firsts);
    await this.changed();
    return { ok: true, message: `Logged ${r.name} for ${row.name}.` };
  }

  async removeRecipe(actor: Actor, name: string, recipeId: number): Promise<Outcome> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const { row } = found;
    const removed = this.sql.exec('DELETE FROM recipes WHERE character = ? AND recipe = ?', row.key, recipeId).rowsWritten;
    if (!removed) return { ok: false, error: `${row.name} doesn’t have that recipe logged.` };
    this.touch(row.key, actor);
    await this.changed();
    return { ok: true, message: `Took ${recipeById(recipeId)?.name ?? 'that recipe'} off ${row.name}.` };
  }

  /** Many recipes at once. Ones the character lacks the profession or skill for are skipped and listed,
   *  not refused, so one wrong line in a long paste doesn't lose the rest. */
  async changeRecipes(actor: Actor, name: string, add: number[], remove: number[] = []): Promise<Changes> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const { row } = found;
    const skills = new Map(
      this.sql
        .exec<{ profession: string; skill: number }>('SELECT profession, skill FROM skills WHERE character = ?', row.key)
        .toArray()
        .map((s) => [s.profession, s.skill]),
    );
    const added: string[] = [];
    const removed: string[] = [];
    const tooLow: string[] = [];
    const learnable: number[] = [];
    for (const id of new Set(add)) {
      const r = recipeById(id);
      if (!r) continue;
      if ((skills.get(r.prof) ?? -1) < r.skill) {
        tooLow.push(`${r.name} (${professionName(r.prof)} ${r.skill})`);
        continue;
      }
      learnable.push(r.id);
    }
    const firsts = this.learned(row, learnable, added);
    for (const id of new Set(remove)) {
      if (this.sql.exec('DELETE FROM recipes WHERE character = ? AND recipe = ?', row.key, id).rowsWritten) {
        removed.push(recipeById(id)?.name ?? String(id));
      }
    }
    if (added.length || removed.length) {
      this.touch(row.key, actor);
      this.announceFirsts(row.name, firsts);
      await this.changed();
    }
    return { ok: true, character: row.name, added, removed, tooLow };
  }

  // ---------- Firsts, bounties and the activity log ----------

  private logEvent(kind: string, row: CharacterRow, more: { recipe?: number; profession?: string; before?: number; after?: number }) {
    this.sql.exec(
      'INSERT INTO events (at, kind, character, owner, recipe, profession, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      kind,
      row.name,
      row.owner,
      more.recipe ?? null,
      more.profession ?? null,
      more.before ?? null,
      more.after ?? null,
    );
  }

  /** Logs recipes for a character, returning the ones nobody else in the guild could make: the firsts.
   *  `added` collects the names of the ones that weren't logged already. */
  private learned(row: CharacterRow, ids: number[], added: string[] = []): number[] {
    const others = this.characters().filter((c) => nameKey(c.name) !== row.key);
    const firsts: number[] = [];
    for (const id of ids) {
      if (!this.sql.exec('INSERT OR IGNORE INTO recipes (character, recipe) VALUES (?, ?)', row.key, id).rowsWritten) continue;
      const r = recipeById(id)!;
      added.push(r.name);
      const first = !whoCan(r, others).crafters.length;
      this.logEvent(first ? 'first' : 'recipe', row, { recipe: id, profession: r.prof });
      if (first) firsts.push(id);
    }
    return firsts;
  }

  /** A post for the board's channel, sent by the next alarm. Without a board there's nowhere to say it. */
  private announce(content: string) {
    if (this.setting('boardMessage')) this.sql.exec('INSERT INTO outbox (content) VALUES (?)', content);
  }

  private announceFirsts(character: string, firsts: number[]) {
    if (!firsts.length) return;
    const recipes = firsts.map((id) => recipeById(id)!);
    const names = recipes.map((r) => `**${r.name}**`);
    const percent = coverage(this.characters())[recipes[0].prof].percent;
    const what = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    this.announce(
      `🎉 ${character} just learned ${what}: ${names.length === 1 ? 'a first' : 'firsts'} for the guild! ${professionName(recipes[0].prof)} is now ${percent}% covered.`,
    );
    for (const r of recipes) {
      const bounty = this.sql.exec<{ reward: string }>('SELECT reward FROM bounties WHERE recipe = ? AND finder IS NULL', r.id).toArray()[0];
      if (!bounty) continue;
      this.sql.exec('UPDATE bounties SET finder = ?, found_at = ? WHERE recipe = ?', character, Date.now(), r.id);
      this.announce(`🎯 Bounty found: ${character} brought in **${r.name}**${bounty.reward ? ` (${bounty.reward})` : ''}.`);
    }
  }

  async setBounty(actor: Actor, recipe: number, reward: string): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Setting bounties needs Manage Server.' };
    const r = recipeById(recipe);
    if (!r) return { ok: false, error: 'Pick a recipe from the list as you type.' };
    const crafter = whoCan(r, this.characters()).crafters[0];
    if (crafter) return { ok: false, error: `${crafter.name} can already make ${r.name}.` };
    this.sql.exec(
      'INSERT OR REPLACE INTO bounties (recipe, reward, set_by, created) VALUES (?, ?, ?, ?)',
      recipe,
      reward,
      actor.name,
      Date.now(),
    );
    await this.changed();
    return { ok: true, message: `Bounty up for ${r.name}${reward ? ` (${reward})` : ''}. It’s on the board, and anvil calls it out when someone logs it.` };
  }

  async removeBounty(actor: Actor, recipe: number): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Taking down bounties needs Manage Server.' };
    if (!this.sql.exec('DELETE FROM bounties WHERE recipe = ?', recipe).rowsWritten) return { ok: false, error: 'There’s no bounty on that.' };
    await this.changed();
    return { ok: true, message: `Took down the bounty on ${recipeById(recipe)?.name ?? 'that'}.` };
  }

  async bounties(): Promise<{ recipe: number; reward: string; finder: string | null }[]> {
    return this.sql
      .exec<{ recipe: number; reward: string; finder: string | null }>('SELECT recipe, reward, finder FROM bounties ORDER BY found_at IS NOT NULL, created')
      .toArray();
  }

  /** Sunday's post: what the week brought (since the last one). Nothing happened, nothing posted. */
  private digest(since: number): string | undefined {
    const events = this.sql.exec<{ kind: string; character: string | null; owner: string | null; recipe: number | null; profession: string | null; before: number | null; after: number | null }>(
      'SELECT kind, character, owner, recipe, profession, before, after FROM events WHERE at > ? ORDER BY at',
      since,
    ).toArray();
    if (!events.length) return undefined;
    const lines = ['**This week in the guild’s workshop**'];
    const gains = new Map<string, number>();
    for (const e of events.filter((e) => e.kind === 'skill')) {
      const key = `${e.character} · ${professionName(e.profession as ProfessionId)}`;
      gains.set(key, (gains.get(key) ?? 0) + (e.after! - e.before!));
    }
    const topGains = [...gains].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (topGains.length) lines.push(`Skill-ups: ${topGains.map(([k, n]) => `${k} +${n}`).join(', ')}.`);
    const learned = events.filter((e) => e.kind === 'recipe' || e.kind === 'first');
    if (learned.length) {
      const firsts = learned.filter((e) => e.kind === 'first').map((e) => recipeById(e.recipe!)?.name).filter(Boolean);
      lines.push(`Recipes learned: ${learned.length}${firsts.length ? `, ${firsts.length} of them firsts for the guild (${firsts.slice(0, 6).join(', ')})` : ''}.`);
    }
    const done = events.filter((e) => e.kind === 'request');
    if (done.length) {
      const byCrafter = new Map<string, number>();
      for (const e of done) byCrafter.set(e.owner!, (byCrafter.get(e.owner!) ?? 0) + 1);
      const [best, count] = [...byCrafter].sort((a, b) => b[1] - a[1])[0];
      const bestName = this.sql.exec<{ owner_name: string }>('SELECT owner_name FROM characters WHERE owner = ? LIMIT 1', best).toArray()[0]?.owner_name;
      lines.push(`Requests filled: ${done.length}.`);
      lines.push(`🏆 Crafter of the week: **${bestName ?? 'a guildie'}**, with ${count} filled. Thank you!`);
    }
    const percent = coverage(this.characters());
    const ranked = Object.entries(percent).filter(([, c]) => c.have).sort((a, b) => b[1].percent - a[1].percent).slice(0, 4);
    if (ranked.length) lines.push(`Coverage: ${ranked.map(([p, c]) => `${professionName(p as ProfessionId)} ${c.percent}%`).join(', ')}.`);
    return lines.join('\n');
  }

  /** When the next digest is due: Sunday 17:00 UTC, or a scaled week in the end-to-end run. */
  private nextDigest(now: number): number {
    if (this.scale !== 1) return now + 7 * DAY_MS * this.scale;
    const d = new Date(now);
    d.setUTCHours(17, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
    return d.getTime() > now ? d.getTime() : d.getTime() + 7 * DAY_MS;
  }

  /** Posts waiting announcements, and the digest when it's due, in the board's channel. */
  private async sendPosts(now: number) {
    const channel = this.setting('boardChannel');
    if (!channel) {
      this.sql.exec('DELETE FROM outbox');
      return;
    }
    const due = Number(this.setting('digestAt') ?? 0);
    if (!due) this.setSetting('digestAt', String(this.nextDigest(now)));
    else if (now >= due) {
      this.setSetting('digestAt', String(this.nextDigest(now)));
      // Since the last digest, or since the board went up.
      const since = Number(this.setting('lastDigest') ?? this.setting('boardSince') ?? now - 7 * DAY_MS * this.scale);
      this.setSetting('lastDigest', String(now));
      const text = this.digest(since);
      if (text) this.sql.exec('INSERT INTO outbox (content) VALUES (?)', text);
    }
    for (const post of this.sql.exec<{ id: number; content: string }>('SELECT * FROM outbox ORDER BY id').toArray()) {
      this.sql.exec('DELETE FROM outbox WHERE id = ?', post.id);
      await discordApi(this.env, 'POST', `/channels/${channel}/messages`, { content: post.content, allowed_mentions: { parse: [] } }).catch(() => {});
    }
    this.sql.exec('DELETE FROM events WHERE at < ?', now - 60 * DAY_MS * this.scale);
  }

  // ---------- Private edit links ----------

  /** A link to tick recipes on the web, for one character, as this person, for two hours. */
  async editLink(actor: Actor, name: string): Promise<{ ok: true; token: string; character: string } | { ok: false; error: string }> {
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const now = Date.now();
    this.sql.exec('DELETE FROM edit_links WHERE expires < ?', now);
    const token = randomKey(EDIT_TOKEN_LENGTH);
    this.sql.exec(
      'INSERT INTO edit_links (token, actor, character, expires) VALUES (?, ?, ?, ?)',
      token,
      JSON.stringify(actor),
      found.row.key,
      now + EDIT_LINK_MS,
    );
    return { ok: true, token, character: found.row.name };
  }

  private editLinkRow(token: string) {
    const link = this.sql
      .exec<{ actor: string; character: string; expires: number }>('SELECT * FROM edit_links WHERE token = ?', token)
      .toArray()[0];
    return link && link.expires > Date.now() ? { actor: JSON.parse(link.actor) as Actor, key: link.character, expires: link.expires } : undefined;
  }

  async editView(token: string): Promise<EditView | undefined> {
    const link = this.editLinkRow(token);
    const character = link && this.characters().find((c) => nameKey(c.name) === link.key);
    return character && { guildName: this.setting('title') ?? '', character, expires: link.expires };
  }

  async editSave(token: string, add: number[], remove: number[]): Promise<Changes> {
    const link = this.editLinkRow(token);
    const row = link && this.sql.exec<CharacterRow>('SELECT * FROM characters WHERE key = ?', link.key).toArray()[0];
    if (!link || !row) return { ok: false, error: 'expired' };
    return this.changeRecipes(link.actor, row.name, add, remove);
  }

  // ---------- The board ----------

  private pageUrl(): string | undefined {
    const [origin, guildId, key] = [this.setting('origin'), this.setting('guildId'), this.setting('pageKey')];
    return origin && guildId && key ? `${origin}/g/${guildId}/${key}` : undefined;
  }

  private clearBoard() {
    for (const name of BOARD_SETTINGS) this.sql.exec('DELETE FROM settings WHERE name = ?', name);
  }

  /** TIME_SCALE shrinks cooldowns, staleness and the daily check, for the end-to-end run only. */
  private get scale(): number {
    return Number(this.env.TIME_SCALE ?? 1);
  }

  /** The alarm runs at the earliest moment anything is due: a board edit, a cooldown coming ready, or the
   *  daily look for stale entries. */
  private async wake(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current || current < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  /** The alarm's next run, decided at the end of each run from everything that's due, and set outright:
   *  a run doesn't trust what getAlarm says about itself. */
  private nextAlarm(now: number): number | undefined {
    const due: number[] = [];
    if (this.setting('boardDirty')) due.push(now + Number(this.env.BOARD_DELAY_MS ?? BOARD_DELAY_MS));
    if (this.sql.exec('SELECT 1 FROM outbox LIMIT 1').toArray().length) due.push(now + Number(this.env.BOARD_DELAY_MS ?? BOARD_DELAY_MS));
    const cooldown = this.sql.exec<{ ends: number | null }>('SELECT MIN(ends) AS ends FROM cooldowns WHERE notified = 0').one().ends;
    if (cooldown) due.push(cooldown);
    const digestAt = Number(this.setting('digestAt') ?? 0);
    if (digestAt && this.setting('boardChannel')) due.push(digestAt);
    if (this.sql.exec('SELECT 1 FROM characters LIMIT 1').toArray().length) due.push(now + DAY_MS * this.scale);
    return due.length ? Math.max(Math.min(...due), now) : undefined;
  }

  /** After a change: edit the board a little later, so a burst of changes is one edit, and make sure the
   *  daily check is coming. */
  private async changed() {
    if (this.setting('boardMessage')) {
      this.setSetting('boardDirty', '1');
      await this.wake(Date.now() + Number(this.env.BOARD_DELAY_MS ?? BOARD_DELAY_MS));
    } else {
      await this.wake(Date.now() + DAY_MS * this.scale);
    }
  }

  /** Posts the board in a channel, and takes down the one it replaces. */
  async setBoard(actor: Actor, guildId: string, channelId: string, origin: string): Promise<Outcome> {
    if (!actor.manager) return { ok: false, error: 'Putting up the board needs Manage Server.' };
    if (!this.env.DISCORD_BOT_TOKEN) return { ok: false, error: 'The board isn’t switched on for this anvil yet.' };
    await this.pageKey();
    this.setSetting('guildId', guildId);
    this.setSetting('origin', origin);
    const response = await discordApi(this.env, 'POST', `/channels/${channelId}/messages`, boardMessage(await this.roster(), this.pageUrl()!, this.boardExtras()));
    if (response.status === 403 || response.status === 404) return { ok: false, error: CANT_POST };
    if (!response.ok) return { ok: false, error: `Discord wouldn’t take the board (${response.status}). Try again in a moment.` };
    const posted = await response.json<{ id: string }>();
    const [oldChannel, oldMessage] = BOARD_SETTINGS.map((name) => this.setting(name));
    this.setSetting('boardChannel', channelId);
    this.setSetting('boardMessage', posted.id);
    if (!this.setting('boardSince')) this.setSetting('boardSince', String(Date.now()));
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

  private boardExtras(): BoardExtras {
    const since = Date.now() - REQUEST_DAYS * DAY_MS;
    const requests = this.sql
      .exec<RequestRow>("SELECT * FROM requests WHERE status IN ('open', 'claimed') AND created > ? ORDER BY created DESC", since)
      .toArray();
    const bounties = this.sql
      .exec<{ recipe: number; reward: string }>('SELECT recipe, reward FROM bounties WHERE finder IS NULL ORDER BY created')
      .toArray();
    return { requests, cooldowns: this.timers(), bounties };
  }

  /** Edits the board to match. A board someone deleted, or anvil can't see any more, is forgotten. */
  private async editBoard() {
    const [channel, message] = BOARD_SETTINGS.map((name) => this.setting(name));
    const url = this.pageUrl();
    this.sql.exec("DELETE FROM settings WHERE name = 'boardDirty'");
    if (!channel || !message || !url) return;
    const response = await discordApi(
      this.env,
      'PATCH',
      `/channels/${channel}/messages/${message}`,
      boardMessage(await this.roster(), url, this.boardExtras()),
    );
    if (response.status === 403 || response.status === 404) {
      if (this.setting('boardMessage') === message) this.clearBoard();
      return;
    }
    if (!response.ok) throw new Error(`Discord answered ${response.status} to a board edit.`);
  }

  async alarm() {
    const now = Date.now();
    try {
      await this.cooldownsReady(now);
      await this.nudgeStale(now);
      await this.sendPosts(now);
      if (this.setting('boardDirty')) {
        try {
          await this.editBoard();
        } catch (e) {
          // Discord busy or rate limited: the board stays dirty, so the next run (shortly) tries again. Not
          // by throwing, which would back the whole alarm off, cooldown messages and all.
          console.error(e);
          this.setSetting('boardDirty', '1');
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      // Always set the next run, even after a failure above: a run that threw here would otherwise leave
      // no alarm at all, and nothing would be due again until someone used the guild.
      const next = this.nextAlarm(Date.now());
      if (next !== undefined) await this.ctx.storage.setAlarm(next);
    }
  }

  // ---------- Direct messages ----------

  /** A direct message from the bot. People can turn DMs from server members off, so this may not arrive,
   *  and that's fine: nothing depends on it. */
  private async dm(userId: string, content: string): Promise<boolean> {
    if (!this.env.DISCORD_BOT_TOKEN) return false;
    // A dropped connection gets one more try; a refusal (DMs closed) doesn't.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const channel = await discordApi(this.env, 'POST', '/users/@me/channels', { recipient_id: userId });
        if (!channel.ok) return false;
        const { id } = await channel.json<{ id: string }>();
        const sent = await discordApi(this.env, 'POST', `/channels/${id}/messages`, { content, allowed_mentions: { parse: [] } });
        return sent.ok;
      } catch (e) {
        console.error(e);
      }
    }
    return false;
  }

  private guildLabel(): string {
    return this.setting('title') || 'your guild';
  }

  // ---------- Requests (/want) ----------

  async openRequests(): Promise<RequestRow[]> {
    return this.sql.exec<RequestRow>("SELECT * FROM requests WHERE status IN ('open', 'claimed')").toArray();
  }

  async openRequest(actor: Actor, recipe: number, body: string, quantity = 1): Promise<RequestRow> {
    const now = Date.now();
    const row = this.sql
      .exec<RequestRow>(
        "INSERT INTO requests (recipe, asker, asker_name, body, status, created, updated, quantity) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING *",
        recipe,
        actor.id,
        actor.name,
        body,
        now,
        now,
        quantity,
      )
      .one();
    await this.changed();
    return row;
  }

  /** A button pressed on a request. Anyone can take one on; the person making it, the asker, or someone
   *  with Manage Server can finish or let it go; only the asker (or Manage Server) can cancel it. */
  async requestAction(actor: Actor, id: number, action: RequestAction): Promise<{ ok: true; row: RequestRow } | { ok: false; error: string }> {
    const row = this.sql.exec<RequestRow>('SELECT * FROM requests WHERE id = ?', id).toArray()[0];
    if (!row) return { ok: false, error: 'That request is gone.' };
    const isAsker = row.asker === actor.id;
    const isClaimer = row.claimer === actor.id;
    let status: RequestStatus;
    let claimer = row.claimer;
    let claimerName = row.claimer_name;
    if (row.status === 'done' || row.status === 'cancelled') return { ok: false, error: `That request is already ${row.status}.` };
    if (action === 'claim') {
      if (row.status === 'claimed') return { ok: false, error: `${row.claimer_name} is already making it.` };
      status = 'claimed';
      claimer = actor.id;
      claimerName = actor.name;
    } else if (action === 'unclaim') {
      if (row.status !== 'claimed') return { ok: false, error: 'Nobody’s making it yet.' };
      if (!isClaimer && !actor.manager) return { ok: false, error: `Only ${row.claimer_name} can let this one go.` };
      status = 'open';
      claimer = null;
      claimerName = null;
    } else if (action === 'done') {
      if (row.status !== 'claimed') return { ok: false, error: 'Press “I’ll make it” first.' };
      if (!isClaimer && !isAsker && !actor.manager) return { ok: false, error: `Only ${row.claimer_name} or ${row.asker_name} can mark it done.` };
      status = 'done';
      this.sql.exec(
        "INSERT INTO events (at, kind, owner, recipe, after) VALUES (?, 'request', ?, ?, ?)",
        Date.now(),
        row.claimer,
        row.recipe,
        row.quantity,
      );
    } else {
      if (!isAsker && !actor.manager) return { ok: false, error: `Only ${row.asker_name} can cancel their request.` };
      status = 'cancelled';
    }
    const updated = this.sql
      .exec<RequestRow>(
        'UPDATE requests SET status = ?, claimer = ?, claimer_name = ?, updated = ? WHERE id = ? RETURNING *',
        status,
        claimer,
        claimerName,
        Date.now(),
        id,
      )
      .one();
    await this.changed();
    return { ok: true, row: updated };
  }

  /** The crafter's note on a request they've taken: a price, "free for guild", what to bring. */
  async noteRequest(actor: Actor, id: number, note: string): Promise<{ ok: true; row: RequestRow } | { ok: false; error: string }> {
    const row = this.sql.exec<RequestRow>('SELECT * FROM requests WHERE id = ?', id).toArray()[0];
    if (!row || row.status !== 'claimed') return { ok: false, error: 'Only a request someone’s making can have a note.' };
    if (row.claimer !== actor.id) return { ok: false, error: `Only ${row.claimer_name} can add a note to this one.` };
    const updated = this.sql
      .exec<RequestRow>('UPDATE requests SET crafter_note = ?, updated = ? WHERE id = ? RETURNING *', note || null, Date.now(), id)
      .one();
    return { ok: true, row: updated };
  }

  // ---------- Cooldowns ----------

  private timers(): CooldownTimer[] {
    return this.sql
      .exec<{ key: string; character: string; owner: string; cooldown: string; ends: number }>(
        'SELECT t.character AS key, c.name AS character, c.owner AS owner, t.cooldown AS cooldown, t.ends AS ends FROM cooldowns t JOIN characters c ON c.key = t.character ORDER BY t.ends',
      )
      .toArray()
      .flatMap((t) => {
        const cd = cooldownByKey(t.cooldown);
        return cd ? [{ ...t, name: cd.name }] : [];
      });
  }

  async cooldownList(): Promise<CooldownTimer[]> {
    return this.timers();
  }

  /** Someone used a cooldown: it's ready again after its full length, or `hoursLeft` if they say so. */
  async useCooldown(actor: Actor, name: string, key: string, hoursLeft?: number): Promise<Outcome> {
    const cd = cooldownByKey(key);
    if (!cd) return { ok: false, error: `Pick one from the list: ${COOLDOWNS.map((c) => c.name).join(', ')}.` };
    const found = this.editable(actor, name);
    if (!found.ok) return found;
    const character = this.characters().find((c) => nameKey(c.name) === found.row.key)!;
    if (!hasCooldown(character, cd)) {
      return { ok: false, error: `${character.name} can’t make ${cd.name} yet, going by what’s logged. Check /mine.` };
    }
    const ms = (hoursLeft ? hoursLeft * 3600 : cd.seconds) * 1000 * this.scale;
    const ends = Date.now() + ms;
    this.sql.exec(
      'INSERT OR REPLACE INTO cooldowns (character, cooldown, ends, notified) VALUES (?, ?, ?, 0)',
      found.row.key,
      cd.key,
      ends,
    );
    await this.changed();
    await this.wake(ends);
    return { ok: true, message: `${character.name}’s ${cd.name} is ready again <t:${Math.floor(ends / 1000)}:R>. I’ll message you then.` };
  }

  /** Cooldowns that have come ready: a message to each owner, once. */
  private async cooldownsReady(now: number) {
    const due = this.timers().filter((t) => t.ends <= now);
    const fresh = due.filter(
      (t) =>
        this.sql.exec(
          'UPDATE cooldowns SET notified = 1 WHERE character = ? AND cooldown = ? AND notified = 0',
          t.key,
          t.cooldown,
        ).rowsWritten,
    );
    if (!fresh.length) return;
    if (this.setting('boardMessage')) this.setSetting('boardDirty', '1');
    const byOwner = new Map<string, CooldownTimer[]>();
    for (const t of fresh) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t]);
    for (const [owner, list] of byOwner) {
      const what = list.map((t) => `${t.character}’s ${t.name}`).join(', ');
      await this.dm(owner, `${what} ${list.length === 1 ? 'is' : 'are'} ready again (${this.guildLabel()}).`);
    }
  }

  // ---------- Stale reminders ----------

  async setReminders(actor: Actor, on: boolean): Promise<Outcome> {
    this.sql.exec(
      'INSERT INTO people (owner, reminders) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET reminders = excluded.reminders',
      actor.id,
      on ? 1 : 0,
    );
    return {
      ok: true,
      message: on
        ? `I’ll message you if your characters go ${STALE_DAYS} days without an update.`
        : 'No more reminders about out-of-date entries. `/mine reminders:True` turns them back on.',
    };
  }

  /** Once a day: anyone whose characters haven't changed in a month gets one message about it, and not
   *  another for a month. */
  private async nudgeStale(now: number) {
    if (!this.env.DISCORD_BOT_TOKEN) return;
    const last = Number(this.setting('nudgeCheck') ?? 0);
    if (now - last < DAY_MS * this.scale) return;
    this.setSetting('nudgeCheck', String(now));
    const staleBefore = now - STALE_DAYS * DAY_MS * this.scale;
    const stale = this.characters().filter((c) => c.updated < staleBefore);
    const byOwner = new Map<string, Character[]>();
    for (const c of stale) byOwner.set(c.owner, [...(byOwner.get(c.owner) ?? []), c]);
    for (const [owner, list] of byOwner) {
      const person = this.sql.exec<{ reminders: number; nudged: number }>('SELECT * FROM people WHERE owner = ?', owner).toArray()[0];
      if (person && (!person.reminders || person.nudged > staleBefore)) continue;
      this.sql.exec(
        'INSERT INTO people (owner, nudged) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET nudged = excluded.nudged',
        owner,
        now,
      );
      const lines = list.map((c) => {
        const skills = Object.entries(c.skills)
          .map(([p, n]) => `${professionName(p as ProfessionId)} ${n}`)
          .join(', ');
        return `- **${c.name}**: ${skills || 'no professions'}`;
      });
      await this.dm(
        owner,
        [
          `Your crafters in ${this.guildLabel()} haven’t changed in ${STALE_DAYS}+ days. Still right?`,
          ...lines,
          'Update with `/prof set`, or `/prof forget` a character you’ve stopped playing. `/mine reminders:False` stops these.',
        ].join('\n'),
      );
    }
  }
}
