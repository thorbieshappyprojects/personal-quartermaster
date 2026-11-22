import { useSignal } from '@preact/signals';
import { canNest, normaliseText, type LocationKind } from '@pq/core/browser';
import { useEffect, useRef } from 'preact/hooks';
import { api, type Location } from '../api';
import { locationOptions, refreshLocations } from '../store';
import { ErrorNote } from './ui';

const NEXT_KIND: Record<LocationKind, LocationKind> = { site: 'room', room: 'spot', spot: 'container', container: 'container' };

/**
 * Full-screen, searchable list of all places with their paths. Choosing calls onPick;
 * a new place can be created inside the highlighted parent without leaving the sheet.
 */
export function LocationPicker(props: {
  title: string;
  current: string | null;
  allowUnknown?: boolean;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const filter = useSignal('');
  const creating = useSignal(false);
  const newName = useSignal('');
  const newParent = useSignal<string | null>(props.current);
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const f = normaliseText(filter.value);
  const options = locationOptions.value.filter((o) => !f || normaliseText(o.path.join(' ')).includes(f));
  const parent = locationOptions.value.find((o) => o.node.id === newParent.value)?.node ?? null;
  const newKind: LocationKind = parent ? NEXT_KIND[parent.kind] : 'site';

  async function create(e: Event) {
    e.preventDefault();
    error.value = null;
    if (parent && !canNest(parent.kind, newKind)) return;
    try {
      const loc = await api.post<Location>('/api/v1/locations', { parent_id: parent?.id ?? null, kind: newKind, name: newName.value.trim() });
      await refreshLocations();
      props.onPick(loc.id);
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
      <header class="sheet-head">
        <button type="button" class="link" onClick={props.onClose}>
          Cancel
        </button>
        <h2>{props.title}</h2>
        <span />
      </header>
      <input
        ref={input}
        type="search"
        placeholder="Filter places…"
        value={filter.value}
        onInput={(e) => (filter.value = (e.currentTarget as HTMLInputElement).value)}
        aria-label="Filter places"
      />
      <ul class="pick-list">
        {props.allowUnknown && (
          <li>
            <button type="button" class={props.current === null ? 'picked' : ''} onClick={() => props.onPick(null)}>
              <span class="muted">Location unknown</span>
            </button>
          </li>
        )}
        {options.map((o) => (
          <li key={o.node.id}>
            <button
              type="button"
              class={o.node.id === props.current ? 'picked' : ''}
              style={{ paddingLeft: `${0.75 + (o.path.length - 1) * 0.9}rem` }}
              onClick={() => props.onPick(o.node.id)}
            >
              <span>{o.node.name}</span>
              {o.path.length > 1 && <span class="path small">{o.path.slice(0, -1).join(' › ')}</span>}
            </button>
          </li>
        ))}
        {options.length === 0 && <li class="empty">No place matches.</li>}
      </ul>
      {creating.value ? (
        <form class="new-place" onSubmit={create}>
          <label class="field">
            <span class="label">New {newKind} {parent ? `in ${parent.name}` : '(a house, flat, cellar, car …)'}</span>
            <input
              required
              maxLength={200}
              value={newName.value}
              onInput={(e) => (newName.value = (e.currentTarget as HTMLInputElement).value)}
              aria-label="New place name"
            />
          </label>
          <label class="field">
            <span class="label">Inside</span>
            <select value={newParent.value ?? ''} onChange={(e) => (newParent.value = (e.currentTarget as HTMLSelectElement).value || null)}>
              <option value="">— nothing (new site) —</option>
              {locationOptions.value.map((o) => (
                <option key={o.node.id} value={o.node.id}>
                  {o.path.join(' › ')}
                </option>
              ))}
            </select>
          </label>
          <ErrorNote error={error.value} />
          <button class="primary" type="submit">
            Create and choose
          </button>
        </form>
      ) : (
        <button type="button" class="secondary wide" onClick={() => (creating.value = true)}>
          + New place
        </button>
      )}
    </div>
  );
}
