import { useSignal } from '@preact/signals';
import type { GoneReason } from '@pq/core/browser';
import { useEffect, useRef } from 'preact/hooks';
import { api, qs, type LinePage, type PurchaseLine } from '../api';
import { LocationPicker } from '../components/LocationPicker';
import { Empty, ErrorNote, Path } from '../components/ui';
import { Link } from '../router';
import { locationPath } from '../store';
import { eur, GONE_CHOICES, HistoryNav, lineDate, linePrice, REASON_LABELS } from './history-common';

type Action = 'owned' | 'gone' | 'used_up' | 'ignored';
interface Last {
  line: PurchaseLine;
  action: Action;
  reason: GoneReason | null;
}
interface Filters {
  q: string;
  year: string;
  merchant: string;
  sort: 'price' | 'date' | 'date_asc';
}

const LOC_KEY = 'pq.check.location';
const readLoc = () => {
  try {
    return localStorage.getItem(LOC_KEY);
  } catch {
    return null;
  }
};
const writeLoc = (v: string | null) => {
  try {
    if (v) localStorage.setItem(LOC_KEY, v);
    else localStorage.removeItem(LOC_KEY);
  } catch {
    /* private mode */
  }
};

const ACTION_LABEL: Record<Action, string> = { owned: 'Have it', gone: 'Gone', used_up: 'Used up', ignored: 'Ignored' };

/**
 * The possession check: one purchase line at a time, most expensive first. One tap (or key)
 * decides it and the next one appears at once; requests run in order in the background.
 */
