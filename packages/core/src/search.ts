import { IN_POSSESSION, type ItemState } from './lifecycle';

/** Lower-case, accents removed, whitespace collapsed (matches the database's search_text). */
export function normaliseText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Question phrasing that carries no search meaning, in English and German.
const FILLER = [
  /^(do|did) we (still )?(have|own|got)( any| a| an| some)?\b/,
  /^(have|has) we got( any| a| an| some)?\b/,
  /^(where is|where are|where's|wo ist|wo sind)( the| my| our| der| die| das| mein| meine| unser| unsere)?\b/,
  /^(haben wir|hab ich|habe ich)( noch)?( ein| eine| einen| welche)?\b/,
  /^(is there|are there|gibt es)( any| a| an| some| noch)?\b/,
];

/** Turns "Do we have AA batteries?" into "aa batteries". */
export function extractSearchTerms(question: string): string {
  let q = normaliseText(question).replace(/[?!.]+$/g, '').trim();
  for (const re of FILLER) q = q.replace(re, '').trim();
  return q;
}

/** Prefix full-text query ("aa:* & batteries:*"), or null if nothing searchable is left. */
export function toPrefixTsQuery(terms: string): string | null {
  const tokens = normaliseText(terms)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}:*`).join(' & ');
}

export interface FoundItem {
  name: string;
  state: ItemState;
  quantity: number;
  unit: string | null;
  location_path: string[];
  acquired_at: string | null;
}


/** One-sentence answer for "do we have X?", built only from the matched rows. */
export function summariseFind(terms: string, items: readonly FoundItem[]): string {
  const have = items.filter((i) => IN_POSSESSION.includes(i.state) || i.state === 'unknown');
  if (have.length === 0) {
    const gone = items.length;
    return gone ? `No "${terms}" in the inventory any more (${gone} earlier ${gone === 1 ? 'entry' : 'entries'}).` : `Nothing found for "${terms}".`;
  }
  const where = (i: FoundItem) => (i.location_path.length ? i.location_path.join(' › ') : 'location unknown');
  const parts = have.slice(0, 3).map((i) => {
    const q = i.unit ? `${i.quantity} ${i.unit} ` : i.quantity !== 1 ? `${i.quantity} × ` : '';
    const lent = i.state === 'lent' ? ', lent out' : i.state === 'unknown' ? ', not confirmed' : '';
    return `${q}${i.name} (${where(i)}${lent})`;
  });
  const more = have.length > 3 ? ` and ${have.length - 3} more` : '';
  const dates = have.map((i) => i.acquired_at).filter((d): d is string => !!d).sort();
  const last = dates.length ? ` Last acquired ${dates[dates.length - 1]}.` : '';
  return `Yes: ${parts.join('; ')}${more}.${last}`;
}

