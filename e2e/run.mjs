// End-to-end run against `wrangler dev` (started here on a fresh store unless BASE is set). Discord is
// played by this script: it signs interactions with its own key, as Discord would, for three people in
// one server, then opens the guild page in real Chrome at phone and desktop sizes. Screenshots land in
// e2e/shots/. Needs a built UI (npm run build) and Chrome (CHROME=/path/to/chrome). Discord's REST API,
// which the board posts to, is played by a small server here too.

import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const CHROME =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_HEX = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');

const CHANNEL = '700000000000000001';
const LOCKED = '700000000000000002'; // a channel anvil hasn't been let into

/** Discord's REST API, as far as the board uses it: records each call, and answers as Discord would. */
async function fakeDiscord() {
  const calls = [];
  let posted = 0;
  const http = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // muster's API, for /raid prep: one poll with 14 people.
    const poll = /^\/api\/polls\/(\w+)$/.exec(req.url);
    if (poll) return poll[1] === 'abcd2345' ? send(200, { poll: { name: 'Thursday BWL' }, people: Array.from({ length: 14 }, (_, n) => ({ id: `p${n}` })) }) : send(404, { error: 'missing' });
    if (req.url.includes(`/channels/${LOCKED}/`)) return send(403, { code: 50013, message: 'Missing Permissions' });
    if (req.url === '/users/@me/channels') return send(200, { id: `dm-${JSON.parse(text).recipient_id}` });
    if (req.method === 'POST') return send(200, { id: `80000000000000000${++posted}` });
    if (req.method === 'DELETE') return send(204);
    return send(200, {});
  });
  // Longer than any gap between calls: otherwise a connection the Worker reuses can be closed under it, and
  // that call fails for reasons that aren't anvil's.
  http.keepAliveTimeout = 120_000;
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${http.address().port}`,
    close: () => http.close(),
    /** The first call so far, or soon, that matches. */
    async waitFor(match, what, timeout = 20_000) {
      for (let waited = 0; waited < timeout; waited += 50) {
        const call = calls.find(match);
        if (call) return call;
        await new Promise((r) => setTimeout(r, 50));
      }
      const recent = calls.slice(-12).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? '').slice(0, 90)}`);
      assert.fail(`Discord never got ${what}. Its last calls:\n${recent.join('\n')}`);
    },
  };
}

