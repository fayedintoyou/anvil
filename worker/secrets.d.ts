// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them. Set with
// `wrangler secret put DISCORD_PUBLIC_KEY`; locally, in .dev.vars.
interface Env {
  DISCORD_PUBLIC_KEY?: string;
}
