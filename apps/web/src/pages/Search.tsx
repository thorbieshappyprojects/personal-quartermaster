import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { api, type FindResult, type ItemPage } from '../api';
import { Empty, ErrorNote, ItemCard } from '../components/ui';
import { Link, navigate, query } from '../router';

/** Home: "Do we have …?" with live answers; recent items when the box is empty. */
export function SearchPage() {
  const q = useSignal(query('q') ?? '');
  const result = useSignal<FindResult | null>(null);
  const recent = useSignal<ItemPage | null>(null);
  const error = useSignal<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.value.trim();
    const mine = ++seq.current;
    error.value = null;
    const timer = setTimeout(async () => {
      try {
        if (!text) {
          result.value = null;
          recent.value = await api.get<ItemPage>('/api/v1/items?state=active&limit=30');
        } else {
          const r = await api.get<FindResult>(`/api/v1/find?q=${encodeURIComponent(text)}`);
          if (mine === seq.current) result.value = r;
        }
      } catch (err) {
        if (mine === seq.current) error.value = (err as Error).message;
      }
    }, text ? 180 : 0);
    // Keep the query in the URL so "back" from an item returns to the same results.
    history.replaceState(null, '', text ? `/?q=${encodeURIComponent(text)}` : '/');
    return () => clearTimeout(timer);
  }, [q.value]);

  const text = q.value.trim();
  return (
    <main>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <input
          class="search"
          type="search"
          enterKeyHint="search"
          placeholder="Do we have …?"
          aria-label="Do we have …?"
          value={q.value}
          onInput={(e) => (q.value = (e.currentTarget as HTMLInputElement).value)}
          autoFocus={!q.value}
        />
      </form>
      <ErrorNote error={error.value} />
      {text && result.value && (
        <>
          <p class="answer" data-testid="answer">
            {result.value.answer}
          </p>
          <div class="list">
            {result.value.items.map((i) => (
              <ItemCard key={i.id} item={i} />
            ))}
          </div>
          <button type="button" class="secondary wide" onClick={() => navigate(`/items/new?name=${encodeURIComponent(result.value!.terms || text)}`)}>
            + Add “{result.value.terms || text}”
          </button>
        </>
      )}
      {!text && recent.value && (
        <>
          <h2 class="section">Recently changed</h2>
          {recent.value.items.length === 0 ? (
            <Empty>
              Nothing here yet. <Link href="/places">Set up your places</Link>, then <Link href="/items/new">add the first item</Link>.
            </Empty>
          ) : (
            <div class="list">
              {recent.value.items.map((i) => (
                <ItemCard key={i.id} item={i} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