/** A fresh `wrangler dev` on its own store, with this run's key and stand-in Discord API, plus `vars`. */
async function startWrangler(vars = []) {
  const store = mkdtempSync(join(tmpdir(), 'anvil-e2e-'));
  const port = 8790 + Math.floor(Math.random() * 200);
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', store];
  const all = [`DISCORD_PUBLIC_KEY:${PUBLIC_HEX}`, `DISCORD_API:${discord.url}`, 'DISCORD_BOT_TOKEN:test-token', 'BOARD_DELAY_MS:300', `MUSTER_API:${discord.url}`, ...vars];
  const proc = spawn('npx', [...args, ...all.flatMap((v) => ['--var', v])], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops wrangler and workerd under npx too.
    detached: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrangler dev did not start')), 60_000);
    const onData = (d) => {
      if (String(d).includes('Ready on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
  // Kept for when something fails: what the Worker logged.
  const log = [];
  const keep = (d) => log.push(...String(d).split('\n').filter(Boolean)) && log.splice(0, Math.max(0, log.length - 80));
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  return {
    base: `http://127.0.0.1:${port}`,
    log,
    stop() {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
      rmSync(store, { recursive: true, force: true });
    },
  };
}

let BASE = process.env.BASE;
let discord;
const servers = [];
if (!BASE) {
  discord = await fakeDiscord();
  servers.push(await startWrangler());
  BASE = servers[0].base;
}

// ---------- Discord, played by this script ----------

const GUILD = '900000000000000001';
const MANAGE_GUILD = String(1 << 5);
const people = {
  faye: { id: '100000000000000001', name: 'Faye', permissions: '0' },
  brakka: { id: '100000000000000002', name: 'Brakka’s player', permissions: '0' },
  officer: { id: '100000000000000003', name: 'Officer', permissions: MANAGE_GUILD },
};

async function post(body, { signature } = {}) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = signature ?? sign(null, Buffer.from(timestamp + text), privateKey).toString('hex');
  return fetch(`${BASE}/interactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': timestamp },
    body: text,
  });
}

function interaction(who, type, name, options, channel = CHANNEL) {
  const p = people[who];
  return {
    type,
    application_id: 'app-1',
    token: `token-${type}-${Date.now()}`,
    guild_id: GUILD,
    channel_id: channel,
    member: { nick: p.name, permissions: p.permissions, user: { id: p.id, username: p.name.toLowerCase() } },
    data: { name, options },
  };
}

const opts = (values) =>
  Object.entries(values).map(([name, value]) => ({ name, type: { number: 4, boolean: 5 }[typeof value] ?? 3, value }));

/** A slash command: `/prof set …` is run('faye', 'prof', 'set', {…}). */
async function run(who, name, sub, values = {}, { channel } = {}) {
  const options = sub ? [{ name: sub, type: 1, options: opts(values) }] : opts(values);
  const response = await post(interaction(who, 2, name, options, channel));
  assert.equal(response.status, 200, `/${name} ${sub ?? ''} answered ${response.status}`);
  const body = await response.json();
  assert.equal(body.type, 4, `/${name} ${sub ?? ''} answered with a message`);
  return { text: body.data.content, ephemeral: body.data.flags === 64, data: body.data };
}

/** Pressing a button on a message: the answer either rewrites that message (7) or is a private reply. */
async function press(who, customId) {
  const i = interaction(who, 3);
  i.data = { custom_id: customId, component_type: 2 };
  const body = await (await post(i)).json();
  return { updated: body.type === 7, text: body.data.content, buttons: (body.data.components?.[0]?.components ?? []).map((c) => c.custom_id), data: body.data };
}

/** A command answered with a pop-up rather than a message (/recipe bulk). */
async function openModal(who, name, sub, values = {}) {
  const options = sub ? [{ name: sub, type: 1, options: opts(values) }] : opts(values);
  const body = await (await post(interaction(who, 2, name, options))).json();
  assert.equal(body.type, 9, `/${name} ${sub ?? ''} opens a pop-up`);
  return body.data;
}

/** Sending the pop-up's text box back, as Discord does when someone presses Submit. */
async function submitModal(who, customId, text) {
  const i = interaction(who, 5);
  i.data = { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: 'text', value: text }] }] };
  const body = await (await post(i)).json();
  assert.ok(body.type === 4 || body.type === 7);
  return { text: body.data.content, ephemeral: body.data.flags === 64, updated: body.type === 7 };
}

/** Autocomplete for the option being typed (`focus`), with the others already filled in. */
async function suggest(who, name, sub, values, focus) {
  const list = opts(values).map((o) => (o.name === focus ? { ...o, focused: true } : o));
  const options = sub ? [{ name: sub, type: 1, options: list }] : list;
  const body = await (await post(interaction(who, 4, name, options))).json();
  assert.equal(body.type, 8);
  return body.data.choices;
}

const MOONCLOTH = '18560'; // tailoring 230, vendor
const MOONCLOTH_ROBE = '22902'; // tailoring 275, vendor
const SILK_BOLT = '3839'; // tailoring 100, trainer
const FIELD_GUIDE = '1262985'; // skinning 140, campsite: a blueprint, so it's logged rather than counted

const errors = [];
const watch = (page, who) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(`${who}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
};
const shot = (page, name, fullPage = true) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage });

const browser = await chromium.launch({ executablePath: CHROME });
try {
  // Discord's own checks: a wrong signature is refused, and a ping is answered.
  assert.equal((await post({ type: 1 }, { signature: '00'.repeat(64) })).status, 401, 'bad signatures are refused');
  assert.deepEqual(await (await post({ type: 1 })).json(), { type: 1 }, 'pings get a pong');

  // Faye logs a tailor-alchemist with cooking. A third primary is turned away.
  let r = await run('faye', 'prof', 'set', { character: 'thalia', profession: 'tailoring', skill: 250 });
  assert.match(r.text, /Thalia: Tailoring 250/, 'names are capitalised as in the game');
  assert.ok(r.ephemeral, 'changes are answered privately');
  await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'alchemy', skill: 300 });
  r = await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'mining', skill: 10 });
  assert.match(r.text, /already has Alchemy and Tailoring|already has Tailoring and Alchemy/, 'two primaries at most');
  r = await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'cooking', skill: 150 });
  assert.match(r.text, /Cooking 150/, 'secondary professions are on top of the two');
  r = await run('faye', 'prof', 'set', { character: 'Thalia 2', profession: 'cooking', skill: 1 });
  assert.match(r.text, /first name of 2 to 12 letters/);
  r = await run('faye', 'prof', 'set', { character: 'faye  ashenward', profession: 'cooking', skill: 1 });
  assert.match(r.text, /Faye Ashenward: Cooking 1/, 'a surname is kept, capitalised, spaces tidied');
  r = await run('faye', 'prof', 'set', { character: 'Faye Ashenward', profession: 'cooking', skill: 5 });
  assert.match(r.text, /Faye Ashenward: Cooking 5/, 'and names the same character next time');
  await run('faye', 'prof', 'forget', { character: 'faye ashenward' });

  // Leaving the character out uses the one you last changed, or your only one.
  r = await run('faye', 'prof', 'set', { profession: 'cooking', skill: 150 });
  assert.match(r.text, /^Thalia: Cooking 150/, 'no name: the character you last changed');
  r = await run('brakka', 'prof', 'set', { profession: 'cooking', skill: 1 });
  assert.match(r.text, /Which character\?/, 'someone with no characters is asked which');
  r = await run('faye', 'prof', 'forget', {});
  assert.match(r.text, /Which character\?/, 'forgetting always needs the name');

  // Autocomplete: your own characters, and only recipes the character could have and needs to log.
  const chars = await suggest('faye', 'recipe', 'add', { character: 'th', recipe: '' }, 'character');
  assert.deepEqual(chars.map((c) => c.value), ['Thalia']);
  const moon = await suggest('faye', 'recipe', 'add', { character: 'Thalia', recipe: 'moonclo' }, 'recipe');
  assert.ok(moon.some((c) => c.value === MOONCLOTH), 'Mooncloth is offered at 250 tailoring');
  assert.ok(!moon.some((c) => c.value === MOONCLOTH_ROBE), 'the robe needs 275, so it isn’t');
  const silk = await suggest('faye', 'recipe', 'add', { character: 'Thalia', recipe: 'bolt of silk' }, 'recipe');
  assert.match(silk[0]?.name ?? '', /Bolt of Silk Cloth · counted from your skill, nothing to log/, 'trainer recipes are listed, saying they count already');
  r = await run('faye', 'recipe', 'add', { character: 'Thalia', recipe: SILK_BOLT });
  assert.match(r.text, /taught by trainers, so Thalia’s Tailoring 250 already counts it/);
  assert.equal((await run('faye', 'mine')).text.includes('Bolt of Silk'), false, 'and nothing is logged');

  r = await run('faye', 'recipe', 'add', { character: 'Thalia', recipe: MOONCLOTH });
  assert.match(r.text, /Logged Mooncloth for Thalia/);
  r = await run('faye', 'recipe', 'add', { character: 'Thalia', recipe: MOONCLOTH_ROBE });
  assert.match(r.text, /needs Tailoring 275, and Thalia has 250/);

  // Someone else can't change Faye's character; an officer can.
  r = await run('brakka', 'prof', 'set', { character: 'Thalia', profession: 'tailoring', skill: 300 });
  assert.match(r.text, /belongs to Faye/);
  await run('brakka', 'prof', 'set', { character: 'Brakka', profession: 'leatherworking', skill: 120 });
  await run('brakka', 'prof', 'set', { character: 'Brakka', profession: 'skinning', skill: 140 });
  await run('brakka', 'prof', 'set', { character: 'Morwen', profession: 'tailoring', skill: 90 });
  r = await run('officer', 'prof', 'set', { character: 'Thalia', profession: 'tailoring', skill: 255 });
  assert.match(r.text, /Tailoring 255/, 'Manage Server can fix anyone’s entry');
  const officerChars = await suggest('officer', 'prof', 'set', { character: '' }, 'character');
  assert.equal(officerChars.length, 3, 'and sees everyone’s characters to pick from');
  r = await run('officer', 'prof', 'set', { profession: 'cooking', skill: 1 });
  assert.match(r.text, /Which character\?/, 'fixing someone’s entry doesn’t make it yours to default to');
  r = await run('brakka', 'prof', 'set', { profession: 'tailoring', skill: 95 });
  assert.match(r.text, /^Morwen: Tailoring 95/, 'with two characters, the one changed last');
  const brakkaMoon = await suggest('brakka', 'recipe', 'add', { recipe: 'moonclo' }, 'recipe');
  assert.equal(brakkaMoon.length, 0, 'autocomplete goes by that character too: Morwen can’t learn Mooncloth');
  await run('brakka', 'prof', 'set', { character: 'Morwen', profession: 'tailoring', skill: 90 });

  // Asking.
  r = await run('brakka', 'whocan', null, { recipe: SILK_BOLT });
  assert.ok(!r.ephemeral, '/whocan answers in the channel');
  assert.match(r.text, /\*\*Thalia\*\* \(<@100000000000000001>\) · Tailoring 255/, 'trainer recipes count from the skill');
  assert.doesNotMatch(r.text, /Morwen/, '90 tailoring is short of the 100 silk needs');
  r = await run('brakka', 'whocan', null, { recipe: MOONCLOTH });
  assert.match(r.text, /\*\*Thalia\*\* \(<@100000000000000001>\) · logged/);
  r = await run('faye', 'whocan', null, { recipe: FIELD_GUIDE });
  assert.match(r.text, /Nobody’s logged this one yet/);
  assert.match(r.text, /learn it if the recipe turns up: Brakka \(140\)/);
  r = await run('faye', 'whocan', null, { recipe: 'mooncloth' });
  assert.ok(r.text.startsWith('[**Mooncloth**](<https://www.wowhead.com/forever/spell=18560>)'), 'a typed name still finds the recipe, linked to Wowhead without a preview');
  assert.match(r.text, /\nTakes: 2 Felcloth\n/, 'and says what it takes');

  // Cooldowns: Thalia has Mooncloth logged, Brakka doesn't.
  const cds = await suggest('faye', 'cooldown', 'used', { cooldown: 'moon' }, 'cooldown');
  assert.deepEqual(cds.map((c) => c.value), ['recipe-18560']);
  r = await run('faye', 'cooldown', 'used', { cooldown: 'recipe-18560', character: 'Thalia' });
  assert.match(r.text, /Thalia’s Mooncloth is ready again <t:\d+:R>/);
  r = await run('brakka', 'cooldown', 'used', { cooldown: 'recipe-18560', character: 'Brakka' });
  assert.match(r.text, /Brakka can’t make Mooncloth yet/);
  r = await run('brakka', 'cooldown', 'list');
  assert.ok(!r.ephemeral);
  assert.match(r.text, /\*\*Thalia\*\* · Mooncloth · ready <t:\d+:R>/);
  const asked = await suggest('faye', 'whocan', null, { recipe: 'flask of the ti' }, 'recipe');
  assert.match(asked[0].name, /Flask of the Titans · Alchemy 300/);

  r = await run('faye', 'crafters', null, { profession: 'tailoring' });
  assert.match(r.text, /2 crafters\n- \*\*Thalia\*\* 255 \(<@100000000000000001>\) · 1 logged recipe\n- \*\*Morwen\*\* 90/);
  r = await run('faye', 'mine');
  assert.match(r.text, /\*\*Thalia\*\*: Alchemy 300, Tailoring 255, Cooking 150\n {2}Logged: Mooncloth/);

  // The page.
  r = await run('faye', 'anvil', null, { title: 'Lamplight' });
  assert.match(r.text, /needs Manage Server/);
  r = await run('officer', 'anvil', null, { title: 'Lamplight Crafters' });
  assert.match(r.text, /^The page is now called \*\*Lamplight Crafters\*\*\./, 'renaming says so');
  // wrangler dev answers as the route's host, as production will; the page itself is loaded from here.
  const pagePath = /https?:\/\/anvil\.fayelore\.com(\/g\/\d+\/[a-z0-9]{12})/.exec(r.text)?.[1];
  assert.ok(pagePath, `the reply links the guild page: ${r.text}`);
  const pageUrl = `${BASE}${pagePath}`;
  const again = await run('faye', 'anvil');
  assert.doesNotMatch(again.text, /now called/, 'no rename, no mention of one');
  assert.ok(again.text.includes(pagePath), 'the link stays the same');

  const html = await (await fetch(pageUrl)).text();
  assert.match(html, /<meta property="og:title" content="Lamplight Crafters"/, 'the link unfurls with the name');
  assert.match(html, /3 characters logged/);
  assert.equal((await fetch(`${pageUrl.slice(0, -12)}aaaaaaaaaaaa`)).status, 404, 'a wrong key shows nothing');
  assert.equal((await fetch(`${BASE}/api/g/${GUILD}/aaaaaaaaaaaa`)).status, 404);

  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await desk.newPage();
  watch(page, 'desk');
  await page.goto(pageUrl);
  await page.waitForSelector('h1.title:text("Lamplight Crafters")');
  assert.equal(await page.locator('.prof[data-prof="tailoring"] li').count(), 2);
  assert.equal(await page.locator('.prof.none').count(), 12 - 5, 'professions nobody has are shown dimmed');
  await shot(page, '01-guild-desk');
  await page.fill('.search', 'moonc');
  await page.click('.matches button:has-text("Mooncloth")');
  await page.waitForSelector('.answer[data-recipe="18560"]');
  assert.match(await page.locator('.answer').innerText(), /Thalia[\s\S]*logged/);
  await page.click('.missing details[data-prof="tailoring"] summary');
  const missing = await page.locator('.missing details[data-prof="tailoring"]').innerText();
  assert.ok(missing.includes('Mooncloth Robe'), 'unlogged recipes are listed');
  assert.ok(!/\nMooncloth\n/.test(missing), 'logged ones aren’t');
  await shot(page, '02-search-missing-desk');

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  watch(p2, 'phone');
  await p2.goto(pageUrl);
  await p2.waitForSelector('.prof-grid');
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `nothing runs off a phone's screen (${overflow}px)`);
  await shot(p2, '03-guild-phone');
  await p2.goto(`${BASE}/`);
  await shot(p2, '04-home-phone');

  // The board: one message in a channel, edited as things change. Only with this run's own wrangler dev,
  // whose Discord API is the stand-in above.
  if (discord) {
    r = await run('faye', 'board');
    assert.match(r.text, /needs Manage Server/);
    r = await run('officer', 'board', null, {}, { channel: LOCKED });
    assert.match(r.text, /can’t post here[\s\S]*View Channel, Send Messages and Embed Links/, 'a channel anvil can’t post in says what to fix');
    r = await run('officer', 'board');
    assert.match(r.text, new RegExp(`board is up in <#${CHANNEL}>`));
    const first = discord.calls.find((c) => c.method === 'POST' && c.path === `/channels/${CHANNEL}/messages`);
    assert.equal(first.auth, 'Bot test-token');
    const [embed] = first.body.embeds;
    assert.equal(embed.title, 'Lamplight Crafters');
    assert.ok(embed.url.endsWith(pagePath), 'the board links the guild page');
    const tailoring = embed.fields.find((f) => f.name.startsWith('Tailoring'));
    assert.equal(tailoring.value, 'Thalia 255 (<@100000000000000001>) · Morwen 90 (<@100000000000000002>)', 'crafters, highest skill first, each tagged to their owner');
    assert.match(tailoring.name, /^Tailoring · 2 · \d+%$/, 'with how much of the profession the guild covers');
    assert.deepEqual(first.body.allowed_mentions, { parse: [] });

    await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'cooking', skill: 160 });
    await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'cooking', skill: 170 });
    const edit = await discord.waitFor(
      (c) => c.method === 'PATCH' && c.path === `/channels/${CHANNEL}/messages/800000000000000001`,
      'an edit to the board',
    );
    const cooking = edit.body.embeds[0].fields.find((f) => f.name.startsWith('Cooking'));
    assert.match(cooking.value, /Thalia 170/, 'the board catches up with a burst of changes');
    assert.equal(discord.calls.filter((c) => c.method === 'PATCH').length, 1, 'in one edit');

    r = await run('officer', 'board', null, {}, { channel: '700000000000000003' });
    assert.match(r.text, /board is up in <#700000000000000003>/);
    await discord.waitFor(
      (c) => c.method === 'DELETE' && c.path === `/channels/${CHANNEL}/messages/800000000000000001`,
      'the old board taken down when it moves',
    );
    r = await run('officer', 'board', null, { stop: true });
    assert.match(r.text, /Took the board down/);
    await discord.waitFor((c) => c.method === 'DELETE' && c.path.endsWith('/800000000000000002'), 'the board taken down');
    const before = discord.calls.length;
    await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'cooking', skill: 150 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(discord.calls.length, before, 'with no board, changes don’t call Discord');
  }

  // Lots to log: a pasted list, then the private checklist page.
  await run('faye', 'prof', 'set', { character: 'Ysolde', profession: 'alchemy', skill: 300 });
  await run('faye', 'prof', 'set', { character: 'Ysolde', profession: 'tailoring', skill: 250 });
  const form = await openModal('faye', 'recipe', 'bulk');
  assert.equal(form.custom_id, 'bulk:Ysolde', 'the paste box is for the character last changed');
  r = await submitModal(
    'faye',
    form.custom_id,
    ['Recipe: Flask of the Titans', '- elixir of the mongoose', '', 'Pattern: Mooncloth Robe', '[Runecloth Bag]', 'Bolt of Silk Cloth', 'Glorbnax the Unfindable'].join('\n'),
  );
  assert.ok(r.ephemeral);
  assert.match(r.text, /Logged 3 for Ysolde: Flask of the Titans, Elixir of the Mongoose, Runecloth Bag\./, 'item prefixes, bullets and brackets are ignored');
  assert.match(r.text, /Already counted from the skill[^\n]*Bolt of Silk Cloth/, 'trainer recipes are said to be counted already');
  assert.match(r.text, /doesn’t have the skill yet: Mooncloth Robe \(Tailoring 275\)/, 'one too high is skipped, not the whole list');
  assert.match(r.text, /Didn’t recognise: “Glorbnax the Unfindable”/);
  r = await submitModal('brakka', 'bulk:Ysolde', 'Runecloth Bag');
  assert.match(r.text, /belongs to Faye/, 'the paste box checks ownership too');

  r = await run('brakka', 'recipe', 'edit', { character: 'Ysolde' });
  assert.match(r.text, /belongs to Faye/);
  r = await run('faye', 'recipe', 'edit', { character: 'Ysolde' });
  assert.ok(r.ephemeral, 'the edit link is only shown to the person');
  const editPath = /https?:\/\/anvil\.fayelore\.com(\/e\/\d+\/[a-z0-9]{24})/.exec(r.text)?.[1];
  assert.ok(editPath, `the reply links the checklist: ${r.text}`);
  const editPage = await phone.newPage();
  watch(editPage, 'edit');
  await editPage.goto(`${BASE}${editPath}`);
  await editPage.waitForSelector('h1.title:text("Ysolde’s recipes")');
  assert.ok(await editPage.locator('input[data-recipe="17635"]').isChecked(), 'what’s logged is ticked');
  assert.equal(await editPage.locator('input[data-recipe="22902"]').count(), 0, 'what needs more skill isn’t listed');
  assert.equal(await editPage.locator('input[data-recipe="3839"]').count(), 0, 'nor trainer recipes');
  // Essentials first, open, with a count; everything else behind "show the rest".
  assert.match(await editPage.locator('[data-essentials]').innerText(), /^Essentials: \d+ of \d+ ticked/);
  assert.ok(await editPage.locator('section[data-prof="alchemy"] > .ticks input[data-recipe="17635"]').isVisible(), 'an essential is open');
  assert.equal(await editPage.locator('section[data-prof="tailoring"] details.more').getAttribute('open'), null, 'the rest starts closed');
  await shot(editPage, '05-edit-start-phone', false);
  const editDesk = await desk.newPage();
  await editDesk.goto(`${BASE}${editPath}`);
  await editDesk.waitForSelector('[data-essentials]');
  await shot(editDesk, '05-edit-start-desk');
  await editDesk.close();
  await editPage.locator('input[data-recipe="17571"]').uncheck();
  await editPage.fill('.search', 'cloth');
  assert.notEqual(await editPage.locator('section[data-prof="tailoring"] details.more').getAttribute('open'), null, 'a filter opens the rest');
  const extra = editPage.locator('section[data-prof="tailoring"] input:not(:checked)').first();
  const extraId = Number(await extra.getAttribute('data-recipe'));
  await extra.check();
  assert.match(await editPage.locator('.savebar').innerText(), /2 changes to save/);
  await shot(editPage, '05-edit-phone', false);
  await editPage.click('.savebar button');
  await editPage.waitForSelector('.savebar:has-text("Saved: logged 1, took off 1.")');
  const saved = await (await fetch(`${BASE}/api${editPath}`)).json();
  assert.ok(saved.character.recipes.includes(extraId) && !saved.character.recipes.includes(17571), 'the save is kept');
  const overflowEdit = await editPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowEdit <= 0, `the checklist fits a phone (${overflowEdit}px)`);
  // An expired link's 404 is expected here, so this page isn't watched for console errors.
  const expired = await phone.newPage();
  await expired.goto(`${BASE}/e/${GUILD}/${'a'.repeat(24)}`);
  await expired.waitForSelector('h1.title:text("This link has expired")');
  assert.equal((await fetch(`${BASE}/api/e/${GUILD}/${'a'.repeat(24)}`, { method: 'POST', body: '{"add":[1]}' })).status, 404);

  // Asking for something: the people who can make it are pinged, and nobody else.
  r = await run('brakka', 'want', null, { recipe: '17635', note: 'I have the mats' });
  assert.ok(!r.ephemeral, '/want is said in the channel');
  assert.match(r.text, new RegExp(`^<@${people.brakka.id}> is looking for \\[\\*\\*Flask of the Titans\\*\\*\\]\\(<https://www\\.wowhead\\.com/forever/spell=17635>\\)`));
  assert.match(r.text, /“I have the mats”/);
  assert.ok(r.text.includes(`<@${people.faye.id}> can make it (Ysolde).`), 'Thalia has the skill but hasn’t logged it');
  assert.deepEqual(r.data.allowed_mentions, { parse: [], users: [people.faye.id] }, 'only the crafters are pinged');
  assert.match(r.text, /Takes: [^\n]*Gromsblood/, 'with what it takes');
  const [claim, cancel] = r.data.components[0].components.map((c) => c.custom_id);
  assert.match(claim, /^req:\d+:claim$/);
  assert.match(cancel, /^req:\d+:cancel$/);
  let b = await press('faye', claim);
  assert.ok(b.updated, 'taking a request on rewrites the post');
  assert.match(b.text, new RegExp(`<@${people.faye.id}> is making it`));
  assert.deepEqual(b.data.allowed_mentions, { parse: [] }, 'rewrites ping nobody');
  const [done, noteButton, unclaim] = b.buttons;
  b = await press('faye', noteButton);
  assert.equal(b.data.custom_id, `reqnote:${claim.split(':')[1]}`, 'the crafter’s note opens a pop-up');
  r = await submitModal('brakka', b.data.custom_id, 'cheap');
  assert.match(r.text, /Only Faye can add a note/);
  r = await submitModal('faye', b.data.custom_id, 'Free for guild');
  assert.ok(r.updated);
  assert.match(r.text, /\n> Faye: Free for guild$/, 'the note shows under who’s making it');
  b = await press('officer', claim);
  assert.ok(!b.updated);
  assert.match(b.text, /Faye is already making it/);
  b = await press('brakka', unclaim);
  assert.match(b.text, /Only Faye can let this one go/);
  b = await press('faye', done);
  assert.ok(b.updated);
  assert.match(b.text, new RegExp(`Made by <@${people.faye.id}>`));
  assert.deepEqual(b.buttons, [], 'a finished request has no buttons');
  const ping = await discord.waitFor((c) => c.method === 'POST' && c.path === '/webhooks/app-1/' + c.path.split('/').pop() && c.body?.content?.includes('is ready'), 'the asker pinged');
  assert.match(ping.body.content, new RegExp(`^<@${people.brakka.id}> your \\*\\*Flask of the Titans\\*\\* is ready, from <@${people.faye.id}>`));
  assert.deepEqual(ping.body.allowed_mentions, { parse: [], users: [people.brakka.id] });
  b = await press('faye', done);
  assert.match(b.text, /already done/);

  r = await run('faye', 'want', null, { recipe: '17635' });
  assert.match(r.text, /Only your own characters can make it/);

  // Bounties: officers only, and only for what nobody can make yet.
  r = await run('brakka', 'bounty', 'add', { recipe: MOONCLOTH_ROBE, reward: '50g' });
  assert.match(r.text, /needs Manage Server/);
  r = await run('officer', 'bounty', 'add', { recipe: MOONCLOTH });
  assert.match(r.text, /Thalia can already make Mooncloth/);
  r = await run('officer', 'bounty', 'add', { recipe: MOONCLOTH_ROBE, reward: '50g' });
  assert.match(r.text, /Bounty up for Mooncloth Robe \(50g\)/);
  r = await run('brakka', 'bounty', 'list');
  assert.match(r.text, /\*\*Wanted\*\*\n- Mooncloth Robe · 50g/);

  // Links and batches: a Wowhead link to the item made, or to the spell, finds the recipe.
  r = await run('brakka', 'whocan', null, { recipe: 'https://www.wowhead.com/forever/item=14342/mooncloth' });
  assert.ok(r.text.startsWith('[**Mooncloth**]'), 'an item link finds the recipe that makes it');
  const linked = await suggest('brakka', 'whocan', null, { recipe: 'https://www.wowhead.com/forever/spell=17635' }, 'recipe');
  assert.deepEqual(linked.map((c) => c.value), ['17635']);
  r = await run('brakka', 'want', null, { recipe: MOONCLOTH, quantity: 3 });
  assert.match(r.text, /looking for 3 × \[\*\*Mooncloth\*\*\]/);
  assert.match(r.text, /Takes: 6 Felcloth \(3 crafts\)/, 'what a batch takes');

  // Levelling: what still gives points, with what someone's asked for first.
  r = await run('faye', 'level', null, { profession: 'tailoring', character: 'Thalia' });
  assert.match(r.text, /^\*\*Thalia\*\* · Tailoring 255/);
  assert.match(r.text, /Skill-ups someone’s asked for[^\n]*\n- \*\*Mooncloth\*\* · orange/, 'an open request that’s also a skill-up comes first');
  assert.doesNotMatch(r.text, /Orange \(always\): Mooncloth/, 'and isn’t listed twice');
  r = await run('brakka', 'alt');
  assert.ok(!r.ephemeral);
  assert.match(r.text, /^\*\*Professions the guild is short of\*\*/);
  assert.match(r.text, /- Blacksmithing: nobody/);

  // Raid prep, counting heads from a muster poll.
  r = await run('officer', 'raid', 'prep', { raid: 'bwl', muster: 'https://muster.fayelore.com/e/abcd2345' });
  assert.ok(!r.ephemeral, 'raid prep is posted for everyone');
  assert.match(r.text, /^\*\*Blackwing Lair prep\*\* · 14 signed up on “Thursday BWL”/, 'the headcount comes from muster');
  assert.match(r.text, /- \*\*Flask of the Titans\*\* × 2 · Ysolde can make it\n {2}Takes [^\n]*Gromsblood/, 'one in ten, rounded up, with who and what it takes');
  assert.match(r.text, /- \*\*Elixir of the Mongoose\*\* × 7 · \*\*nobody can make it yet\*\*/);
  assert.match(r.text, /Resistance gear nobody can make yet: Enchant Cloak - Greater Fire Resistance \(Enchanting 300\)/);
  const ask = r.data.components[0].components.find((c) => c.custom_id === 'prep:17635:2');
  assert.ok(ask, 'a button to ask for what someone can make');
  b = await press('brakka', ask.custom_id);
  assert.ok(!b.updated, 'pressing it posts a new request');
  assert.match(b.text, /looking for 2 × \[\*\*Flask of the Titans\*\*\][^\n]*: “for the raid”/);
  assert.match(b.buttons[0], /^req:\d+:claim$/);
  r = await run('officer', 'raid', 'prep', { raid: 'mc', raiders: 25 });
  assert.match(r.text, /^\*\*Molten Core prep\*\* · 25 raiders/);
  r = await run('officer', 'raid', 'prep', { raid: 'mc', muster: 'not a link' });
  assert.match(r.text, /doesn’t look like a muster link/);
  r = await run('officer', 'raid', 'prep', { raid: 'mc', muster: 'https://muster.fayelore.com/e/zzzz9999' });
  assert.match(r.text, /muster doesn’t have that poll/);
  assert.deepEqual(r.data.allowed_mentions.users, [], 'nobody pings themselves');

  // A reply that would pass Discord's 2,000 characters ends at a whole line instead.
  for (const name of ['Aela', 'Brinn', 'Cass', 'Dov', 'Eir', 'Fen', 'Gale', 'Hest', 'Ivo', 'Jun', 'Kell', 'Lio', 'Mara']) {
    await run('faye', 'prof', 'set', { character: name, profession: 'cooking', skill: 300 });
    for (const recipe of await suggest('faye', 'recipe', 'add', { character: name, recipe: 'a' }, 'recipe')) {
      await run('faye', 'recipe', 'add', { character: name, recipe: recipe.value });
    }
  }
  r = await run('faye', 'mine');
  assert.ok(r.text.length <= 2000 && r.text.endsWith('\n…'), `long replies are cut (${r.text.length})`);

  // Tidying up: dropping a profession takes its logged recipes; forgetting takes the character.
  r = await run('faye', 'prof', 'drop', { character: 'Thalia', profession: 'tailoring' });
  assert.match(r.text, /Dropped Tailoring and 1 logged recipe from Thalia/);
  r = await run('faye', 'prof', 'forget', { character: 'Brakka' });
  assert.match(r.text, /belongs to Brakka’s player/);
  r = await run('brakka', 'prof', 'forget', { character: 'Brakka' });
  assert.match(r.text, /Forgot Brakka/);
  r = await run('faye', 'whocan', null, { recipe: MOONCLOTH });
  assert.match(r.text, /Nobody’s logged this one yet/);

  // Time passing, on a second wrangler dev where a day is 86 ms: a cooldown coming ready, a month-old
  // entry, and a board's requests and cooldowns.
  if (discord) {
    servers.push(await startWrangler(['TIME_SCALE:0.000001']));
    BASE = servers[1].base;
    const from = discord.calls.length;
    const since = (match) => discord.calls.slice(from).filter(match);
    await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'tailoring', skill: 250 });
    await run('faye', 'recipe', 'add', { character: 'Thalia', recipe: MOONCLOTH });
    await run('brakka', 'prof', 'set', { character: 'Brakka', profession: 'leatherworking', skill: 260 });
    r = await run('brakka', 'mine', null, { reminders: false });
    assert.match(r.text, /No more reminders/);
    r = await run('officer', 'board');
    assert.match(r.text, /board is up/);
    // A first for the guild, with a bounty on it, and a request filled: all for Sunday's digest.
    await run('officer', 'bounty', 'add', { recipe: '17635', reward: '50g' });
    await run('faye', 'prof', 'set', { character: 'Thalia', profession: 'alchemy', skill: 300 });
    await run('faye', 'recipe', 'add', { character: 'Thalia', recipe: '17635' });
    const first = await discord.waitFor(
      (c) => discord.calls.indexOf(c) >= from && c.method === 'POST' && /just learned/.test(c.body?.content ?? ''),
      'a first announced',
    );
    assert.match(first.body.content, /^🎉 Thalia just learned \*\*Flask of the Titans\*\*: a first for the guild! Alchemy is now \d+% covered\.$/);
    assert.equal(first.path, `/channels/${CHANNEL}/messages`, 'in the board’s channel');
    await discord.waitFor((c) => discord.calls.indexOf(c) >= from && /🎯 Bounty found: Thalia brought in \*\*Flask of the Titans\*\* \(50g\)/.test(c.body?.content ?? ''), 'the bounty called out');
    r = await run('brakka', 'want', null, { recipe: '17635' });
    const [claimIt] = r.data.components[0].components.map((c) => c.custom_id);
    const taken = await press('faye', claimIt);
    await press('faye', taken.buttons[0]);
    const digest = await discord.waitFor(
      (c) => discord.calls.indexOf(c) >= from && /This week in the guild’s workshop/.test(c.body?.content ?? ''),
      'the weekly digest',
    );
    assert.match(digest.body.content, /Skill-ups: [^\n]*Thalia · Alchemy \+300/);
    assert.match(digest.body.content, /firsts for the guild \([^)]*Flask of the Titans/);
    assert.match(digest.body.content, /🏆 Crafter of the week: \*\*Faye\*\*, with 1 filled/);
    r = await run('brakka', 'cooldown', 'used', { cooldown: 'salt-shaker' });
    assert.match(r.text, /Brakka’s Salt Shaker is ready again/, 'any leatherworker at 250 can have the Salt Shaker');
    r = await run('faye', 'cooldown', 'used', { cooldown: 'recipe-18560' });
    assert.match(r.text, /Mooncloth is ready again/, 'the cooldown is started for the character Faye last used');
    await run('brakka', 'want', null, { recipe: MOONCLOTH });

    const ready = await discord.waitFor(
      (c) => discord.calls.indexOf(c) >= from && c.path === `/channels/dm-${people.faye.id}/messages` && /Mooncloth is ready again/.test(c.body.content),
      'a message when the cooldown is ready',
    );
    assert.match(ready.body.content, /^Thalia’s Mooncloth is ready again/);
    const nudge = await discord.waitFor(
      (c) => discord.calls.indexOf(c) >= from && c.path === `/channels/dm-${people.faye.id}/messages` && /haven’t changed/.test(c.body.content),
      'a reminder about a month-old entry',
    );
    assert.match(nudge.body.content, /- \*\*Thalia\*\*: Tailoring 250/);
    assert.match(nudge.body.content, /`\/mine reminders:False` stops these/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
      since((c) => c.path === `/channels/dm-${people.brakka.id}/messages` && /haven’t changed/.test(c.body.content)).length,
      0,
      'someone who turned reminders off gets none',
    );
    assert.equal(since((c) => /Mooncloth is ready again/.test(c.body?.content ?? '')).length, 1, 'a cooldown is announced once');
    const board = since((c) => c.method === 'PATCH').pop();
    const fields = board.body.embeds[0].fields;
    assert.match(fields.find((f) => f.name.startsWith('Requests')).value, /Mooncloth for Brakka’s player \(<@100000000000000002>\) · open/);
    assert.match(fields.find((f) => f.name === 'Cooldowns').value, /Thalia · Mooncloth · \*\*ready\*\*/);
  }

  console.log(`ok: ${pageUrl}`);
} catch (e) {
  for (const [n, s] of servers.entries()) console.error(`\n--- wrangler dev ${n + 1}, last lines ---\n${s.log.join('\n')}`);
  throw e;
} finally {
  await browser.close();
  discord?.close();
  for (const s of servers) s.stop();
}

if (errors.length) {
  console.error(`Console errors:\n${errors.join('\n')}`);
  process.exit(1);
}
