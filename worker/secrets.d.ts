// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them. DISCORD_PUBLIC_KEY is set with
// `wrangler secret put`; DISCORD_BOT_TOKEN by the deploy, from the repository secret of that name. Locally,
// both come from .dev.vars. DISCORD_API, BOARD_DELAY_MS, TIME_SCALE and MUSTER_API are only for the end-to-end run.
interface Env {
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_API?: string;
  BOARD_DELAY_MS?: string;
  TIME_SCALE?: string;
  MUSTER_API?: string;
}
