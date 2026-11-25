import { useEffect, useMemo, useState } from 'react';
import type { Character, ProfessionId, Recipe, Roster } from '../core/types';
import { MAX_SKILL, PROFESSIONS } from '../core/types';
import { RECIPES, isNotable, recipe, recipeLabel, searchRecipes, wowheadUrl } from '../core/recipes';
import { STALE_DAYS, isStale } from '../core/stale';
import { reagentText } from '../core/crafting';
import { coverage } from '../core/coverage';
import { professionName } from '../core/professions';
import { whoCan } from '../core/whocan';
import { Wordmark } from './App';

const LEARNED: Record<Recipe['learned'], string> = {
  trainer: 'trainer',
  drop: 'drop',
  vendor: 'vendor',
  quest: 'quest',
  reputation: 'reputation',
  campsite: 'campsite',
  other: 'found',
};

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function GuildPage({ id, pageKey }: { id: string; pageKey: string }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/g/${id}/${pageKey}`);
        if (!response.ok) throw new Error(response.status === 404 ? 'missing' : 'failed');
        const data = (await response.json()) as Roster;
        if (live) setRoster(data);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, pageKey]);

  if (error) {
    return (
      <main className="page narrow">
        <Wordmark />
        <h1 className="title">{error === 'missing' ? 'No page here' : 'Couldn’t load the page'}</h1>
        <p className="lede">
          {error === 'missing'
            ? 'This link isn’t a guild page. In your Discord server, type /anvil for the right one.'
            : 'Something went wrong. Try again in a moment.'}
        </p>
      </main>
    );
  }
  if (!roster) {
    return (
      <main className="page">
        <Wordmark />
        <p className="loading">Loading the guild…</p>
      </main>
    );
  }

  const characters = roster.characters;
  return (
    <>
      <header className="topbar">
        <Wordmark />
      </header>
      <main className="page">
        <h1 className="title">{roster.guildName || 'Guild crafters'}</h1>
        <p className="lede-small">
          {characters.length} character{characters.length === 1 ? '' : 's'} logged
          {characters.length ? ` · last change ${ago(Math.max(...characters.map((c) => c.updated)))}` : ''}
        </p>
        {characters.length ? (
          <>
            <Search characters={characters} />
            <Professions characters={characters} />
            <Missing characters={characters} />
          </>
        ) : (
          <p className="empty">
            Nobody’s logged anything yet. In Discord, start with <code>/prof set</code>.
          </p>
        )}
      </main>
    </>
  );
}

function Search({ characters }: { characters: Character[] }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Recipe | null>(null);
  const matches = useMemo(() => (query.trim() ? searchRecipes(query, undefined, 8) : []), [query]);
  const result = picked ? whoCan(picked, characters) : null;

  return (
    <section className="panel" aria-labelledby="search-title">
      <h2 className="panel-title" id="search-title">
        Who can make…
      </h2>
      <input
        className="search"
        type="search"
        placeholder="a recipe or item, like “mooncloth”"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
        aria-label="Search recipes"
      />
      {!picked && matches.length > 0 && (
        <ul className="matches">
          {matches.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setPicked(r)}>
                <span>{recipeLabel(r)}</span>
                <span className="meta">
                  {professionName(r.prof)} {r.skill} · {LEARNED[r.learned]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!picked && query.trim() && !matches.length && <p className="hint">No recipe matches that.</p>}
      {picked && result && (
        <div className="answer" data-recipe={picked.id}>
          <p className="answer-head">
            <a className="recipe-link" href={wowheadUrl(picked)} target="_blank" rel="noreferrer">
              <strong>{picked.name}</strong>
            </a>{' '}
            <span className="meta">
              {professionName(picked.prof)} {picked.skill} · {LEARNED[picked.learned]}
            </span>
          </p>
          {reagentText(picked) && <p className="hint takes">Takes {reagentText(picked)}</p>}
          {result.crafters.length ? (
            <ul className="crafters">
              {result.crafters.map((c) => (
                <li key={c.name}>
                  <strong>{c.name}</strong> <span className="meta">{c.ownerName}</span>
                  <span className="meta">
                    {c.recipes.includes(picked.id) ? 'logged' : `${professionName(picked.prof)} ${c.skills[picked.prof]}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nobody can make this yet.</p>
          )}
          {result.couldLearn.length > 0 && (
            <p className="hint">
              Has the skill to learn it if the recipe turns up:{' '}
              {result.couldLearn.map((c) => `${c.name} (${c.skills[picked.prof]})`).join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Professions({ characters }: { characters: Character[] }) {
  const covered = useMemo(() => coverage(characters), [characters]);
  return (
    <section aria-labelledby="profs-title">
      <h2 className="section-title" id="profs-title">
        Professions
      </h2>
      <div className="prof-grid">
        {PROFESSIONS.map((p) => {
          const people = characters
            .filter((c) => c.skills[p.id] !== undefined)
            .sort((a, b) => b.skills[p.id]! - a.skills[p.id]! || a.name.localeCompare(b.name));
          return (
            <article key={p.id} className={`prof${people.length ? '' : ' none'}`} data-prof={p.id}>
              <h3>
                {p.name}{' '}
                <span className="meta" title={`${covered[p.id].have} of ${covered[p.id].total} recipes covered`}>
                  {people.length ? `${people.length} · ${covered[p.id].percent}%` : 'nobody yet'}
                </span>
              </h3>
              {people.length > 0 && (
                <ul>
                  {people.map((c) => {
                    const logged = c.recipes.filter((id) => recipe(id)?.prof === p.id).length;
                    return (
                      <li
                        key={c.name}
                        className={isStale(c) ? 'stale' : undefined}
                        title={`${c.ownerName} · updated ${ago(c.updated)}${isStale(c) ? `: over ${STALE_DAYS} days, so this may be behind` : ''}`}
                      >
                        <span className="who">{c.name}</span>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${(c.skills[p.id]! / MAX_SKILL) * 100}%` }} />
                        </span>
                        <span className="skill">{c.skills[p.id]}</span>
                        {logged > 0 && <span className="meta">+{logged}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Recipes nobody can make: what to farm, buy or train toward next. */
function Missing({ characters }: { characters: Character[] }) {
  const byProf = useMemo(() => {
    const out = new Map<ProfessionId, Recipe[]>();
    for (const r of RECIPES) {
      if (whoCan(r, characters).crafters.length) continue;
      out.set(r.prof, [...(out.get(r.prof) ?? []), r]);
    }
    for (const list of out.values()) list.sort((a, b) => a.skill - b.skill || a.name.localeCompare(b.name));
    return out;
  }, [characters]);

  return (
    <section aria-labelledby="missing-title">
      <h2 className="section-title" id="missing-title">
        Nobody has these yet
      </h2>
      <p className="hint">
        Trainer recipes count once someone’s skill reaches them. The rest count once someone logs them with{' '}
        <code>/recipe add</code>.
      </p>
      <div className="missing">
        {PROFESSIONS.filter((p) => byProf.get(p.id)?.length).map((p) => {
          const list = byProf.get(p.id)!;
          const toFind = list.filter(isNotable).length;
          const toTrain = list.length - toFind;
          const counts = [toFind && `${toFind} to find`, toTrain && `${toTrain} need more skill`].filter(Boolean);
          return (
            <details key={p.id} data-prof={p.id}>
              <summary>
                {p.name} <span className="meta">{counts.join(' · ')}</span>
              </summary>
              <ul>
                {list.map((r) => (
                  <li key={r.id}>
                    <a href={wowheadUrl(r)} target="_blank" rel="noreferrer">
                      {recipeLabel(r)}
                    </a>
                    <span className="meta">
                      {r.skill} · {LEARNED[r.learned]}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}
