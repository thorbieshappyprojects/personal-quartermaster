import { useSignal } from '@preact/signals';
import { ITEM_STATES, STATE_LABELS, type ItemState } from '@pq/core/browser';
import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { api, type EventRow, type Item } from '../api';
import { LocationPicker } from '../components/LocationPicker';
import { ErrorNote, Path, price, qtyLabel, StateBadge } from '../components/ui';
import { prepareUpload } from '../image';
import { Link, navigate } from '../router';
import { persons } from '../store';

const EVENT_LABELS: Record<string, string> = {
  'item.created': 'added',
  'item.moved': 'moved',
  'item.state_changed': 'changed state',
  'item.updated': 'edited',
  'item.photo_added': 'added a photo',
  'item.photo_removed': 'removed a photo',
};

export function ItemDetailPage({ id }: { id: string }) {
  const item = useSignal<Item | null>(null);
  const events = useSignal<EventRow[]>([]);
  const error = useSignal<string | null>(sessionStorage.getItem('pq-flash'));
  const moving = useSignal(false);
  const confirmDelete = useSignal(false);
  const busy = useSignal(false);

  async function load() {
    try {
      const [i, ev] = await Promise.all([
        api.get<Item>(`/api/v1/items/${id}`),
        api.get<EventRow[]>(`/api/v1/events?entity=item&entity_id=${id}&limit=20`),
      ]);
      item.value = i;
      events.value = ev;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }
  useEffect(() => {
    sessionStorage.removeItem('pq-flash');
    void load();
  }, [id]);

  async function act(fn: () => Promise<unknown>) {
    busy.value = true;
    error.value = null;
    try {
      await fn();
      await load();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      busy.value = false;
    }
  }

  const i = item.value;
  if (!i) return <main>{error.value ? <ErrorNote error={error.value} /> : <p class="muted">Loading…</p>}</main>;
  const owner = persons.value.find((p) => p.id === i.belongs_to_person_id)?.display_name;
  const p = price(i);
  const q = qtyLabel(i);

  return (
    <main>
      {i.photos.length > 0 && (
        <div class="photos">
          {i.photos.map((ph) => (
            <a key={ph.document_id} href={ph.url} target="_blank" rel="noopener">
              <img src={ph.thumb_url} alt={`Photo of ${i.name}`} width={ph.width ?? undefined} height={ph.height ?? undefined} />
            </a>
          ))}
        </div>
      )}
      <h1 data-testid="item-name">
        {i.name} <StateBadge state={i.state} />
      </h1>
      <p>
        <Link href={i.location_id ? `/places/${i.location_id}` : '/places'} data-testid="item-path">
          <Path parts={i.location_path} />
        </Link>
      </p>

      <ErrorNote error={error.value} />
      <div class="actions">
        <button class="primary" type="button" disabled={busy.value} onClick={() => (moving.value = true)} data-testid="move">
          Move
        </button>
        <label class="button secondary">
          Add photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              if (f) void act(async () => {
                const { blob, name } = await prepareUpload(f);
                await api.upload(`/api/v1/items/${id}/photos`, blob, name);
              });
            }}
          />
        </label>
        <Link class="button secondary" href={`/items/${id}/edit`}>
          Edit
        </Link>
      </div>

      <dl class="facts">
        {q && (<><dt>Quantity</dt><dd>{q}</dd></>)}
        <dt>Category</dt>
        <dd>{i.category_path.length ? i.category_path.join(' › ') : '—'}</dd>
        <dt>Kind</dt>
        <dd>{i.kind === 'supply' ? 'Supply' : 'Thing'}</dd>
        <dt>Belongs to</dt>
        <dd>{owner ?? 'Household'}</dd>
        {p && (<><dt>Price paid</dt><dd>{p}</dd></>)}
        {i.acquired_at && (<><dt>Acquired</dt><dd>{i.acquired_at}</dd></>)}
        {Object.entries(i.attributes).filter(([, v]) => v !== null && v !== '').map(([k, v]) => (
          <Fragment key={k}><dt>{k[0]!.toUpperCase() + k.slice(1)}</dt><dd>{String(v)}</dd></Fragment>
        ))}
        {i.aliases.length > 0 && (<><dt>Also called</dt><dd>{i.aliases.join(', ')}</dd></>)}
        {i.tags.length > 0 && (<><dt>Tags</dt><dd>{i.tags.join(', ')}</dd></>)}
        {i.purchase_url && (<><dt>Bought at</dt><dd><a href={i.purchase_url} target="_blank" rel="noopener noreferrer">{new URL(i.purchase_url).hostname}</a></dd></>)}
      </dl>
      {i.notes && <p class="notes">{i.notes}</p>}

      <label class="field">
        <span class="label">State</span>
        <select
          value={i.state}
          disabled={busy.value}
          onChange={(e) => {
            const s = (e.currentTarget as HTMLSelectElement).value as ItemState;
            void act(() => api.post(`/api/v1/items/${id}/state`, { state: s }));
          }}
        >
          {ITEM_STATES.map((s) => (
            <option key={s} value={s}>{STATE_LABELS[s]}</option>
          ))}
        </select>
      </label>

      <h2 class="section">History</h2>
      <ul class="history">
        {events.value.map((e) => (
          <li key={e.id}>
            <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time> · {e.actor_name ?? 'system'} {EVENT_LABELS[e.type] ?? e.type}
          </li>
        ))}
      </ul>

      <div class="danger-zone">
        {confirmDelete.value ? (
          <>
            <p>Delete “{i.name}”? Use this only for entries made by mistake; for things that left the house, change the state instead.</p>
            <div class="actions">
              <button type="button" class="secondary" onClick={() => (confirmDelete.value = false)}>Keep</button>
              <button type="button" class="danger" onClick={() => void act(async () => { await api.del(`/api/v1/items/${id}`); navigate('/', { replace: true }); })}>
                Delete
              </button>
            </div>
          </>
        ) : (
          <button type="button" class="link danger-text" onClick={() => (confirmDelete.value = true)}>Delete entry…</button>
        )}
      </div>

      {moving.value && (
        <LocationPicker
          title={`Move ${i.name}`}
          current={i.location_id}
          allowUnknown
          onPick={(loc) => {
            moving.value = false;
            void act(() => api.post(`/api/v1/items/${id}/move`, { location_id: loc }));
          }}
          onClose={() => (moving.value = false)}
        />
      )}
    </main>
  );
}
