// The small part of Discord's interactions API anvil uses: signature checks, and the shapes of what
// arrives and what goes back. https://discord.com/developers/docs/interactions/receiving-and-responding

export const InteractionType = { Ping: 1, Command: 2, Component: 3, Autocomplete: 4, ModalSubmit: 5 } as const;
export const ResponseType = { Pong: 1, Message: 4, UpdateMessage: 7, Choices: 8, Modal: 9 } as const;
export const OptionType = { Subcommand: 1, String: 3, Integer: 4, Boolean: 5 } as const;
const EPHEMERAL = 1 << 6;
const MANAGE_GUILD = 1n << 5n;

export interface Option {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
  options?: Option[];
}

export interface Interaction {
  type: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { nick?: string | null; permissions?: string; user: DiscordUser };
  user?: DiscordUser;
  data?: { name: string; options?: Option[]; custom_id?: string; components?: { components: { custom_id: string; value: string }[] }[] };
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Actor {
  id: string;
  name: string;
  /** Has Manage Server: may change anyone's characters. */
  manager: boolean;
}

export function actorOf(i: Interaction): Actor | undefined {
  const m = i.member;
  if (!m) return undefined;
  let manager = false;
  try {
    manager = m.permissions !== undefined && (BigInt(m.permissions) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    manager = false;
  }
  return { id: m.user.id, name: m.nick || m.user.global_name || m.user.username, manager };
}

/** The command's own options, under its subcommand if it has one. */
export function commandOptions(i: Interaction): { sub?: string; options: Option[] } {
  const top = i.data?.options ?? [];
  const sub = top.find((o) => o.type === OptionType.Subcommand);
  return sub ? { sub: sub.name, options: sub.options ?? [] } : { options: top };
}

/** Discord refuses a message over 2,000 characters, so a long one ends at the last whole line that fits. */
const MAX_MESSAGE = 2000;

/** A reply. Nobody is pinged unless `mention` lists them (and then only them). */
export function message(content: string, { ephemeral = true, mention = [] as string[] } = {}) {
  if (content.length > MAX_MESSAGE) {
    const cut = content.slice(0, MAX_MESSAGE - 2);
    content = `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))}\n…`;
  }
  return {
    type: ResponseType.Message,
    data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [], users: mention.slice(0, 100) } },
  };
}

export function choices(list: { name: string; value: string }[]) {
  return {
    type: ResponseType.Choices,
    data: { choices: list.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) })) },
  };
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Discord signs every interaction with the application's key; anything that fails is turned away,
 *  as Discord's own checks require. */
export async function verify(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature) || !/^[0-9a-f]{64}$/i.test(publicKey)) {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hexBytes(signature), new TextEncoder().encode(timestamp + body));
}

/** A call to Discord's REST API as the bot, for the board: the one thing anvil does that isn't a reply.
 *  DISCORD_API is only set by the end-to-end run, which plays Discord's API too. */
export function discordApi(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${env.DISCORD_API ?? 'https://discord.com/api/v10'}${path}`, {
    method,
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A pop-up with one big text box. Its answer comes back as a ModalSubmit carrying `id`. */
export function modal(id: string, title: string, label: string, placeholder: string) {
  return {
    type: ResponseType.Modal,
    data: {
      custom_id: id.slice(0, 100),
      title: title.slice(0, 45),
      components: [
        {
          type: 1,
          components: [
            { type: 4, custom_id: 'text', style: 2, label: label.slice(0, 45), placeholder: placeholder.slice(0, 100), required: true, max_length: 4000 },
          ],
        },
      ],
    },
  };
}

export function modalText(i: Interaction): string {
  return i.data?.components?.flatMap((row) => row.components).find((c) => c.custom_id === 'text')?.value ?? '';
}

export interface Button {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };

/** One row of buttons, for a message's `components`. */
export function buttons(list: Button[]) {
  return list.length
    ? [{ type: 1, components: list.map((b) => ({ type: 2, custom_id: b.id, label: b.label, style: BUTTON_STYLE[b.style] })) }]
    : [];
}

/** The reply to a button press that rewrites the message the button is on. Edits never ping anyone. */
export function updateMessage(content: string, components: unknown[]) {
  return { type: ResponseType.UpdateMessage, data: { content, components, allowed_mentions: { parse: [] } } };
}

/** A further message after replying to an interaction, through its token (no bot token needed). Unlike an
 *  edit, it pings whoever `mention` lists. */
export function followUp(env: Env, i: Interaction, content: string, mention: string[]): Promise<Response> {
  return fetch(`${env.DISCORD_API ?? 'https://discord.com/api/v10'}/webhooks/${i.application_id}/${i.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [], users: mention } }),
  });
}
