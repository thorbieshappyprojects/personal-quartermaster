import { useSignal } from '@preact/signals';
import { LOCATION_KINDS, canNest, type LocationKind } from '@pq/core/browser';
import { useEffect } from 'preact/hooks';
import { api, type ItemPage, type Location } from '../api';
import { Empty, ErrorNote, ItemCard, Path } from '../components/ui';
import { Link, navigate } from '../router';
import { locationPath, locations, refreshLocations } from '../store';

const KIND_LABEL: Record<LocationKind, string> = { site: 'Site', room: 'Room', spot: 'Spot', container: 'Box / container' };
const NEXT: Record<LocationKind, LocationKind> = { site: 'room', room: 'spot', spot: 'container', container: 'container' };

/** /places (all sites) and /places/:id (one place: what is inside, and the items there). */
export function PlacesPage({ id }: { id?: string }) {
  const here = id ? locations.value.find((l) => l.id === id) ?? null : null;
  const children = locations.value.filter((l) => l.parent_id === (id ?? null));
  const items = useSignal<ItemPage | null>(null);
  const error = useSignal<string | null>(null);
  const adding = useSignal(false);
  const renaming = useSignal(false);
  const newName = useSignal('');
  const newKind = useSignal<LocationKind>(here ? NEXT[here.kind] : 'site');

  useEffect(() => {
    void refreshLocations();
    items.value = null;
    adding.value = false;
    renaming.value = false;
    newKind.value = here ? NEXT[here.kind] : 'site';
    if (id) api.get<ItemPage>(`/api/v1/items?location_id=${id}&state=active&limit=200`).then((r) => (items.value = r), (e) => (error.value = (e as Error).message));
  }, [id]);

  async function add(e: Event) {
    e.preventDefault();
    error.value = null;
    try {
      await api.post<Location>('/api/v1/locations', { parent_id: id ?? null, kind: newKind.value, name: newName.value.trim() });
      newName.value = '';
      adding.value = false;
      await refreshLocations();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }
  async function rename(e: Event) {
    e.preventDefault();
    try {
      await api.patch(`/api/v1/locations/${id}`, { name: newName.value.trim() });
      renaming.value = false;
      await refreshLocations();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }
  async function remove() {
    try {
      await api.del(`/api/v1/locations/${id}`);
      await refreshLocations();
      navigate(here?.parent_id ? `/places/${here.parent_id}` : '/places', { replace: true });
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  if (id && !here) return <main><p class="muted">Loading…</p></main>;
  const kinds = LOCATION_KINDS.filter((k) => canNest(here?.kind ?? null, k));
  const direct = items.value?.items.filter((i) => i.location_id === id) ?? [];

  return (
    <main>
      {here ? (
        <>
          <p class="crumbs">
            <Link href="/places">Places</Link>
            {locationPath(here.parent_id).length > 0 && <> › <Path parts={locationPath(here.parent_id)} /></>}
          </p>
          {renaming.value ? (
            <form onSubmit={rename} class="inline-form">
              <input required maxLength={200} value={newName.value} onInput={(e) => (newName.value = (e.currentTarget as HTMLInputElement).value)} aria-label="Name" />
              <button class="primary" type="submit">Save</button>
            </form>
          ) : (
            <h1>
              {here.name} <span class="muted small">{KIND_LABEL[here.kind]}</span>
            </h1>
          )}
        </>
      ) : (
        <h1>Places</h1>
      )}
      <ErrorNote error={error.value} />

      {children.length > 0 && (
        <ul class="place-list">
          {children.map((c) => {
            const below = locations.value.filter((l) => l.parent_id === c.id).length;
            return (
              <li key={c.id}>
                <Link href={`/places/${c.id}`} class="card">
                  <span>{c.name}</span>
                  <span class="muted small">
                    {c.item_count ? `${c.item_count} item${c.item_count === 1 ? '' : 's'}` : ''}
                    {c.item_count && below ? ' · ' : ''}
                    {below ? `${below} inside` : ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!id && children.length === 0 && <Empty>Start with a site: the flat or house, a cellar, a garage, the car.</Empty>}

      {adding.value ? (
        <form onSubmit={add} class="form card">
          <label class="field">
            <span class="label">Name</span>
            <input required autoFocus maxLength={200} value={newName.value} onInput={(e) => (newName.value = (e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span class="label">Kind</span>
            <select value={newKind.value} onChange={(e) => (newKind.value = (e.currentTarget as HTMLSelectElement).value as LocationKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <div class="actions">
            <button type="button" class="secondary" onClick={() => (adding.value = false)}>Cancel</button>
            <button type="submit" class="primary">Add place</button>
          </div>
        </form>
      ) : (
        <div class="actions">
          <button type="button" class="secondary" onClick={() => (adding.value = true)}>
            + {here ? `Place inside ${here.name}` : 'Site'}
          </button>
          {here && (
            <Link class="button primary" href={`/items/new?location=${here.id}`}>
              + Item here
            </Link>
          )}
        </div>
      )}

      {here && (
        <>
          <h2 class="section">Items here and inside</h2>
          {items.value === null ? (
            <p class="muted">Loading…</p>
          ) : items.value.items.length === 0 ? (
            <Empty>No items yet.</Empty>
          ) : (
            <div class="list">
              {items.value.items.map((i) => (
                <ItemCard key={i.id} item={i} />
              ))}
            </div>
          )}
          <div class="place-tools">
            <button type="button" class="link" onClick={() => { newName.value = here.name; renaming.value = true; }}>Rename</button>
            {children.length === 0 && direct.length === 0 && items.value?.total === 0 && (
              <button type="button" class="link danger-text" onClick={remove}>Delete this place</button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
