# Deploying to anvil.fayelore.com

anvil is one Cloudflare Worker named `anvil`, made the same way as muster. It serves the built page from
`dist/` as static assets, takes Discord's interactions at `/interactions`, answers `/api/g/*`, and fills
in each guild page's link preview. Each Discord server's data lives in its own SQLite-backed Durable
Object (`GuildObject`), named by the server's id. There's no database to create: `wrangler deploy` makes
the Worker, the Durable Object class and the `anvil.fayelore.com` custom domain from `wrangler.jsonc`.

Everything fits the Workers Free plan by a wide margin: a guild sends a few hundred commands a day at most.

## How it deploys

Every push to `main` runs the tests (unit, typecheck and the Chrome e2e run), then `npm run deploy`
(`.github/workflows/deploy.yml`). Other branches and pull requests run the tests only. Like muster, the
repository is public and its jobs run on GitHub's own machines.

The Discord public key is a Worker secret, set once with `npx wrangler secret put DISCORD_PUBLIC_KEY`
(docs/discord.md); deploys keep it. Until it's set, `/interactions` refuses everything, and the rest of
the site works.

## One-time setup

The CI secrets are the same Cloudflare token and account ID as muster's, from the Mac's login Keychain:

```sh
for s in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  security find-generic-password -a "$USER" -s $s -w | tr -d '\n' | gh secret set $s -R fayedintoyou/anvil
done
gh workflow run deploy.yml -R fayedintoyou/anvil --ref main
```

To deploy by hand from the Mac instead: `npm ci && npm run deploy`.

## Checking

```sh
gh run list -R fayedintoyou/anvil -w "test and deploy" -L 1
curl -sI https://anvil.fayelore.com                                    # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://anvil.fayelore.com/interactions   # 401: unsigned
npx wrangler tail anvil                                                # live logs
```

## Data

- A server's object holds its characters' names, professions, skills and logged recipes, and for each
  character the Discord id and display name of the person who logged it. Nothing else: anvil doesn't
  read messages or member lists.
- The guild page is at `/g/<server id>/<key>`, the key random and made by the first `/anvil`. Anyone with
  the link can read the page; nobody can change anything from it. Pages send `X-Robots-Tag: noindex`.
- To wipe a server's data, delete its characters with `/prof forget`, or ask Faye.
