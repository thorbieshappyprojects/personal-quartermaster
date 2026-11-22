import { useSignal } from '@preact/signals';
import { formatAmount } from '@pq/core/browser';
import { useEffect } from 'preact/hooks';
import { api, type ImportRun } from '../api';
import { ErrorNote, Field } from '../components/ui';
import { Link } from '../router';
import { HistoryNav, lineDate } from './history-common';

type Mapping = Partial<Record<string, string>>;
interface Preview {
  format: 'amazon_order_history' | 'generic';
  files: string[];
  headers: string[];
  mapping: Mapping;
  row_count: number;
  purchase_count: number;
  line_count: number;
  currencies: string[];
  sample: { title: string; ordered_at: string | null; merchant: string | null; quantity: number; amount_minor: number | null; currency: string | null; cancelled: boolean }[];
  errors: { row: number; message: string }[];
  error_count: number;
}

const FIELD_LABELS: [string, string, boolean][] = [
  ['title', 'Product title', true],
  ['date', 'Order date', false],
  ['amount', 'Line total', false],
  ['unit_price', 'Unit price', false],
  ['quantity', 'Quantity', false],
  ['currency', 'Currency', false],
  ['merchant', 'Shop', false],
  ['order_id', 'Order number', false],
  ['product_id', 'Product id (ASIN, SKU)', false],
  ['url', 'Product link', false],
  ['status', 'Order status (cancelled lines are closed)', false],
];

