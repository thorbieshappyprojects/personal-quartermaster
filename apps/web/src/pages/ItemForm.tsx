import { useSignal } from '@preact/signals';
import { formatAmount, ITEM_STATES, parseAmount, STATE_LABELS, currencyExponent, type ItemKind, type ItemState } from '@pq/core/browser';
import { useEffect } from 'preact/hooks';
import { api, type Item } from '../api';
import { LocationPicker } from '../components/LocationPicker';
import { ErrorNote, Field, Path } from '../components/ui';
import { prepareUpload } from '../image';
import { navigate, query } from '../router';
import { categories, categoryOptions, locationPath, me, persons } from '../store';

const CURRENCIES = ['EUR', 'CNY', 'USD', 'GBP', 'CHF', 'JPY'];
const ATTRS = ['brand', 'model', 'size', 'colour', 'serial'] as const;

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const amountText = (minor: number | null, cur: string) => {
  if (minor == null) return '';
  const exp = currencyExponent(cur);
  return (minor / 10 ** exp).toFixed(exp);
};

/** Add (no id) or edit (with id). Unknown values stay empty; nothing is filled in by guessing. */
export function ItemFormPage({ id }: { id?: string }) {
  const loaded = useSignal(!id);
  const error = useSignal<string | null>(null);
  const saving = useSignal(false);
  const picking = useSignal(false);
  const more = useSignal(false);
  const photo = useSignal<File | null>(null);

  const name = useSignal(query('name') ?? '');
  const kind = useSignal<ItemKind | ''>('');
  const quantity = useSignal('1');
  const unit = useSignal('');
  const categoryId = useSignal<string>('');
  const locationId = useSignal<string | null>(query('location'));
  const belongsTo = useSignal('');
  const state = useSignal<ItemState>('owned');
  const amount = useSignal('');
  const currency = useSignal(me.value?.household.base_currency ?? 'EUR');
  const acquired = useSignal('');
  const url = useSignal('');
  const tags = useSignal('');
  const aliases = useSignal('');
  const notes = useSignal('');
  const attrs = useSignal<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    api.get<Item>(`/api/v1/items/${id}`).then((i) => {
      name.value = i.name;
      kind.value = i.kind;
      quantity.value = String(i.quantity);
      unit.value = i.unit ?? '';
      categoryId.value = i.category_id ?? '';
      locationId.value = i.location_id;
      belongsTo.value = i.belongs_to_person_id ?? '';
      state.value = i.state;
      currency.value = i.price_currency ?? currency.value;
      amount.value = amountText(i.price_amount_minor, currency.value);
      acquired.value = i.acquired_at ?? '';
      url.value = i.purchase_url ?? '';
      tags.value = i.tags.join(', ');
      aliases.value = i.aliases.join(', ');
      notes.value = i.notes ?? '';
      attrs.value = Object.fromEntries(Object.entries(i.attributes).map(([k, v]) => [k, v == null ? '' : String(v)]));
      more.value = Object.values(attrs.value).some(Boolean) || !!i.aliases.length;
      loaded.value = true;
    }, (err) => (error.value = (err as Error).message));
  }, [id]);

  const cat = categories.value.find((c) => c.id === categoryId.value);
  const effectiveKind: ItemKind = (kind.value || cat?.default_kind || 'durable') as ItemKind;

  async function save(e: Event) {
    e.preventDefault();
    error.value = null;
    const qty = Number(quantity.value.replace(',', '.'));
    if (!Number.isFinite(qty) || qty < 0) return void (error.value = 'Quantity must be a number of 0 or more.');
    let price: number | null = null;
    if (amount.value.trim()) {
      price = parseAmount(amount.value, currency.value);
      if (price === null) return void (error.value = `“${amount.value}” is not a clear ${currency.value} amount.`);
    }
    if (url.value.trim() && !/^https?:\/\//.test(url.value.trim())) return void (error.value = 'The purchase link must start with http:// or https://');
    const attributes = Object.fromEntries(Object.entries(attrs.value).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    const body = {
      name: name.value.trim(),
      kind: effectiveKind,
      quantity: qty,
      unit: unit.value.trim() || null,
      category_id: categoryId.value || null,
      location_id: locationId.value,
      belongs_to_person_id: belongsTo.value || null,
      state: state.value,
      price_amount_minor: price,
      price_currency: price === null ? null : currency.value,
      acquired_at: acquired.value || null,
      purchase_url: url.value.trim() || null,
      tags: list(tags.value),
      aliases: list(aliases.value),
      notes: notes.value.trim() || null,
      attributes,
    };
    saving.value = true;
    try {
      const item = id ? await api.patch<Item>(`/api/v1/items/${id}`, body) : await api.post<Item>('/api/v1/items', body);
      if (photo.value) {
        const { blob, name: fname } = await prepareUpload(photo.value);
        await api.upload(`/api/v1/items/${item.id}/photos`, blob, fname).catch((err: Error) => {
          // The item is saved; report the photo problem on its page instead of losing the entry.
          sessionStorage.setItem('pq-flash', `Saved, but the photo failed: ${err.message}`);
        });
      }
      navigate(`/items/${item.id}`, { replace: !id });
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      saving.value = false;
    }
  }

  if (!loaded.value) return <main>{error.value ? <ErrorNote error={error.value} /> : <p class="muted">Loading…</p>}</main>;

  const preview = price(amount.value, currency.value);
  return (
    <main>
      <h1>{id ? 'Edit item' : 'Add item'}</h1>
      <form onSubmit={save} class="form">
        <Field label="What is it?">
          <input required maxLength={200} autoFocus={!id} value={name.value} onInput={(e) => (name.value = (e.currentTarget as HTMLInputElement).value)} />
        </Field>

        <div class="field">
          <span class="label">Where is it?</span>
          <button type="button" class="picker" onClick={() => (picking.value = true)} data-testid="pick-location">
            <Path parts={locationPath(locationId.value)} empty="Choose a place (or leave unknown)" />
          </button>
        </div>

        <div class="row">
          <Field label="Quantity">
            <input inputMode="decimal" value={quantity.value} onInput={(e) => (quantity.value = (e.currentTarget as HTMLInputElement).value)} />
          </Field>
          <Field label="Unit" hint="pcs, pack, l …">
            <input maxLength={30} value={unit.value} onInput={(e) => (unit.value = (e.currentTarget as HTMLInputElement).value)} />
          </Field>
        </div>

        <Field label="Category">
          <select value={categoryId.value} onChange={(e) => (categoryId.value = (e.currentTarget as HTMLSelectElement).value)}>
            <option value="">— none —</option>
            {categoryOptions.value.map((o) => (
              <option key={o.node.id} value={o.node.id}>
                {' '.repeat(o.path.length - 1)}
                {o.node.name}
              </option>
            ))}
          </select>
        </Field>

        <fieldset class="segmented">
          <legend class="label">Kind</legend>
          {(['durable', 'supply'] as const).map((k) => (
            <label key={k}>
              <input type="radio" name="kind" checked={effectiveKind === k} onChange={() => (kind.value = k)} />
              <span>{k === 'durable' ? 'Thing (tracked one by one)' : 'Supply (counted stock)'}</span>
            </label>
          ))}
        </fieldset>

        <div class="row">
          <Field label="Price paid" hint={preview ?? undefined}>
            <input inputMode="decimal" placeholder="unknown" value={amount.value} onInput={(e) => (amount.value = (e.currentTarget as HTMLInputElement).value)} />
          </Field>
          <Field label="Currency">
            <select value={currency.value} onChange={(e) => (currency.value = (e.currentTarget as HTMLSelectElement).value)}>
              {[...new Set([currency.value, ...CURRENCIES])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>

        <div class="row">
          <Field label="Acquired on">
            <input type="date" value={acquired.value} onInput={(e) => (acquired.value = (e.currentTarget as HTMLInputElement).value)} />
          </Field>
          <Field label="Belongs to">
            <select value={belongsTo.value} onChange={(e) => (belongsTo.value = (e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Household</option>
              {persons.value.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {id && (
          <Field label="State">
            <select value={state.value} onChange={(e) => (state.value = (e.currentTarget as HTMLSelectElement).value as ItemState)}>
              {ITEM_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Photo">
          <input type="file" accept="image/*" capture="environment" onChange={(e) => (photo.value = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
        </Field>

        <Field label="Tags" hint="comma separated">
          <input value={tags.value} onInput={(e) => (tags.value = (e.currentTarget as HTMLInputElement).value)} />
        </Field>
        <Field label="Notes">
          <textarea rows={3} maxLength={5000} value={notes.value} onInput={(e) => (notes.value = (e.currentTarget as HTMLTextAreaElement).value)} />
        </Field>

        {more.value ? (
          <>
            <Field label="Purchase link">
              <input type="url" inputMode="url" placeholder="https://…" value={url.value} onInput={(e) => (url.value = (e.currentTarget as HTMLInputElement).value)} />
            </Field>
            <Field label="Other names" hint="comma separated, e.g. a German or original title">
              <input value={aliases.value} onInput={(e) => (aliases.value = (e.currentTarget as HTMLInputElement).value)} />
            </Field>
            {ATTRS.map((a) => (
              <Field key={a} label={a[0]!.toUpperCase() + a.slice(1)}>
                <input
                  maxLength={500}
                  value={attrs.value[a] ?? ''}
                  onInput={(e) => (attrs.value = { ...attrs.value, [a]: (e.currentTarget as HTMLInputElement).value })}
                />
              </Field>
            ))}
          </>
        ) : (
          <button type="button" class="link" onClick={() => (more.value = true)}>
            More details (link, other names, brand, model, size, colour, serial)
          </button>
        )}

        <ErrorNote error={error.value} />
        <div class="actions">
          <button type="button" class="secondary" onClick={() => history.back()}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={saving.value}>
            {saving.value ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {picking.value && (
        <LocationPicker
          title="Where is it?"
          current={locationId.value}
          allowUnknown
          onPick={(v) => {
            locationId.value = v;
            picking.value = false;
          }}
          onClose={() => (picking.value = false)}
        />
      )}
    </main>
  );
}

function price(text: string, cur: string): string | null {
  if (!text.trim()) return null;
  const minor = parseAmount(text, cur);
  return minor === null ? 'not a clear amount' : `= ${formatAmount(minor, cur)}`;
}
