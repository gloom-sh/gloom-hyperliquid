import { describe, expect, test } from 'bun:test';
import { LocalTwapScheduler, type LocalTwapJob } from './twap';
import type { TicketRequest, TradingResult } from '../trading/types';

const ticket: TicketRequest = { market: { coin: 'BTC', assetId: 0, dex: '', mark: 100, maxLeverage: 20, szDecimals: 3, onlyIsolated: false },
  clientId: 'offline-schedule', accountAddress: '0x0000000000000000000000000000000000000001', kind: 'twap', side: 'buy', size: '1.2', sizeUnit: 'coin',
  leverage: 2, marginMode: 'cross', twapMinutes: 5, twapRandomize: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function filled(size: string): TradingResult { return { clientId: '', state: 'accepted', at: 0, message: 'Accepted', response: { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: size } }] } } } }; }
function harness() {
  let clock = 0, persisted: LocalTwapJob[] = [], owner = false, releases = 0, failWrite = false;
  const submitted: TicketRequest[] = [];
  let mark = async () => 100;
  let execute = async (request: TicketRequest) => filled(String(request.size));
  let beforeWrite: (() => Promise<void>) | undefined;
  const scheduler = () => new LocalTwapScheduler({ automatic: false, now: () => clock, random: () => 1,
    read: async () => structuredClone(persisted), write: async jobs => { await beforeWrite?.(); if (failWrite) throw new Error('Disk full'); persisted = structuredClone(jobs); },
    acquire: async () => { if (owner) throw new Error('Another process owns the journal'); owner = true; return async () => { owner = false; releases++; }; },
    mark: () => mark(), execute: request => { submitted.push(request); return execute(request); },
  });
  return { scheduler, submitted, get persisted() { return persisted; }, get owner() { return owner; }, get releases() { return releases; },
    clock: (value: number) => { clock = value; }, mark: (value: typeof mark) => { mark = value; }, execute: (value: typeof execute) => { execute = value; },
    write: (value?: () => Promise<void>) => { beforeWrite = value; }, fail: (value: boolean) => { failWrite = value; } };
}

