import { expect, test } from 'bun:test';
import { projectCashReference } from './cash';
import type { Quote } from 'gloomberb/types/financials';

test('cash comparison uses a dated completed close and keeps the observed session', () => {
  const quote: Quote = { symbol: 'TSLA', price: 255, currency: 'USD', change: 5, changePercent: 2, lastUpdated: 1000, regularClose: 250, regularCloseSessionDate: '2026-10-02', marketState: 'CLOSED' };
  expect(projectCashReference(quote, 260, 'TSLA')).toMatchObject({ price: 250, sessionDate: '2026-10-02', label: 'Last cash close', premium: 0.040000000000000036 });
  expect(projectCashReference({ ...quote, regularCloseSessionDate: undefined }, 260, 'TSLA')?.price).toBe(255);
  expect(projectCashReference({ ...quote, currency: 'EUR' }, 260, 'TSLA')).toBeNull();
  expect(projectCashReference(quote, 260, 'AAPL')).toBeNull();
  expect(projectCashReference({ ...quote, lastUpdated: 0 }, 260, 'TSLA')).toBeNull();
});
