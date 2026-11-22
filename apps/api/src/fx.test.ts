import { describe, expect, it } from 'vitest';
import { parseEcbCsv } from './fx';

describe('ECB rates', () => {
  it('parses the history CSV and skips N/A', () => {
    const csv = 'Date,USD,JPY,CYP,\n2024-01-03,1.0919,155.12,N/A,\n2024-01-02,1.0956,155.24,N/A,\n';
    expect(parseEcbCsv(csv)).toEqual([
      { currency: 'USD', day: '2024-01-03', perEur: 1.0919 },
      { currency: 'JPY', day: '2024-01-03', perEur: 155.12 },
      { currency: 'USD', day: '2024-01-02', perEur: 1.0956 },
      { currency: 'JPY', day: '2024-01-02', perEur: 155.24 },
    ]);
  });
});