export function ImportPage() {
  const files = useSignal<File[]>([]);
  const preview = useSignal<Preview | null>(null);
  const mapping = useSignal<Mapping | null>(null);
  const defaultCurrency = useSignal('EUR');
  const defaultMerchant = useSignal('');
  const dateOrder = useSignal('');
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const results = useSignal<{ name: string; run?: ImportRun; error?: string }[]>([]);
  const runs = useSignal<ImportRun[]>([]);

  const loadRuns = () => api.get<ImportRun[]>('/api/v1/imports').then((r) => (runs.value = r), () => undefined);
  useEffect(() => void loadRuns(), []);

  const fields = (withMapping: boolean) => ({
    ...(withMapping && mapping.value ? { mapping: JSON.stringify(mapping.value) } : {}),
    default_currency: defaultCurrency.value.trim().toUpperCase(),
    default_merchant: defaultMerchant.value.trim(),
    date_order: dateOrder.value,
  });

  async function runPreview(withMapping: boolean) {
    const f = files.value[0];
    if (!f) return;
    busy.value = true;
    error.value = null;
    try {
      const p = await api.uploadForm<Preview>('/api/v1/imports/preview', f, f.name, fields(withMapping));
      preview.value = p;
      mapping.value = p.mapping;
    } catch (err) {
      error.value = (err as Error).message;
      preview.value = null;
    } finally {
      busy.value = false;
    }
  }

  async function choose(list: FileList | null) {
    files.value = list ? [...list] : [];
    preview.value = null;
    mapping.value = null;
    results.value = [];
    if (files.value.length === 1) await runPreview(false);
  }

  async function doImport() {
    busy.value = true;
    error.value = null;
    const out: typeof results.value = [];
    for (const f of files.value) {
      try {
        const run = await api.uploadForm<ImportRun>('/api/v1/imports', f, f.name, fields(files.value.length === 1));
        out.push({ name: f.name, run });
      } catch (err) {
        out.push({ name: f.name, error: (err as Error).message });
      }
      results.value = [...out];
    }
    busy.value = false;
    files.value = [];
    preview.value = null;
    void loadRuns();
  }

  const p = preview.value;
  const added = results.value.reduce((s, r) => s + (r.run?.lines_added ?? 0), 0);

  return (
    <main>
      <HistoryNav />
      <h1>Import orders</h1>
      <p class="muted small">
        CSV files from shops, or Amazon's data export (the zip, or <code>Retail.OrderHistory.1.csv</code> from it). Several files at once are fine.
        Importing the same file again only adds what is new. Imported orders go to the check, not straight into the inventory.
      </p>

      <label class="button primary wide file-button">
        Choose files…
        <input type="file" accept=".csv,.tsv,.txt,.zip,text/csv,application/zip" multiple class="visually-hidden" data-testid="import-file"
          onChange={(e) => void choose((e.target as HTMLInputElement).files)} />
      </label>

      <ErrorNote error={error.value} />
      {busy.value && <p class="muted">Reading…</p>}

      {files.value.length > 1 && (
        <section>
          <p>{files.value.length} files selected: columns are detected in each file. For a file with unusual columns, import it alone to map them.</p>
          <ImportDefaults currency={defaultCurrency} merchant={defaultMerchant} />
          <button class="primary wide" disabled={busy.value} onClick={doImport}>Import {files.value.length} files</button>
        </section>
      )}

      {p && files.value.length === 1 && (
        <section class="form">
          <p data-testid="import-summary">
            <strong>{p.format === 'amazon_order_history' ? 'Amazon order history' : 'Order list'}</strong>: {p.line_count.toLocaleString('en-GB')} lines in{' '}
            {p.purchase_count.toLocaleString('en-GB')} orders{p.currencies.length > 0 && <> · {p.currencies.join(', ')}</>}
            {p.files.length > 1 && <> · from {p.files.length} files in the zip</>}
          </p>

          {p.format === 'generic' && mapping.value && (
            <details open={!p.mapping.title}>
              <summary>Columns {p.mapping.title ? '(detected, change if needed)' : '(please pick at least the title)'}</summary>
              <div class="mapping">
                {FIELD_LABELS.map(([key, label, required]) => (
                  <Field key={key} label={label + (required ? ' *' : '')}>
                    <select value={mapping.value?.[key] ?? ''}
                      onChange={(e) => {
                        mapping.value = { ...mapping.value, [key]: (e.target as HTMLSelectElement).value || undefined };
                        void runPreview(true);
                      }}>
                      <option value="">—</option>
                      {p.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <ImportDefaults currency={defaultCurrency} merchant={defaultMerchant} onChange={() => void runPreview(true)} />
              <Field label="Dates are written">
                <select value={dateOrder.value} onChange={(e) => { dateOrder.value = (e.target as HTMLSelectElement).value; void runPreview(true); }}>
                  <option value="">detect (day first if unclear)</option>
                  <option value="dmy">day.month.year</option>
                  <option value="mdy">month/day/year</option>
                </select>
              </Field>
            </details>
          )}

          <table class="sample">
            <caption class="muted small">First lines as they will be imported</caption>
            <thead><tr><th>Date</th><th>Title</th><th class="num">Price</th></tr></thead>
            <tbody>
              {p.sample.map((s, i) => (
                <tr key={i} class={s.cancelled ? 'muted' : ''}>
                  <td>{s.ordered_at ? lineDate(s.ordered_at) : '—'}</td>
                  <td>{s.quantity !== 1 && `${s.quantity} × `}{s.title}{s.cancelled && ' (cancelled)'}<div class="muted small">{s.merchant ?? ''}</div></td>
                  <td class="num">{s.amount_minor != null && s.currency ? formatAmount(s.amount_minor, s.currency) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {p.error_count > 0 && (
            <details>
              <summary class="danger-text">{p.error_count} rows with problems (imported where possible)</summary>
              <ul class="small">{p.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}</ul>
            </details>
          )}

          <button class="primary wide" disabled={busy.value || !mapping.value?.title} onClick={doImport} data-testid="import-go">
            Import {p.line_count.toLocaleString('en-GB')} lines
          </button>
        </section>
      )}

      {results.value.length > 0 && (
        <section data-testid="import-result">
          <h2 class="section">Imported</h2>
          <ul class="plain">
            {results.value.map((r) => (
              <li key={r.name}>
                <strong>{r.name}</strong>:{' '}
                {r.run ? (
                  <>
                    {r.run.lines_added} new lines{r.run.lines_existing > 0 && <>, {r.run.lines_existing} already there</>}
                    {r.run.lines_auto_closed > 0 && <>, {r.run.lines_auto_closed} cancelled (closed)</>}
                    {r.run.errors.length > 0 && <>, {r.run.errors.length} problems</>}
                  </>
                ) : (
                  <span class="danger-text">{r.error}</span>
                )}
              </li>
            ))}
          </ul>
          {added > 0 && <Link href="/history" class="button primary wide">Start checking</Link>}
        </section>
      )}

      {runs.value.length > 0 && (
        <>
          <h2 class="section">Earlier imports</h2>
          <ul class="plain small">
            {runs.value.slice(0, 20).map((r) => (
              <li key={r.id}>
                {new Date(r.created_at).toLocaleDateString('en-GB')} · {r.filename ?? r.source}: {r.lines_added} new, {r.lines_existing} already there
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function ImportDefaults(props: { currency: { value: string }; merchant: { value: string }; onChange?: () => void }) {
  return (
    <div class="row">
      <Field label="Currency if the file has none">
        <input value={props.currency.value} maxLength={3} autoCapitalize="characters"
          onChange={(e) => { props.currency.value = (e.target as HTMLInputElement).value; props.onChange?.(); }} />
      </Field>
      <Field label="Shop if the file has none">
        <input value={props.merchant.value} placeholder="e.g. Otto"
          onChange={(e) => { props.merchant.value = (e.target as HTMLInputElement).value; props.onChange?.(); }} />
      </Field>
    </div>
  );
}