// Every executor below is a local double. No exchange client, key or network request is created.
describe('local TWAP safety', () => {
  test('partial fills remain within total quantity, use unique slice ids, and finish at the planned end', async () => {
    const h = harness(), scheduler = h.scheduler();
    h.execute(async request => h.submitted.length === 1 ? filled('0.06') : filled(String(request.size)));
    const job = await scheduler.start(ticket, '1.2', 120);
    for (let i = 0; i < job.slices; i++) { const current = scheduler.getJobs()[0]!; h.clock(current.nextTime); await scheduler.runDue(); }
    const completed = scheduler.getJobs()[0]!;
    expect(completed.status).toBe('completed'); expect(completed.executed).toBe('1.2');
    expect(new Set(h.submitted.map(request => request.clientId)).size).toBe(job.slices);
    expect(h.submitted.every(request => request.kind === 'market' && request.sizeUnit === 'coin')).toBe(true);
    expect(completed.nextTime).toBe(301_000);
    await scheduler.dispose(); expect(h.releases).toBe(1);
  });
  test('cancel during price lookup sends no order and retains canceled status', async () => {
    const h = harness(), scheduler = h.scheduler(), quote = deferred<number>(), entered = deferred<void>();
    h.mark(async () => { entered.resolve(); return quote.promise; });
    const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime);
    const running = scheduler.runDue(); await entered.promise; await scheduler.cancel(job.id); quote.resolve(100); await running;
    expect(h.submitted).toHaveLength(0); expect(scheduler.getJobs()[0]?.status).toBe('canceled');
    await scheduler.dispose();
  });
  test('cancel while the pending slice journal is being saved sends no order', async () => {
    const h = harness(), scheduler = h.scheduler(), writing = deferred<void>(), release = deferred<void>();
    const job = await scheduler.start(ticket, '1.2', 120);
    let first = true;
    h.write(async () => { if (first) { first = false; writing.resolve(); await release.promise; } });
    h.clock(job.nextTime); const running = scheduler.runDue(); await writing.promise;
    const cancellation = scheduler.cancel(job.id);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    release.resolve(); await Promise.all([running, cancellation]);
    expect(h.submitted).toHaveLength(0); expect(h.persisted[0]?.status).toBe('canceled'); expect(h.persisted[0]?.pending).toBeUndefined();
    await scheduler.dispose();
  });
  test('dispose waits for an in-flight slice, accounts for its fill and never resumes after restart', async () => {
    const h = harness(), scheduler = h.scheduler(), outcome = deferred<TradingResult>(), entered = deferred<void>();
    h.execute(async () => { entered.resolve(); return outcome.promise; });
    const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime);
    const running = scheduler.runDue(); await entered.promise;
    const disposing = scheduler.dispose(); expect(scheduler.dispose()).toBe(disposing); expect(h.owner).toBe(true);
    outcome.resolve(filled('0.12')); await Promise.all([running, disposing]);
    expect(h.persisted[0]).toMatchObject({ status: 'paused', executed: '0.12', nextSlice: 1 }); expect(h.owner).toBe(false);
    const restarted = h.scheduler(); await restarted.ready; h.clock(1_000_000); await restarted.runDue(); expect(h.submitted).toHaveLength(1);
    await restarted.dispose(); expect(h.releases).toBe(1);
  });
  test('shutdown while a quote is pending prevents submission and cannot resume implicitly', async () => {
    const h = harness(), scheduler = h.scheduler(), quote = deferred<number>(), entered = deferred<void>();
    h.mark(async () => { entered.resolve(); return quote.promise; });
    const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime);
    const running = scheduler.runDue(); await entered.promise; const disposing = scheduler.dispose(); quote.resolve(100);
    await Promise.all([running, disposing]); expect(h.submitted).toHaveLength(0); expect(h.persisted[0]?.status).toBe('paused');
  });
  test('unknown outcome survives restart, blocks resume and is never resent', async () => {
    const h = harness(), scheduler = h.scheduler();
    h.execute(async () => ({ clientId: '', state: 'unknown', at: 0, message: 'Timeout' }));
    const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime); await scheduler.runDue();
    expect(scheduler.getJobs()[0]).toMatchObject({ status: 'paused', executed: '0', pending: { clientId: `${ticket.clientId}:slice:0` } });
    await scheduler.dispose(); const restarted = h.scheduler(); await restarted.ready;
    await expect(restarted.resume(job.id)).rejects.toThrow('No retry'); await restarted.runDue(); expect(h.submitted).toHaveLength(1);
    await restarted.cancel(job.id); await restarted.dispose();
  });
  test('cancel during uncertain reconciliation cannot be overwritten by paused status', async () => {
    const h = harness(), scheduler = h.scheduler(), outcome = deferred<TradingResult>(), entered = deferred<void>();
    h.execute(async () => { entered.resolve(); return outcome.promise; });
    const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime); const running = scheduler.runDue(); await entered.promise;
    await scheduler.cancel(job.id); outcome.resolve({ clientId: '', state: 'accepted', at: 0, message: 'Found', response: [{ status: 'order' }] }); await running;
    expect(scheduler.getJobs()[0]?.status).toBe('canceled'); expect(scheduler.getJobs()[0]?.pending).toBeDefined(); await scheduler.dispose();
  });
  test('malformed, resting or oversized fill responses fail closed without retry', async () => {
    for (const response of [{}, { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } }, filled('9').response, filled('NaN').response, filled('').response]) {
      const h = harness(), scheduler = h.scheduler(); h.execute(async () => ({ clientId: '', state: 'accepted', at: 0, message: 'Accepted', response }));
      const job = await scheduler.start(ticket, '1.2', 120); h.clock(job.nextTime); await scheduler.runDue();
      expect(scheduler.getJobs()[0]?.status).toBe('paused'); expect(scheduler.getJobs()[0]?.pending).toBeDefined();
      await expect(scheduler.resume(job.id)).rejects.toThrow('No retry'); expect(h.submitted).toHaveLength(1); await scheduler.dispose();
    }
  });
  test('journal write failure blocks submission and further scheduling', async () => {
    const h = harness(), scheduler = h.scheduler(); const job = await scheduler.start(ticket, '1.2', 120);
    h.fail(true); h.clock(job.nextTime); await scheduler.runDue(); expect(h.submitted).toHaveLength(0);
    await expect(scheduler.resume(job.id)).rejects.toThrow('persistence failed');
    h.fail(false); await scheduler.dispose(); expect(h.owner).toBe(false);
  });
  test('a second process cannot cancel, resume, overwrite, or dispose the owning journal', async () => {
    const h = harness(), first = h.scheduler(); const job = await first.start(ticket, '1.2', 120);
    const second = h.scheduler(); await second.ready;
    await expect(second.cancel(job.id)).rejects.toThrow('Another process');
    await expect(second.resume(job.id)).rejects.toThrow('Another process');
    await expect(second.start({ ...ticket, clientId: 'other' }, '1.2', 120)).rejects.toThrow('Another process');
    await second.dispose(); expect(h.persisted[0]?.status).toBe('running'); expect(h.owner).toBe(true);
    await first.dispose();
  });
  test('reopening rereads the journal under its lease and filters account rows', async () => {
    const h = harness(), first = h.scheduler(); const job = await first.start(ticket, '1.2', 120);
    const second = h.scheduler(); await second.ready;
    await first.cancel(job.id); await first.dispose();
    await expect(second.resume(job.id)).rejects.toThrow('Only a paused');
    expect(second.rows(ticket.accountAddress)).toHaveLength(1); expect(second.rows('0x0000000000000000000000000000000000000002')).toHaveLength(0);
    await second.dispose();
  });
  test('jitter stays within its scheduled interval and preserves the final end time', async () => {
    const h = harness(), scheduler = h.scheduler(); const job = await scheduler.start({ ...ticket, twapRandomize: true }, '1.2', 120);
    h.clock(job.nextTime); await scheduler.runDue();
    expect(scheduler.getJobs()[0]!.nextTime).toBeCloseTo(1000 + job.intervalMs * 1.1, 8);
    for (let i = 1; i < job.slices; i++) { h.clock(scheduler.getJobs()[0]!.nextTime); await scheduler.runDue(); }
    expect(scheduler.getJobs()[0]!.nextTime).toBe(301_000); expect(scheduler.getJobs()[0]!.status).toBe('completed'); await scheduler.dispose();
  });
  test('long sleep pauses missed slices instead of sending overdue orders', async () => {
    const h = harness(), scheduler = h.scheduler(); const job = await scheduler.start(ticket, '1.2', 120);
    h.clock(3_600_000); await scheduler.runDue(); expect(h.submitted).toHaveLength(0); expect(scheduler.getJobs()[0]?.status).toBe('paused');
    await scheduler.resume(job.id); h.clock(scheduler.getJobs()[0]!.nextTime); await scheduler.runDue(); expect(h.submitted).toHaveLength(1); await scheduler.dispose();
  });
  test('duplicate starts return a detached existing job and cannot add caller fields to the journal', async () => {
    const h = harness(), scheduler = h.scheduler(); const first = await scheduler.start({ ...ticket, unrelated: 'not an order field' } as TicketRequest, '1.2', 120);
    first.ticket.market.coin = 'ETH'; const second = await scheduler.start(ticket, '8', 800);
    expect(second.total).toBe('1.2'); expect(second.ticket.market.coin).toBe('BTC'); expect('unrelated' in h.persisted[0]!.ticket).toBe(false);
    await scheduler.dispose();
  });
});
