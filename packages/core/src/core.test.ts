import { describe, expect, it } from 'vitest';
import {
  canNest,
  checkPlacement,
  descendantIds,
  extractSearchTerms,
  formatAmount,
  indexById,
  normaliseText,
  parseAmount,
  pathNames,
  summariseFind,
  toPrefixTsQuery,
  wouldCreateCycle,
  type LocationNode,
} from './index';

const nodes: LocationNode[] = [
  { id: 'flat', parent_id: null, name: 'Flat', kind: 'site' },
  { id: 'kitchen', parent_id: 'flat', name: 'Kitchen', kind: 'room' },
  { id: 'drawer', parent_id: 'kitchen', name: 'Drawer 2', kind: 'spot' },
  { id: 'box', parent_id: 'drawer', name: 'Battery box', kind: 'container' },
  { id: 'car', parent_id: null, name: 'Car', kind: 'site' },
];

describe('trees and locations', () => {
  it('builds paths and descendants', () => {
    const idx = indexById(nodes);
    expect(pathNames(idx, 'box')).toEqual(['Flat', 'Kitchen', 'Drawer 2', 'Battery box']);
    expect([...descendantIds(nodes, 'kitchen')].sort()).toEqual(['box', 'drawer']);
  });

  it('detects cycles', () => {
    expect(wouldCreateCycle(nodes, 'kitchen', 'box')).toBe(true);
    expect(wouldCreateCycle(nodes, 'kitchen', 'kitchen')).toBe(true);
    expect(wouldCreateCycle(nodes, 'drawer', 'flat')).toBe(false);
  });

  it('applies nesting rules', () => {
    expect(canNest(null, 'site')).toBe(true);
    expect(canNest('site', 'site')).toBe(false);
    expect(canNest(null, 'room')).toBe(false);
    expect(canNest('site', 'spot')).toBe(true); // glovebox in a car
    expect(canNest('spot', 'room')).toBe(false);
    expect(canNest('container', 'container')).toBe(true);
    expect(checkPlacement(nodes, { kind: 'spot', parentId: 'car' })).toBeNull();
    expect(checkPlacement(nodes, { kind: 'room', parentId: 'nope' })).toBe('parent_not_found');
    expect(checkPlacement(nodes, { id: 'kitchen', kind: 'room', parentId: 'drawer' })).toBe('invalid_nesting');
    expect(checkPlacement(nodes, { id: 'box', kind: 'container', parentId: 'box' })).toBe('cycle');
    // Turning the kitchen into a container would break its spot child.
    expect(checkPlacement(nodes, { id: 'kitchen', kind: 'container', parentId: 'flat' })).toBe('invalid_nesting');
  });
});

describe('money', () => {
  it.each([
    ['12,99', 'EUR', 1299],
    ['12.99', 'EUR', 1299],
    ['12', 'EUR', 1200],
    ['12.5', 'USD', 1250],
    ['1.234,50', 'EUR', 123450],
    ['1,234.50', 'USD', 123450],
    ['1.234', 'EUR', 123400],
    ['1.234.567', 'EUR', 123456700],
    ['€ 9,90', 'EUR', 990],
    ['1500', 'JPY', 1500],
    ['199.5', 'CNY', 19950],
    ['1.234', 'KWD', 1234],
    ['12.999', 'USD', 1299900],
  ])('parses %s %s', (input, cur, minor) => {
    expect(parseAmount(input, cur)).toBe(minor);
  });

  it.each([['-5', 'EUR'], ['abc', 'EUR'], ['12.9999', 'USD'], ['1,23,4', 'EUR'], ['12.5', 'JPY'], ['12,', 'EUR'], ['1234.567,5', 'EUR'], ['', 'EUR']])(
    'rejects %s %s',
    (input, cur) => {
      expect(parseAmount(input, cur)).toBeNull();
    },
  );

  it('formats in the currency exponent', () => {
    expect(formatAmount(1299, 'EUR', 'en-GB')).toBe('€12.99');
    expect(formatAmount(1500, 'JPY', 'en-GB')).toBe('JP¥1,500');
  });
});

describe('search', () => {
  it('normalises like the database', () => {
    expect(normaliseText('  Kreissäge  Straße ')).toBe('kreissage strasse');
  });

  it.each([
    ['Do we have AA batteries?', 'aa batteries'],
    ['do we still have any camping stove', 'camping stove'],
    ['Where is the drill?', 'drill'],
    ['Haben wir noch Glühbirnen?', 'gluhbirnen'],
    ['Is there a spare HDMI cable', 'spare hdmi cable'],
    ['hammer', 'hammer'],
  ])('extracts terms from %s', (q, terms) => {
    expect(extractSearchTerms(q)).toBe(terms);
  });

  it('builds safe prefix queries', () => {
    expect(toPrefixTsQuery('AA batt')).toBe('aa:* & batt:*');
    expect(toPrefixTsQuery("o'reilly & | !")).toBe('o:* & reilly:*');
    expect(toPrefixTsQuery('  ?! ')).toBeNull();
  });

  it('summarises answers from matched rows only', () => {
    const base = { unit: null, acquired_at: null, location_path: ['Flat', 'Kitchen'] };
    expect(summariseFind('drill', [])).toBe('Nothing found for "drill".');
    expect(summariseFind('drill', [{ ...base, name: 'Drill', state: 'sold', quantity: 1 }])).toBe(
      'No "drill" in the inventory any more (1 earlier entry).',
    );
    expect(
      summariseFind('aa', [
        { ...base, name: 'AA batteries', state: 'owned', quantity: 6, unit: 'pcs', acquired_at: '2026-03-01' },
        { ...base, name: 'AA charger', state: 'lent', quantity: 1, location_path: [], acquired_at: '2025-01-01' },
      ]),
    ).toBe('Yes: 6 pcs AA batteries (Flat › Kitchen); AA charger (location unknown, lent out). Last acquired 2026-03-01.');
  });
});
