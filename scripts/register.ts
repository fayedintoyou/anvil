// Registers anvil's slash commands with Discord. Run once after creating the application, and again
// whenever worker/commands.ts changes:
//
//   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register             (global: every server, ~1 hour)
//   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register -- <server>  (one server, at once: for testing)

import { COMMANDS } from '../worker/commands.ts';

const app = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!app || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (docs/discord.md).');
  process.exit(1);
}
const guild = process.argv[2];
const url = guild
  ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${app}/commands`;

const response = await fetch(url, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
if (!response.ok) {
  console.error(`Discord answered ${response.status}: ${await response.text()}`);
  process.exit(1);
}
const saved = (await response.json()) as { name: string }[];
console.log(`Registered ${saved.map((c) => `/${c.name}`).join(', ')} ${guild ? `in server ${guild}` : 'globally'}.`);
