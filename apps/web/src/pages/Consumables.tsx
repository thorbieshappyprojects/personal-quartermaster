import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api, qs, type LinePage, type PurchaseLine } from '../api';
import { Empty, ErrorNote } from '../components/ui';
import { Link } from '../router';
import { eur, HistoryNav, lineDate, linePrice } from './history-common';

type Period = 'recent' | 'older' | 'all';
type Kind = 'consumable' | 'food' | 'supplies';
type Done = 'used_up' | 'owned' | 'not_consumable';

const PERIODS: Record<Period, { label: string; from?: string; to?: string }> = {
  recent: { label: '2025 and later', from: '2025-01-01' },
  older: { label: 'Before 2025', to: '2025-01-01' },
  all: { label: 'All years' },
};
const DONE_LABELS: Record<Done, string> = { used_up: 'used up', owned: 'in the inventory', not_consumable: 'back in the check' };

/**
 * Unchecked lines the rules take for consumables (food and drink, household supplies),
 * newest first. Each can be marked used up, kept as a supply, or declared not a consumable;
 * a selection or the whole list can be marked used up at once.
 */
export function ConsumablesPage() {
  const period = useSignal<Period>('recent');
  const kind = useSignal<Kind>('consumable');
  const page = useSignal<LinePage | null>(null);
  const selected = useSignal<Set<string>>(new Set());
  const done = useSignal<Map<string, Done>>(new Map());
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);
  const confirmAll = useSignal(false);

  const filter = () => ({ suggested: kind.value, from_date: PERIODS[period.value].from, to_date: PERIODS[period.value].to });

  async function load(more = false) {
    error.value = null;
    try {
      const offset = more && page.value ? page.value.lines.length : 0;
      const p = await api.get<LinePage>(`/api/v1/possession${qs({ ...filter(), sort: 'date', limit: 200, offset })}`);
      page.value = more && page.value ? { ...p, lines: [...page.value.lines, ...p.lines] } : p;
      if (!more) {
        selected.value = new Set();
        done.value = new Map();
        confirmAll.value = false;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  useEffect(() => void load(), []);

  const mark = (id: string, d: Done) => {
    const m = new Map(done.value);
    m.set(id, d);
    done.value = m;
    const s = new Set(selected.value);
    s.delete(id);
    selected.value = s;
  };

  async function decide(l: PurchaseLine, d: Done) {
    error.value = null;
    try {
      if (d === 'used_up') await api.post(`/api/v1/possession/${l.id}`, { status: 'gone', gone_reason: 'consumed' });
      else if (d === 'owned') await api.post(`/api/v1/possession/${l.id}`, { status: 'owned', kind: 'supply' });
      else await api.post(`/api/v1/possession/${l.id}/suggestion`, { rejected: true });
      mark(l.id, d);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function markUsedUp(ids: string[] | null) {
    busy.value = true;
    error.value = null;
    try {
      const body = ids ? { ids, status: 'gone', gone_reason: 'consumed' } : { ...filter(), status: 'gone', gone_reason: 'consumed' };
      // Drop undefined dates so the server does not see empty strings.
      const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      await api.post<{ updated: number }>('/api/v1/possession/bulk', clean);
      if (ids) ids.forEach((id) => mark(id, 'used_up'));
      else await load();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      busy.value = false;
      confirmAll.value = false;
    }
  }

  const p = page.value;
  const open = p?.lines.filter((l) => !done.value.has(l.id)) ?? [];
  const remaining = p ? p.total - done.value.size : 0;
  const doneEur = p ? p.lines.filter((l) => done.value.has(l.id)).reduce((s, l) => s + (l.amount_eur_minor ?? 0), 0) : 0;
  const allSelected = open.length > 0 && open.every((l) => selected.value.has(l.id));
  const toggle = (id: string) => {
    const s = new Set(selected.value);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected.value = s;
  };

  return (
    <main>
      <HistoryNav />
      <h1>Likely consumables</h1>
      <p class="muted small">
        Unchecked purchases that look like food, drink or household supplies. Newest first. "Keep" adds it to the inventory as a supply.
      </p>
      <div class="filter-row">
        <select aria-label="Period" value={period.value} onChange={(e) => { period.value = (e.target as HTMLSelectElement).value as Period; void load(); }}>
          {(Object.keys(PERIODS) as Period[]).map((k) => <option key={k} value={k}>{PERIODS[k].label}</option>)}
        </select>
        <select aria-label="Kind" value={kind.value} onChange={(e) => { kind.value = (e.target as HTMLSelectElement).value as Kind; void load(); }}>
          <option value="consumable">Food and household</option>
          <option value="food">Food and drink</option>
          <option value="supplies">Household supplies</option>
        </select>
      </div>
      <ErrorNote error={error.value} />

      {p && (
        <p data-testid="consumables-count">
          <strong>{remaining.toLocaleString('en-GB')}</strong> unchecked · {eur(p.total_eur_minor - doneEur)}
          {done.value.size > 0 && <span class="muted"> · {done.value.size} done here</span>}
        </p>
      )}

      {p && remaining > 0 && (
        <div class="bulk-bar">
          <label class="check-option">
            <input type="checkbox" checked={allSelected}
              onChange={() => (selected.value = allSelected ? new Set() : new Set(open.map((l) => l.id)))} />
            <span>Select all shown</span>
          </label>
          <button class="primary" disabled={busy.value || selected.value.size === 0} onClick={() => void markUsedUp([...selected.value])}>
            Mark {selected.value.size} selected as used up
          </button>
          {confirmAll.value ? (
            <button class="danger" disabled={busy.value} onClick={() => void markUsedUp(null)}>Yes, mark all {remaining.toLocaleString('en-GB')}</button>
          ) : (
            <button class="secondary" disabled={busy.value} onClick={() => (confirmAll.value = true)}>All {remaining.toLocaleString('en-GB')} as used up…</button>
          )}
        </div>
      )}

      {p && p.total === 0 && <Empty>Nothing here. <Link href="/history">Back to the check</Link></Empty>}

      <ul class="consumable-list">
        {p?.lines.map((l) => {
          const d = done.value.get(l.id);
          return (
            <li key={l.id} class={d ? 'done' : ''} data-testid="consumable-row">
              {!d && <input type="checkbox" aria-label={`Select ${l.title_translated ?? l.title}`} checked={selected.value.has(l.id)} onChange={() => toggle(l.id)} />}
              <div class="c-text">
                <div class="top-title">{l.title_translated ?? l.title}</div>
                <div class="muted small">
                  {linePrice(l)} · {lineDate(l.ordered_at)} · {l.merchant ?? 'unknown shop'} ·{' '}
                  <span class="badge">{l.suggested_kind === 'supplies' ? 'household' : 'food'}</span>
                </div>
              </div>
              {d ? (
                <span class="small muted">{DONE_LABELS[d]}</span>
              ) : (
                <div class="c-actions">
                  <button class="secondary small-btn" onClick={() => void decide(l, 'used_up')}>Used up</button>
                  <button class="secondary small-btn" onClick={() => void decide(l, 'owned')}>Keep</button>
                  <button class="link small" onClick={() => void decide(l, 'not_consumable')}>not a consumable</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {p && p.lines.length < p.total && <button class="secondary wide" onClick={() => void load(true)}>Show more</button>}
    </main>
  );
}
