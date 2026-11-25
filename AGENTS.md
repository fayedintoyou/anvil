# Working on anvil

- `src/core/` stays free of React, the DOM and Worker APIs: the page and the Worker both import it.
  `worker/commands.ts` and `src/core/types.ts` are also loaded by plain Node (`npm run register`), so they
  import only each other, with `.ts` extensions.
- A recipe's id is the crafting spell's id, and logged recipes are stored by it. Don't renumber, and keep
  `scripts/recipes.mjs` producing spell ids. Profession ids (`firstaid`, …) are stored too.
- `src/core/recipes.json` is generated: change `scripts/recipes.mjs` and run `npm run recipes`, never edit
  it by hand. Moving the pinned commits there is how the list gets updated for a new game patch.
- Only `trainer` recipes are assumed known from a skill level. When unsure how a recipe is learned, leave
  it not `trainer`: then it must be logged, which is better than claiming someone can make it.
- The Worker's rules are the real ones: Discord's options are suggestions, so everything is checked again
  in `worker/handlers.ts` and `worker/guild-object.ts`. In the Durable Object, keep each change's reads and
  writes free of any `await` between them, so two people at once can't lose a change.
- Every request to `/interactions` must pass the Ed25519 signature check before anything else; Discord
  tests this when the endpoint is saved and disables endpoints that don't refuse bad signatures.
- Changing `worker/commands.ts` means running `npm run register` (docs/discord.md) after it deploys.
- Renaming or replacing the Durable Object class needs a new entry in `migrations` in `wrangler.jsonc`.
  After changing bindings, run `npm run types`.
- Before pushing: `npm test`, `npm run typecheck`, and `npm run test:e2e`. For any change to how the page
  looks, look at the screenshots in `e2e/shots/` at phone and desktop sizes, and put taste calls in the
  pull request for Faye rather than settling them.
- The look follows the room (fayelore.com) and muster: `--night`, `--lamp`, `--moon`, Fraunces and IBM
  Plex Mono, lowercase controls.
- Dependencies earn their way in; add one only when a change needs it.
