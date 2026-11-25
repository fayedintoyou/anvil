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
    if (req.url.includes(`/channels/${LOCKED}/`)) return send(403, { code: 50013, message: 'Missing Permissions' });
    if (req.method === 'POST') return send(200, { id: `80000000000000000${++posted}` });
    if (req.method === 'DELETE') return send(204);
    return send(200, {});
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${http.address().port}`,
    close: () => http.close(),
    /** The first call so far, or soon, that matches. */
    async waitFor(match, what) {
      for (let waited = 0; waited < 10_000; waited += 50) {
        const call = calls.find(match);
        if (call) return call;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail(`Discord never got ${what}`);
    },
  };
}

let BASE = process.env.BASE;
let server;
let store;
let discord;
if (!BASE) {
  discord = await fakeDiscord();
  store = mkdtempSync(join(tmpdir(), 'anvil-e2e-'));
  const port = 8790 + Math.floor(Math.random() * 200);
  BASE = `http://127.0.0.1:${port}`;
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', store];
  const vars = [`DISCORD_PUBLIC_KEY:${PUBLIC_HEX}`, `DISCORD_API:${discord.url}`, 'DISCORD_BOT_TOKEN:test-token', 'BOARD_DELAY_MS:300'];
  server = spawn('npx', [...args, ...vars.flatMap((v) => ['--var', v])], {
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
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
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
  assert.equal(body.type, 4);
  return { text: body.data.content, ephemeral: body.data.flags === 64 };
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
const CAMP_TENT = '1229432'; // leatherworking 20, campsite

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
  assert.equal(silk.length, 0, 'trainer recipes don’t need logging, so they aren’t offered');

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
  assert.match(r.text, /\*\*Thalia\*\* \(Faye\) · Tailoring 255/, 'trainer recipes count from the skill');
  assert.doesNotMatch(r.text, /Morwen/, '90 tailoring is short of the 100 silk needs');
  r = await run('brakka', 'whocan', null, { recipe: MOONCLOTH });
  assert.match(r.text, /\*\*Thalia\*\* \(Faye\) · logged/);
  r = await run('faye', 'whocan', null, { recipe: CAMP_TENT });
  assert.match(r.text, /Nobody’s logged this one yet/);
  assert.match(r.text, /learn it if the recipe turns up: Brakka \(120\)/);
  r = await run('faye', 'whocan', null, { recipe: 'mooncloth' });
  assert.match(r.text, /^\*\*Mooncloth\*\*/, 'a typed name still finds the recipe');
  const asked = await suggest('faye', 'whocan', null, { recipe: 'flask of the ti' }, 'recipe');
  assert.match(asked[0].name, /Flask of the Titans · Alchemy 300/);

  r = await run('faye', 'crafters', null, { profession: 'tailoring' });
  assert.match(r.text, /2 crafters\n- \*\*Thalia\*\* 255 \(Faye\) · 1 logged recipe\n- \*\*Morwen\*\* 90/);
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
    assert.deepEqual(
      embed.fields.find((f) => f.name.startsWith('Tailoring')),
      { name: 'Tailoring · 2', value: 'Thalia 255 · Morwen 90' },
      'crafters, highest skill first',
    );
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

  console.log(`ok: ${pageUrl}`);
} finally {
  await browser.close();
  discord?.close();
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    server.stdout.destroy();
    server.stderr.destroy();
    server.unref();
  }
  if (store) rmSync(store, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`Console errors:\n${errors.join('\n')}`);
  process.exit(1);
}
