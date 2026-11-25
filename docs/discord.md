# The Discord application

anvil is a Discord application that receives slash commands over HTTPS at
`https://anvil.fayelore.com/interactions`. It doesn't hold a gateway connection or run all the time, so it
needs no bot token at runtime: only the application's public key, to check that each request came from
Discord.

## Making it (once)

1. At https://discord.com/developers/applications, **New Application**, named `anvil`. Its icon is
   `public/icon.png` (https://anvil.fayelore.com/icon.png), drawn in `public/icon.svg`.
2. **General Information**: copy the **Application ID** (`1575223128731418746`) and the **Public Key**.
3. Give the Worker the public key, without showing it:
   ```sh
   npx wrangler secret put DISCORD_PUBLIC_KEY      # paste the Public Key
   ```
4. Still on **General Information**, set **Interactions Endpoint URL** to
   `https://anvil.fayelore.com/interactions` and save. Discord sends a signed ping and a badly signed one
   first; the save only succeeds if the Worker is deployed and has the key.
5. **Bot**: **Reset Token** and keep it for the next step. Nothing else on that page is needed: anvil
   doesn't read messages, so it needs no privileged intents.
6. Register the commands: add the token as the repository secret `DISCORD_BOT_TOKEN` (GitHub → Settings →
   Secrets and variables → Actions). Every deploy of `main` then registers them globally, which can take
   an hour to show; rerun the latest "test and deploy" run to register at once. From a machine with the
   token instead:
   ```sh
   DISCORD_APP_ID=1575223128731418746 DISCORD_BOT_TOKEN=… npm run register              # every server
   DISCORD_APP_ID=1575223128731418746 DISCORD_BOT_TOKEN=… npm run register -- <server>   # one server, at once
   ```
7. **Installation**: under Guild Install, the scopes `applications.commands` (and `bot`, for an icon in the
   member list) with no permissions. Open the install link and add anvil to the guild's server.

Then, in the server: `/anvil` for help and the page link, `/prof set` to start.

## Locally

`.dev.vars` (not committed) holds `DISCORD_PUBLIC_KEY=` for `npm run dev`. To try real Discord against a
local Worker, point the Interactions Endpoint URL at a tunnel (`cloudflared tunnel --url
http://localhost:8787`) with `/interactions` on the end, and set it back afterwards. `npm run test:e2e`
needs none of this: it makes its own key and signs as Discord does.

## Commands

The list lives in `worker/commands.ts`. After changing it, deploy, then run `npm run register` again.
Global changes reach every server within about an hour; a server-only registration shows at once, but
then appears twice next to the global one, so remove it once you're done testing (register an empty list:
edit the script, or use the developer portal).
