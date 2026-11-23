import { useSignal } from '@preact/signals';
import { formatAmount } from '@pq/core/browser';
import { useEffect } from 'preact/hooks';
import { api, type ImportRun } from '../api';
import { ErrorNote, Field } from '../components/ui';
import { Link } from '../router';
import { HistoryNav, lineDate } from './history-common';

type Mapping = Partial<Record<string, string>>;
type Rule = 'cancelled' | 'not_goods' | 'returned';
interface SampleLine {
  title: string;
  title_translated: string | null;
  ordered_at: string | null;
  merchant: string | null;
  quantity: number;
  amount_minor: number | null;
  currency: string | null;
  auto_close: Rule | null;
}
interface Preview {
  format: 'amazon_order_history' | 'amazon_order_pages' | 'taobao_orders' | 'generic';
  files: string[];
  headers: string[];
  mapping: Mapping;
  row_count: number;
  purchase_count: number;
  line_count: number;
  to_check: number;
  auto_closed: Record<Rule, number>;
  known_orders: number;
  spend_to_check: { currency: string; amount_minor: number }[];
  years: [number, number] | null;
  no_price: number;
  sample: SampleLine[];
  sample_closed: SampleLine[];
  errors: { row: number; message: string }[];
  error_count: number;
}
interface Entry {
  file: File;
  preview: Preview | null;
  mapping: Mapping | null;
  loading: boolean;
  error: string | null;
  result: ImportRun | null;
  importError: string | null;
}

const FORMAT_LABELS: Record<Preview['format'], string> = {
  amazon_order_history: 'Amazon data export',
  amazon_order_pages: 'Amazon order list',
  taobao_orders: 'Taobao order list',
  generic: 'Order list (columns detected)',
};
const RULE_LABELS: Record<Rule, string> = { cancelled: 'cancelled', not_goods: 'not goods (digital, apps, tickets, transfers, bills)', returned: 'returned or refunded' };

const FIELD_LABELS: [string, string][] = [
  ['title', 'Product title *'],
  ['title_translated', 'Translated title'],
  ['variant', 'Variant (size, colour)'],
  ['date', 'Order date'],
  ['amount', 'Line total'],
  ['unit_price', 'Unit price'],
  ['quantity', 'Quantity'],
  ['currency', 'Currency'],
  ['merchant', 'Shop'],
  ['order_id', 'Order number'],
  ['product_id', 'Product id (ASIN, SKU)'],
  ['url', 'Product link'],
  ['status', 'Order status'],
  ['category', 'Type or category'],
];

const n = (x: number) => x.toLocaleString('en-GB');
const money = (m: number, c: string) => formatAmount(m, c).replace(/\.\d+$/, '');

/**
 * Guided import: choose files, review what each file will become, import, then the next
 * steps. Nothing is saved before step 3; every file can be checked and fixed on its own.
 */
