import { formatAmount, type GoneReason } from '@pq/core/browser';
import type { PurchaseLine } from '../api';
import { Link, pathname } from '../router';

export const REASON_LABELS: Record<GoneReason, string> = {
  sold: 'Sold',
  given_away: 'Given away',
  disposed: 'Thrown away / broke',
  lost: 'Lost',
  returned: 'Returned',
  consumed: 'Used up',
};
/** Reasons offered after "Gone" (used up has its own button), with their keyboard digits. */
export const GONE_CHOICES: GoneReason[] = ['sold', 'given_away', 'disposed', 'lost', 'returned'];

const eurFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const eur = (minor: number) => eurFmt.format(Math.round(minor / 100));

export function linePrice(l: Pick<PurchaseLine, 'amount_minor' | 'currency' | 'amount_eur_minor'>): string {
  if (l.amount_minor == null || !l.currency) return 'no price';
  const orig = formatAmount(l.amount_minor, l.currency);
  if (l.currency === 'EUR' || l.amount_eur_minor == null) return orig;
  return `${orig} ≈ ${formatAmount(l.amount_eur_minor, 'EUR')}`;
}

export function lineDate(d: string | null): string {
  if (!d) return 'date unknown';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function HistoryNav() {
  const p = pathname();
  const tab = (href: string, label: string) => (
    <Link href={href} class={p === href ? 'active' : ''} aria-current={p === href ? 'page' : undefined}>{label}</Link>
  );
  return (
    <nav class="subnav" aria-label="Purchase history">
      {tab('/history', 'Check')}
      {tab('/history/consumables', 'Consumables')}
      {tab('/history/spending', 'Spending')}
      {tab('/history/import', 'Import')}
    </nav>
  );
}
