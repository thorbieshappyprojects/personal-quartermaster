import { STATE_LABELS, formatAmount, type ItemState } from '@pq/core/browser';
import type { ComponentChildren } from 'preact';
import type { Item } from '../api';
import { Link } from '../router';

export function StateBadge({ state }: { state: ItemState }) {
  if (state === 'owned') return null;
  return <span class={`badge badge-${state}`}>{STATE_LABELS[state]}</span>;
}

export function Path({ parts, empty = 'Location unknown' }: { parts: string[]; empty?: string }) {
  return <span class="path">{parts.length ? parts.join(' › ') : empty}</span>;
}

export function qtyLabel(i: Pick<Item, 'quantity' | 'unit'>): string {
  if (i.unit) return `${i.quantity} ${i.unit}`;
  return i.quantity === 1 ? '' : `${i.quantity} ×`;
}

export function price(i: Pick<Item, 'price_amount_minor' | 'price_currency'>): string | null {
  return i.price_amount_minor != null && i.price_currency ? formatAmount(i.price_amount_minor, i.price_currency) : null;
}

export function ItemCard({ item }: { item: Item }) {
  const thumb = item.photos[0]?.thumb_url;
  const q = qtyLabel(item);
  return (
    <Link href={`/items/${item.id}`} class={`card item-card${['owned', 'lent', 'unknown'].includes(item.state) ? '' : ' gone'}`}>
      <div class="thumb" aria-hidden="true">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span>{item.name.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div class="item-text">
        <div class="item-name">
          {q && <span class="qty">{q} </span>}
          {item.name} <StateBadge state={item.state} />
        </div>
        <Path parts={item.location_path} />
      </div>
    </Link>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" class="error">
      {error}
    </p>
  ) : null;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