export function CheckPage() {
  const queue = useSignal<PurchaseLine[]>([]);
  const total = useSignal<number | null>(null);
  const totalEur = useSignal(0);
  const skipped = useSignal(0);
  const done = useSignal(0);
  const last = useSignal<Last | null>(null);
  const error = useSignal<string | null>(null);
  const loading = useSignal(false);
  const locationId = useSignal<string | null>(readLoc());
  const picking = useSignal(false);
  const facets = useSignal<{ years: number[]; merchants: string[] }>({ years: [], merchants: [] });
  const filters = useSignal<Filters>({ q: '', year: '', merchant: '', sort: 'price' });
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const filterQs = (extra: Record<string, string | number | undefined> = {}) =>
    qs({ q: filters.value.q, year: filters.value.year, merchant: filters.value.merchant, sort: filters.value.sort, ...extra });

  /** Runs requests strictly in order, so offsets and undo stay consistent. */
  const enqueue = (fn: () => Promise<unknown>) => {
    chain.current = chain.current.then(fn).catch((err: Error) => {
      error.value = err.message;
    });
    return chain.current;
  };

  const fetchMore = (reset = false) =>
    enqueue(async () => {
      loading.value = true;
      try {
        if (reset) {
          queue.value = [];
          skipped.value = 0;
        }
        const page = await api.get<LinePage>(`/api/v1/possession${filterQs({ limit: 40, offset: skipped.value + queue.value.length })}`);
        const seen = new Set(queue.value.map((l) => l.id));
        queue.value = [...queue.value, ...page.lines.filter((l) => !seen.has(l.id))];
        total.value = page.total;
        totalEur.value = page.total_eur_minor;
      } finally {
        loading.value = false;
      }
    });

  useEffect(() => {
    void fetchMore(true);
    api.get<{ years: number[]; merchants: string[] }>('/api/v1/possession/facets').then((f) => (facets.value = f), () => undefined);
  }, []);

  const current = queue.value[0];

  const advance = () => {
    queue.value = queue.value.slice(1);
    const remaining = (total.value ?? 0) - skipped.value;
    if (queue.value.length < 8 && remaining > queue.value.length) void fetchMore();
  };

  function decide(action: Action) {
    const line = queue.value[0];
    if (!line) return;
    error.value = null;
    const reason: GoneReason | null = action === 'used_up' ? 'consumed' : null;
    last.value = { line, action, reason };
    total.value = (total.value ?? 1) - 1;
    totalEur.value -= line.amount_eur_minor ?? 0;
    done.value++;
    const body =
      action === 'owned'
        ? { status: 'owned', location_id: locationId.value }
        : action === 'ignored'
          ? { status: 'ignored' }
          : { status: 'gone', gone_reason: reason };
    void enqueue(() => api.post(`/api/v1/possession/${line.id}`, body));
    advance();
  }

  function skip() {
    if (!queue.value[0]) return;
    skipped.value++;
    advance();
  }

  function setReason(reason: GoneReason) {
    const l = last.value;
    if (!l || l.action !== 'gone') return;
    last.value = { ...l, reason };
    void enqueue(() => api.post(`/api/v1/possession/${l.line.id}`, { status: 'gone', gone_reason: reason }));
  }

  function undo() {
    const l = last.value;
    if (!l) return;
    last.value = null;
    void enqueue(async () => {
      await api.post(`/api/v1/possession/${l.line.id}/reset`);
      queue.value = [l.line, ...queue.value.filter((x) => x.id !== l.line.id)];
      total.value = (total.value ?? 0) + 1;
      totalEur.value += l.line.amount_eur_minor ?? 0;
      done.value--;
    });
  }

  // Keyboard: H have · G gone · U used up · I ignore · S/→ skip · Z/⌫ undo · 1–5 reason after "gone".
  const handler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  handler.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || picking.value) return;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    const map: Record<string, () => void> = {
      h: () => decide('owned'), g: () => decide('gone'), u: () => decide('used_up'), i: () => decide('ignored'),
      s: skip, arrowright: skip, z: undo, backspace: undo,
    };
    const digit = Number(k);
    if (digit >= 1 && digit <= GONE_CHOICES.length && last.value?.action === 'gone') {
      e.preventDefault();
      setReason(GONE_CHOICES[digit - 1]!);
    } else if (map[k]) {
      e.preventDefault();
      map[k]();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const setFilter = (patch: Partial<Filters>) => {
    filters.value = { ...filters.value, ...patch };
    void fetchMore(true);
  };

  const qTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = filters.value;
  const nothingImported = total.value === 0 && done.value === 0 && !f.q && !f.year && !f.merchant;

  return (
    <main class="check">
      <HistoryNav />
      <h1>Do you still have it?</h1>
      {total.value !== null && (
        <p class="muted" data-testid="check-progress">
          <strong>{total.value.toLocaleString('en-GB')}</strong> left to check · {eur(totalEur.value)}
          {done.value > 0 && <> · {done.value} done this session</>}
          {skipped.value > 0 && <> · {skipped.value} skipped</>}
        </p>
      )}

      <details class="filters">
        <summary>Filter and sort</summary>
        <div class="filter-row">
          <input
            type="search" placeholder="Search titles" aria-label="Search titles" value={f.q}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              clearTimeout(qTimer.current);
              qTimer.current = setTimeout(() => setFilter({ q: v }), 300);
            }}
          />
          <select aria-label="Year" value={f.year} onChange={(e) => setFilter({ year: (e.target as HTMLSelectElement).value })}>
            <option value="">All years</option>
            {facets.value.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select aria-label="Shop" value={f.merchant} onChange={(e) => setFilter({ merchant: (e.target as HTMLSelectElement).value })}>
            <option value="">All shops</option>
            {facets.value.merchants.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select aria-label="Order" value={f.sort} onChange={(e) => setFilter({ sort: (e.target as HTMLSelectElement).value as Filters['sort'] })}>
            <option value="price">Most expensive first</option>
            <option value="date">Newest first</option>
            <option value="date_asc">Oldest first</option>
          </select>
        </div>
        <BulkMark filters={f} onDone={() => void fetchMore(true)} />
      </details>

      <ErrorNote error={error.value} />

      {nothingImported ? (
        <Empty>
          Nothing to check yet. <Link href="/history/import">Import your orders</Link> first.
        </Empty>
      ) : current ? (
        <>
          <article class="check-card" data-testid="check-card" aria-live="polite">
            <div class="check-price">{linePrice(current)}</div>
            <h2 class="check-title">{current.title}</h2>
            <p class="muted small">
              {current.merchant ?? 'Unknown shop'} · {lineDate(current.ordered_at)}
              {current.quantity !== 1 && <> · {current.quantity} ×</>}
              {current.url && <> · <a href={current.url} target="_blank" rel="noopener noreferrer">open in shop ↗</a></>}
            </p>
          </article>

          <div class="check-buttons">
            <button class="primary" onClick={() => decide('owned')}>Have it <kbd>H</kbd></button>
            <button class="gone-btn" onClick={() => decide('gone')}>Gone <kbd>G</kbd></button>
            <button class="secondary" onClick={() => decide('used_up')}>Used up <kbd>U</kbd></button>
            <button class="secondary" onClick={() => decide('ignored')}>Not ours / ignore <kbd>I</kbd></button>
          </div>
          <div class="check-tools">
            <button class="link" onClick={skip}>Skip for now <kbd>S</kbd></button>
            <button class="link" onClick={() => (picking.value = true)} data-testid="check-location">
              "Have it" goes to: <Path parts={locationPath(locationId.value)} empty="location unknown" />
            </button>
          </div>
        </>
      ) : loading.value ? (
        <p class="muted">Loading…</p>
      ) : (
        <Empty>
          All checked{f.q || f.year || f.merchant ? ' for this filter' : ''}. <Link href="/history/spending">See the spending</Link>
          {skipped.value > 0 && (
            <>
              {' '}or <button class="link" onClick={() => void fetchMore(true)}>go through the {skipped.value} skipped</button>
            </>
          )}
          .
        </Empty>
      )}

      {last.value && (
        <div class="last-action" role="status">
          <span>
            <strong>{ACTION_LABEL[last.value.action]}</strong>
            {last.value.action === 'gone' && last.value.reason && <> ({REASON_LABELS[last.value.reason].toLowerCase()})</>}: {last.value.line.title.slice(0, 60)}
            {last.value.line.title.length > 60 && '…'}
          </span>
          <button class="link" onClick={undo}>Undo <kbd>Z</kbd></button>
          {last.value.action === 'gone' && (
            <div class="chips" aria-label="Why is it gone? (optional)">
              {GONE_CHOICES.map((r, i) => (
                <button key={r} class={`chip${last.value?.reason === r ? ' picked' : ''}`} onClick={() => setReason(r)}>
                  {REASON_LABELS[r]} <kbd>{i + 1}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <p class="muted small keys-help">
        Keys: H have it · G gone · U used up · I ignore · S skip · Z undo · 1–5 why it's gone. Nothing is deleted: gone things stay in the history and
        the spending.
      </p>

      {picking.value && (
        <LocationPicker
          title='Where do "have it" items go?'
          current={locationId.value}
          allowUnknown
          onPick={(id) => {
            locationId.value = id;
            writeLoc(id);
            picking.value = false;
          }}
          onClose={() => (picking.value = false)}
        />
      )}
    </main>
  );
}

function BulkMark({ filters, onDone }: { filters: Filters; onDone: () => void }) {
  const maxEur = useSignal('');
  const action = useSignal<'used_up' | 'gone' | 'ignored'>('used_up');
  const count = useSignal<number | null>(null);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const result = useSignal<string | null>(null);

  const filterBody = () => {
    const max = maxEur.value.trim() ? Math.round(Number(maxEur.value.replace(',', '.')) * 100) : undefined;
    return {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.year ? { year: Number(filters.year) } : {}),
      ...(filters.merchant ? { merchant: filters.merchant } : {}),
      ...(max !== undefined && Number.isFinite(max) ? { max_eur: max } : {}),
    };
  };

  async function preview() {
    error.value = null;
    result.value = null;
    try {
      const b = filterBody();
      const page = await api.get<LinePage>(`/api/v1/possession${qs({ ...b, limit: 1 })}`);
      count.value = page.total;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function apply() {
    busy.value = true;
    try {
      const body = { ...filterBody(), status: action.value === 'ignored' ? 'ignored' : 'gone', ...(action.value === 'used_up' ? { gone_reason: 'consumed' } : {}) };
      const r = await api.post<{ updated: number }>('/api/v1/possession/bulk', body);
      result.value = `${r.updated} lines marked.`;
      count.value = null;
      onDone();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      busy.value = false;
    }
  }

  const scope = [filters.year && `from ${filters.year}`, filters.merchant && `from ${filters.merchant}`, filters.q && `matching "${filters.q}"`].filter(Boolean).join(', ');
  return (
    <div class="bulk">
      <p class="small muted">
        Mark many at once: all unchecked lines {scope || 'in the whole history'}
        {maxEur.value ? ` costing at most €${maxEur.value}` : ''}. Never creates items.
      </p>
      <div class="filter-row">
        <input inputMode="decimal" placeholder="Max. price in €" aria-label="Maximum price in euros" value={maxEur.value}
          onInput={(e) => { maxEur.value = (e.target as HTMLInputElement).value; count.value = null; }} />
        <select aria-label="Mark as" value={action.value} onChange={(e) => { action.value = (e.target as HTMLSelectElement).value as 'used_up'; count.value = null; }}>
          <option value="used_up">as used up</option>
          <option value="gone">as gone</option>
          <option value="ignored">as ignored</option>
        </select>
        {count.value === null ? (
          <button class="secondary" onClick={preview}>Count lines</button>
        ) : (
          <button class="danger" disabled={busy.value || count.value === 0} onClick={apply}>
            Mark {count.value} lines
          </button>
        )}
      </div>
      <ErrorNote error={error.value} />
      {result.value && <p class="small" role="status">{result.value}</p>}
    </div>
  );
}
