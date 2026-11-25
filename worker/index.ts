import { GuildObject } from './guild-object';
import { InteractionType, ResponseType, verify, type Interaction } from './discord';
import { autocomplete, command } from './handlers';

export { GuildObject };

const MAX_BODY = 64 * 1024;
const GUILD_ID = /^\d{5,25}$/;
const PAGE_KEY = /^[a-z0-9]{12}$/;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Discord's interactions endpoint: slash commands and their autocomplete, each signed by Discord. */
async function interactions(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const body = await request.text();
  if (body.length > MAX_BODY) return new Response('Too large.', { status: 413 });
  if (!(await verify(request, body, env.DISCORD_PUBLIC_KEY ?? ''))) {
    return new Response('Bad signature.', { status: 401 });
  }
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
  if (interaction.type === InteractionType.Autocomplete) return json(await autocomplete(env, interaction));
  if (interaction.type === InteractionType.Command) return json(await command(env, interaction, url.origin));
  return new Response('Unknown interaction.', { status: 400 });
}

/** /g/<server>/<key>, the guild page's address. The key is made by /anvil and keeps the page unlisted. */
async function guildFor(env: Env, parts: string[]) {
  const [id, key] = parts;
  if (!GUILD_ID.test(id ?? '') || !PAGE_KEY.test(key ?? '')) return undefined;
  const g = env.GUILDS.getByName(id);
  return (await g.checkPageKey(key)) ? g : undefined;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The guild page: the app's own HTML, with the guild's name and counts so its link unfurls in Discord. */
async function guildPage(request: Request, env: Env, url: URL): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  const headers = new Headers(shell.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  const g = await guildFor(env, url.pathname.split('/').slice(2));
  if (!g) return new Response(shell.body, { status: 404, headers });
  const roster = await g.roster();
  const title = roster.guildName || 'Guild crafters';
  const people = roster.characters.length;
  const description = `${people} character${people === 1 ? '' : 's'} logged. Who can craft what, and which recipes nobody has yet.`;
  const setContent = (value: string) => ({
    element(el: Element) {
      el.setAttribute('content', escapeAttr(value));
    },
  });
  return new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(`${title} · anvil`) })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(url.href))
    .transform(new Response(shell.body, { status: 200, headers }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/interactions') return await interactions(request, env, url);
      if (url.pathname.startsWith('/api/g/') && request.method === 'GET') {
        const g = await guildFor(env, url.pathname.split('/').slice(3));
        return g ? json(await g.roster()) : json({ error: 'This page doesn’t exist.' }, 404);
      }
      if (url.pathname.startsWith('/g/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return await guildPage(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
