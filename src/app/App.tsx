import { GuildPage } from './GuildPage';

// Two pages, so no router: '/' says what anvil is, '/g/<server>/<key>' is a guild's page.

export function App() {
  const guild = /^\/g\/(\d+)\/([a-z0-9]+)\/?$/.exec(location.pathname);
  if (guild) return <GuildPage id={guild[1]} pageKey={guild[2]} />;
  if (location.pathname === '/' || location.pathname === '') return <Home />;
  return (
    <main className="page narrow">
      <Wordmark />
      <h1 className="title">Nothing here</h1>
      <p className="lede">This address isn’t a guild page. In your Discord server, type /anvil for the link.</p>
    </main>
  );
}

export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="anvil home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 10h18c0 3 2 4.5 4 5-3 .5-5 1.5-6 3.5V21h2.5v3H8.5v-3H11v-2.5C8 17.5 6 15 5 10z" />
      </svg>
      anvil
    </a>
  );
}

function Home() {
  return (
    <main className="page narrow">
      <Wordmark />
      <h1 className="display">Who in the guild can craft it?</h1>
      <p className="lede">
        anvil is a Discord bot for WoW Forever guilds. Everyone logs their professions once, and then anyone can ask
        who can make something.
      </p>
      <ul className="steps">
        <li>
          <code>/prof set</code> your character’s profession and skill. Every recipe a trainer teaches up to that
          skill counts on its own.
        </li>
        <li>
          <code>/recipe add</code> the ones a skill doesn’t cover: drops, vendor patterns, quest rewards, campsite
          recipes.
        </li>
        <li>
          <code>/whocan</code> anything. <code>/anvil</code> links the guild’s page, with every crafter and the recipes
          nobody has yet.
        </li>
      </ul>
      <p className="hint">No addon needed, and nothing to install in the game.</p>
    </main>
  );
}
