import { useEffect, useMemo, useState } from 'react';
import type { Character, Recipe } from '../core/types';
import { PROFESSIONS } from '../core/types';
import { RECIPES, isNotable, recipeLabel, searchRecipes } from '../core/recipes';
import { isEssential } from '../core/essentials';
import { Wordmark } from './App';

// A private page from /recipe edit: one character's recipes as checkboxes, for logging many at once. The
// link's token stands in for whoever asked for it; the Worker checks everything again on save.

interface View {
  guildName: string;
  character: Character;
  expires: number;
}

const LEARNED: Record<Recipe['learned'], string> = {
  trainer: 'trainer',
  drop: 'drop',
  vendor: 'vendor',
  quest: 'quest',
  reputation: 'reputation',
  campsite: 'campsite',
  other: 'found',
};

export function EditPage({ id, token }: { id: string; token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const api = `/api/e/${id}/${token}`;

  useEffect(() => {
    fetch(api)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'expired' : 'failed');
        const data = (await response.json()) as View;
        setView(data);
        setTicked(new Set(data.character.recipes));
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const character = view?.character;
  // Every recipe this character could have logged: its professions' non-trainer recipes within its skill,
  // and anything already logged.
  const groups = useMemo(() => {
    if (!character) return [];
    const matching = query.trim() ? new Set(searchRecipes(query, undefined, RECIPES.length).map((r) => r.id)) : null;
    return PROFESSIONS.filter((p) => character.skills[p.id] !== undefined).map((p) => {
      const all = RECIPES.filter(
        (r) => r.prof === p.id && ((isNotable(r) && r.skill <= character.skills[p.id]!) || character.recipes.includes(r.id)),
      ).sort((a, b) => a.skill - b.skill || a.name.localeCompare(b.name));
      const shown = matching ? all.filter((r) => matching.has(r.id)) : all;
      // The essentials come first and are always open; the rest sit behind "show the rest".
      return { prof: p, all, essential: shown.filter(isEssential), rest: shown.filter((r) => !isEssential(r)) };
    });
  }, [character, query]);

  if (error) {
    return (
      <main className="page narrow">
        <Wordmark />
        <h1 className="title">{error === 'expired' ? 'This link has expired' : 'Couldn’t load your recipes'}</h1>
        <p className="lede">
          {error === 'expired'
            ? 'Edit links last two hours. In Discord, run /recipe edit for a new one.'
            : 'Something went wrong. Try again in a moment.'}
        </p>
      </main>
    );
  }
  if (!view || !character) {
    return (
      <main className="page">
        <Wordmark />
        <p className="loading">Loading your recipes…</p>
      </main>
    );
  }

  const logged = new Set(character.recipes);
  const add = [...ticked].filter((r) => !logged.has(r));
  const remove = [...logged].filter((r) => !ticked.has(r));
  const changes = add.length + remove.length;
  const essentials = groups.flatMap((g) => g.all.filter(isEssential));
  const essentialsTicked = essentials.filter((r) => ticked.has(r.id)).length;
  const filtering = query.trim() !== '';

  const toggle = (r: number) => {
    const next = new Set(ticked);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    setTicked(next);
    setStatus('');
  };

  const save = async () => {
    setSaving(true);
    setStatus('');
    try {
      const response = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add, remove }),
      });
      if (response.status === 404) throw new Error('expired');
      if (!response.ok) throw new Error('failed');
      const result = (await response.json()) as { added: string[]; removed: string[]; tooLow: string[]; view: View };
      setView(result.view);
      setTicked(new Set(result.view.character.recipes));
      const parts = [
        result.added.length && `logged ${result.added.length}`,
        result.removed.length && `took off ${result.removed.length}`,
        result.tooLow.length && `skipped ${result.tooLow.length} that need more skill`,
      ].filter(Boolean);
      setStatus(`Saved: ${parts.join(', ') || 'nothing changed'}.`);
    } catch (e) {
      if ((e as Error).message === 'expired') setError('expired');
      else setStatus('Couldn’t save. Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <Wordmark />
      </header>
      <main className="page edit">
        <h1 className="title">{character.name}’s recipes</h1>
        <p className="lede-small">
          {view.guildName ? `${view.guildName} · ` : ''}Tick what {character.name} knows. Trainer recipes aren’t here:
          they count from the skill.
        </p>
        {essentials.length > 0 && (
          <p className="hint" data-essentials>
            Essentials: {essentialsTicked} of {essentials.length} ticked. Start there; the rest is one click away.
          </p>
        )}
        <input
          className="search"
          type="search"
          placeholder="filter, like “mooncloth”"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter recipes"
        />
        {groups.map(({ prof, all, essential, rest }) => {
          const restAll = all.filter((r) => !isEssential(r));
          const restTicked = restAll.filter((r) => ticked.has(r.id)).length;
          return (
            <section key={prof.id} className="edit-group" data-prof={prof.id}>
              <h2 className="section-title">
                {prof.name}{' '}
                <span className="meta">
                  {character.skills[prof.id]} · {all.filter((r) => ticked.has(r.id)).length} of {all.length} ticked
                </span>
              </h2>
              {essential.length > 0 && <Ticks list={essential} ticked={ticked} onToggle={toggle} />}
              {rest.length > 0 && (
                <details className="more" open={filtering || undefined}>
                  <summary>
                    show the rest · {restTicked} of {restAll.length} ticked
                  </summary>
                  <Ticks list={rest} ticked={ticked} onToggle={toggle} />
                </details>
              )}
              {essential.length === 0 && rest.length === 0 && (
                <p className="hint">{all.length ? 'Nothing matches the filter.' : 'Nothing to log yet at this skill.'}</p>
              )}
            </section>
          );
        })}
        <div className="savebar" role="status">
          <span>{status || (changes ? `${changes} change${changes === 1 ? '' : 's'} to save` : 'No changes')}</span>
          <button type="button" className="button" disabled={!changes || saving} onClick={save}>
            {saving ? 'saving…' : 'save'}
          </button>
        </div>
      </main>
    </>
  );
}

function Ticks({ list, ticked, onToggle }: { list: Recipe[]; ticked: Set<number>; onToggle: (id: number) => void }) {
  return (
    <ul className="ticks">
      {list.map((r) => (
        <li key={r.id}>
          <label>
            <input type="checkbox" checked={ticked.has(r.id)} onChange={() => onToggle(r.id)} data-recipe={r.id} />
            <span>{recipeLabel(r)}</span>
            <span className="meta">
              {r.skill} · {LEARNED[r.learned]}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
