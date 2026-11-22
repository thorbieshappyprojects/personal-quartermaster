import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api, type SpendingReport } from '../api';
import { Empty, ErrorNote } from '../components/ui';
import { Link } from '../router';
import { eur, HistoryNav, lineDate, linePrice, REASON_LABELS } from './history-common';

// Series in fixed order; "unchecked" is neutral because it is not yet known.
const n = (count: number, one: string, many: string) => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;

const SERIES = [
  { key: 'owned', label: 'Still have', cls: 's-owned' },
  { key: 'gone', label: 'Gone (not consumables)', cls: 's-gone' },
  { key: 'used_up', label: 'Used up', cls: 's-used' },
  { key: 'pending', label: 'Unchecked', cls: 's-pending' },
] as const;

export function SpendingPage() {
  const report = useSignal<SpendingReport | null>(null);
  const error = useSignal<string | null>(null);
  const fxBusy = useSignal(false);

  const load = () => api.get<SpendingReport>('/api/v1/reports/spending').then((r) => (report.value = r), (e: Error) => (error.value = e.message));
  useEffect(() => void load(), []);

  async function refreshFx() {
    fxBusy.value = true;
    error.value = null;
    try {
      await api.post('/api/v1/fx/refresh');
      await load();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      fxBusy.value = false;
    }
  }

  const r = report.value;
  if (!r) return <main><HistoryNav /><h1>Spending</h1><ErrorNote error={error.value} />{!error.value && <p class="muted">Loading…</p>}</main>;
  const t = r.totals;
  const spent = t.all.eur_minor - t.ignored.eur_minor;
  if (t.all.count === 0) {
    return (
      <main>
        <HistoryNav />
        <h1>Spending</h1>
        <Empty>No purchases yet. <Link href="/history/import">Import your orders</Link>.</Empty>
      </main>
    );
  }
  const years = r.by_year.filter((y) => y.all - y.ignored > 0);
  const maxYear = Math.max(...years.map((y) => y.all - y.ignored), 1);

  return (
    <main class="spending">
      <HistoryNav />
      <h1>Spending</h1>
      <ErrorNote error={error.value} />

      <div class="hero" data-testid="gone-total">
        <div class="hero-label">Spent on things you no longer have (not counting consumables)</div>
        <div class="hero-value">{eur(t.gone.eur_minor)}</div>
        <div class="muted small">{n(t.gone.count, 'thing', 'things')} · {spent > 0 ? Math.round((t.gone.eur_minor / spent) * 100) : 0} % of all spending</div>
      </div>

      <div class="tiles">
        <Tile label="All spending" value={eur(spent)} sub={n(t.all.count - t.ignored.count, 'line', 'lines')} />
        <Tile label="Still have" value={eur(t.owned.eur_minor)} sub={n(t.owned.count, 'thing', 'things')} />
        <Tile label="Used up" value={eur(t.used_up.eur_minor)} sub={n(t.used_up.count, 'line', 'lines')} />
        <Tile label="Unchecked" value={eur(t.pending.eur_minor)} sub={n(t.pending.count, 'line', 'lines')} />
      </div>

      <div class="coverage" aria-label={`Checked: ${Math.round(r.coverage * 100)} % of spending`}>
        <div class="coverage-bar"><span style={{ width: `${Math.round(r.coverage * 100)}%` }} /></div>
        <span class="small muted">{Math.round(r.coverage * 100)} % of spending checked{t.pending.count > 0 && <> · <Link href="/history">continue checking</Link></>}</span>
      </div>

      {r.unconverted.count > 0 && (
        <p class="note small">
          {r.unconverted.count} lines in {r.unconverted.currencies.join(', ')} have no exchange rate yet and are not in these sums.{' '}
          <button class="link" disabled={fxBusy.value} onClick={refreshFx}>{fxBusy.value ? 'Fetching…' : 'Fetch ECB rates'}</button>
        </p>
      )}

      <h2 class="section">By year</h2>
      <ul class="legend" aria-label="Legend">
        {SERIES.map((s) => <li key={s.key}><span class={`swatch ${s.cls}`} aria-hidden="true" />{s.label}</li>)}
      </ul>
      <div class="year-bars" role="img" aria-label="Spending per year, split by what happened to the things; numbers in the table below">
        {years.map((y) => (
          <div class="year-row" key={y.year ?? 'none'}>
            <span class="year-label">{y.year ?? 'no date'}</span>
            <div class="bar" style={{ width: `${((y.all - y.ignored) / maxYear) * 100}%` }}>
              {SERIES.map((s) => y[s.key] > 0 && (
                <span key={s.key} class={`seg ${s.cls}`} style={{ flexGrow: y[s.key] }} title={`${y.year ?? 'no date'} · ${s.label}: ${eur(y[s.key])}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div class="table-wrap">
        <table class="report">
          <thead>
            <tr><th>Year</th><th class="num">Spent</th><th class="num">Still have</th><th class="num">Gone</th><th class="num">Used up</th><th class="num">Unchecked</th></tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.year ?? 'none'}>
                <td>{y.year ?? '—'}</td>
                <td class="num">{eur(y.all - y.ignored)}</td>
                <td class="num">{eur(y.owned)}</td>
                <td class="num"><strong>{eur(y.gone)}</strong></td>
                <td class="num">{eur(y.used_up)}</td>
                <td class="num">{eur(y.pending)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.by_reason.length > 0 && (
        <>
          <h2 class="section">Why things are gone</h2>
          <table class="report">
            <tbody>
              {r.by_reason.map((x) => (
                <tr key={x.reason ?? 'none'}>
                  <td>{x.reason ? REASON_LABELS[x.reason] : 'Gone (no reason given)'}</td>
                  <td class="num">{x.count}</td>
                  <td class="num">{eur(x.eur_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {r.top_gone.length > 0 && (
        <>
          <h2 class="section">Most expensive things you no longer have</h2>
          <ol class="top-list">
            {r.top_gone.map((l) => (
              <li key={l.id}>
                <div class="top-title">{l.item_name ?? l.title}</div>
                <div class="muted small">
                  {linePrice(l)} · {lineDate(l.ordered_at)} · {l.reason ? REASON_LABELS[l.reason].toLowerCase() : 'gone'}
                  {l.item_id && <> · <Link href={`/items/${l.item_id}`}>item</Link></>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      <h2 class="section">By shop</h2>
      <table class="report">
        <thead><tr><th>Shop</th><th class="num">Spent</th><th class="num">of it gone</th></tr></thead>
        <tbody>
          {r.by_merchant.map((m) => (
            <tr key={m.merchant ?? 'none'}>
              <td>{m.merchant ?? 'Unknown'}</td>
              <td class="num">{eur(m.eur_minor)}</td>
              <td class="num">{eur(m.gone_eur_minor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p class="muted small">
        Amounts in euros; other currencies use the ECB reference rate of the order day{r.fx.latest_day && <> (rates up to {lineDate(r.fx.latest_day)})</>}.
        Ignored and cancelled lines are left out. A thing marked "have it" and later sold or given away in the inventory moves to "gone".
      </p>
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div class="tile">
      <div class="tile-label">{label}</div>
      <div class="tile-value">{value}</div>
      <div class="muted small">{sub}</div>
    </div>
  );
}