export function ImportPage() {
  const entries = useSignal<Entry[]>([]);
  const step = useSignal<'choose' | 'review' | 'done'>('choose');
  const skipKnown = useSignal(true);
  const importing = useSignal(false);
  const runs = useSignal<ImportRun[]>([]);

  useEffect(() => {
    api.get<ImportRun[]>('/api/v1/imports').then((r) => (runs.value = r), () => undefined);
  }, []);

  const update = (i: number, patch: Partial<Entry>) => {
    entries.value = entries.value.map((e, j) => (j === i ? { ...e, ...patch } : e));
  };

  async function previewOne(i: number, mapping: Mapping | null) {
    const e = entries.value[i];
    if (!e) return;
    update(i, { loading: true, error: null });
    try {
      const p = await api.uploadForm<Preview>('/api/v1/imports/preview', e.file, e.file.name, {
        ...(mapping ? { mapping: JSON.stringify(mapping) } : {}),
        default_currency: 'EUR',
      });
      update(i, { preview: p, mapping: p.mapping, loading: false });
    } catch (err) {
      update(i, { loading: false, error: (err as Error).message, preview: null });
    }
  }

  async function choose(list: FileList | null) {
    const files = list ? [...list] : [];
    if (!files.length) return;
    entries.value = files.map((file) => ({ file, preview: null, mapping: null, loading: true, error: null, result: null, importError: null }));
    step.value = 'review';
    await Promise.all(files.map((_, i) => previewOne(i, null)));
  }

  async function importAll() {
    importing.value = true;
    for (let i = 0; i < entries.value.length; i++) {
      const e = entries.value[i]!;
      if (!e.preview || e.result || !e.mapping?.title) continue;
      try {
        const run = await api.uploadForm<ImportRun>('/api/v1/imports', e.file, e.file.name, {
          mapping: JSON.stringify(e.mapping),
          default_currency: 'EUR',
          skip_known_orders: skipKnown.value ? '1' : '0',
        });
        update(i, { result: run });
      } catch (err) {
        update(i, { importError: (err as Error).message });
      }
    }
    importing.value = false;
    step.value = 'done';
    api.get<ImportRun[]>('/api/v1/imports').then((r) => (runs.value = r), () => undefined);
  }

  const list = entries.value;
  const ready = list.filter((e) => e.preview && e.mapping?.title);
  const totalToCheck = ready.reduce((s, e) => s + e.preview!.to_check, 0);
  const totalClosed = ready.reduce((s, e) => s + Object.values(e.preview!.auto_closed).reduce((a, b) => a + b, 0), 0);

  return (
    <main class="wizard">
      <HistoryNav />
      <h1>Import orders</h1>
      <ol class="steps" aria-label="Steps">
        <li class={step.value === 'choose' ? 'current' : 'done'}>Choose files</li>
        <li class={step.value === 'review' ? 'current' : step.value === 'done' ? 'done' : ''}>Review</li>
        <li class={step.value === 'done' ? 'current' : ''}>Check your things</li>
      </ol>

      {step.value === 'choose' && (
        <section>
          <p>
            Pick all your order files at once: CSV lists from shops, mails or PayPal, Taobao lists, or Amazon's data export (zip or
            <code> Retail.OrderHistory.1.csv</code>). Nothing is saved until you confirm in the next step.
          </p>
          <ul class="small muted">
            <li>Imported orders become <strong>purchase history</strong>. Things become inventory only when you tap "Have it" while checking.</li>
            <li>Cancelled, returned, digital and non-goods lines (apps, tickets, transfers, bills) are closed automatically and stay visible.</li>
            <li>The same order in two files is imported once. Importing a file again adds only what is new.</li>
          </ul>
          <label class="button primary wide file-button">
            Choose files…
            <input type="file" accept=".csv,.tsv,.txt,.zip,text/csv,application/zip" multiple class="visually-hidden" data-testid="import-file"
              onChange={(e) => void choose((e.target as HTMLInputElement).files)} />
          </label>
        </section>
      )}

      {step.value === 'review' && (
        <section>
          <p>
            Check each file below. Fix columns only where a file says it needs it. When everything looks right, import.
          </p>
          {list.map((e, i) => (
            <FileCard key={e.file.name + i} entry={e}
              onMapping={(m) => { update(i, { mapping: m }); void previewOne(i, m); }}
              onRemove={() => (entries.value = list.filter((_, j) => j !== i))} />
          ))}
          <label class="check-option">
            <input type="checkbox" checked={skipKnown.value} onChange={(e) => (skipKnown.value = (e.target as HTMLInputElement).checked)} />
            <span>Skip orders that are already in the history (recommended: different exports of the same order word titles differently)</span>
          </label>
          <div class="sticky-action">
            <button class="primary wide" data-testid="import-go" disabled={importing.value || ready.length === 0 || list.some((e) => e.loading)} onClick={importAll}>
              {importing.value ? 'Importing…' : `Import ${ready.length} ${ready.length === 1 ? 'file' : 'files'}: ${n(totalToCheck)} lines to check, ${n(totalClosed)} closed automatically`}
            </button>
            <button class="link" onClick={() => { entries.value = []; step.value = 'choose'; }}>Start over</button>
          </div>
        </section>
      )}

      {step.value === 'done' && <NextSteps entries={list} />}

      {runs.value.length > 0 && step.value !== 'review' && (
        <details class="earlier">
          <summary>Earlier imports ({runs.value.length})</summary>
          <ul class="plain small">
            {runs.value.slice(0, 30).map((r) => (
              <li key={r.id}>
                {new Date(r.created_at).toLocaleDateString('en-GB')} · {r.filename ?? r.source}: {n(r.lines_added)} new, {n(r.lines_existing)} already there
                {r.orders_skipped > 0 && <>, {n(r.orders_skipped)} orders skipped</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

function FileCard({ entry, onMapping, onRemove }: { entry: Entry; onMapping: (m: Mapping) => void; onRemove: () => void }) {
  const p = entry.preview;
  const needsTitle = !!p && !entry.mapping?.title;
  const status = entry.loading ? 'reading' : entry.error ? 'error' : needsTitle ? 'attention' : 'ok';
  return (
    <article class={`file-card ${status}`} data-testid="file-card">
      <header>
        <strong class="file-name">{entry.file.name}</strong>
        <span class={`pill pill-${status}`}>
          {status === 'reading' ? 'Reading…' : status === 'error' ? 'Cannot read' : status === 'attention' ? 'Pick the title column' : 'Ready'}
        </span>
        <button class="link small" onClick={onRemove} aria-label={`Leave out ${entry.file.name}`}>leave out</button>
      </header>
      <ErrorNote error={entry.error} />
      {p && (
        <>
          <p class="small">
            <strong>{FORMAT_LABELS[p.format]}</strong>
            {p.years && <> · {p.years[0] === p.years[1] ? p.years[0] : `${p.years[0]}–${p.years[1]}`}</>} · {n(p.line_count)} lines in {n(p.purchase_count)} orders
          </p>
          <ul class="facts-list">
            <li><strong>{n(p.to_check)}</strong> to check{p.spend_to_check.length > 0 && <> ({p.spend_to_check.map((s) => money(s.amount_minor, s.currency)).join(' + ')})</>}</li>
            {(Object.keys(p.auto_closed) as Rule[]).filter((r) => p.auto_closed[r] > 0).map((r) => (
              <li key={r}>{n(p.auto_closed[r])} {RULE_LABELS[r]}: closed automatically</li>
            ))}
            {p.known_orders > 0 && <li>{n(p.known_orders)} orders already in the history</li>}
            {p.no_price > 0 && <li class="muted">{n(p.no_price)} lines without a price</li>}
            {p.error_count > 0 && <li class="danger-text">{n(p.error_count)} rows with problems (see below)</li>}
          </ul>

          {p.sample.length > 0 && (
            <details>
              <summary>First lines to check</summary>
              <SampleTable lines={p.sample} />
            </details>
          )}
          {p.sample_closed.length > 0 && (
            <details>
              <summary>Examples of lines closed automatically</summary>
              <SampleTable lines={p.sample_closed} />
            </details>
          )}
          <details open={needsTitle}>
            <summary>Columns{p.format !== 'generic' ? ' (known layout)' : ''}</summary>
            <div class="mapping">
              {FIELD_LABELS.map(([key, label]) => (
                <Field key={key} label={label}>
                  <select value={entry.mapping?.[key] ?? ''}
                    onChange={(e) => onMapping({ ...entry.mapping, [key]: (e.target as HTMLSelectElement).value || undefined })}>
                    <option value="">—</option>
                    {p.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          </details>
          {p.error_count > 0 && (
            <details>
              <summary class="danger-text">Problems ({n(p.error_count)}): these rows are imported as far as possible</summary>
              <ul class="small">{p.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}</ul>
            </details>
          )}
        </>
      )}
      {entry.result && <p class="small" role="status">Imported: {n(entry.result.lines_added)} new lines.</p>}
      <ErrorNote error={entry.importError} />
    </article>
  );
}

function SampleTable({ lines }: { lines: SampleLine[] }) {
  return (
    <div class="table-wrap">
      <table class="sample">
        <tbody>
          {lines.map((s, i) => (
            <tr key={i}>
              <td>{s.ordered_at ? lineDate(s.ordered_at) : '—'}</td>
              <td>
                {s.quantity !== 1 && `${s.quantity} × `}
                {s.title_translated ?? s.title}
                {s.auto_close && <span class="badge"> {s.auto_close.replace('_', ' ')}</span>}
                <div class="muted small">{s.merchant ?? ''}</div>
              </td>
              <td class="num">{s.amount_minor != null && s.currency ? formatAmount(s.amount_minor, s.currency) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NextSteps({ entries }: { entries: Entry[] }) {
  const ok = entries.filter((e) => e.result);
  const failed = entries.filter((e) => e.importError);
  const sum = (k: 'lines_added' | 'lines_existing' | 'lines_auto_closed' | 'orders_skipped') => ok.reduce((s, e) => s + e.result![k], 0);
  const added = sum('lines_added');
  const closed = sum('lines_auto_closed');
  return (
    <section data-testid="import-result">
      <h2 class="section">Imported</h2>
      <p>
        <strong>{n(added)}</strong> new lines from {ok.length} {ok.length === 1 ? 'file' : 'files'}: <strong>{n(added - closed)}</strong> to check,{' '}
        {n(closed)} closed automatically
        {sum('lines_existing') > 0 && <>; {n(sum('lines_existing'))} were already there</>}
        {sum('orders_skipped') > 0 && <> ({n(sum('orders_skipped'))} orders from overlapping files)</>}.
      </p>
      {failed.map((e) => <p key={e.file.name} class="error">{e.file.name}: {e.importError}</p>)}

      <h2 class="section">Next steps</h2>
      <ol class="next-steps">
        <li>
          <Link href="/history">Check your things, most expensive first</Link>. One tap each: <em>Have it</em> puts it in the inventory, <em>Gone</em> keeps it in
          the history and the statistics, <em>Used up</em> is for consumables. The 50 most expensive lines take about 10 minutes.
        </li>
        <li>
          Before you start, set where "Have it" items go (on the check screen), e.g. your flat. You can move them later.
        </li>
        <li>
          Many cheap lines (groceries, drugstore, cables)? Open <em>Filter and sort</em> on the check screen and mark them in bulk, e.g. "everything under €10
          before 2022 as used up", or all lines of a grocery shop.
        </li>
        <li>
          Look at what was closed automatically: <Link href="/history?status=ignored">ignored lines</Link> and{' '}
          <Link href="/history?status=gone">returned lines</Link>. Any of them can be put back.
        </li>
        <li>
          <Link href="/history/spending">See your spending</Link>: it fills in as you check.
        </li>
      </ol>
      {added > 0 && <Link href="/history" class="button primary wide">Start checking</Link>}
    </section>
  );
}
