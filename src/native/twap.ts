import Decimal from "decimal.js";
import { roundSize } from "../trading/math";
import type { TicketRequest, TradingResult } from "../trading/types";

export type LocalTwapStatus = "running" | "paused" | "completed" | "canceled";
export interface LocalTwapJob {
  id: string;
  ticket: TicketRequest;
  total: string;
  executed: string;
  slices: number;
  nextSlice: number;
  intervalMs: number;
  nextTime: number;
  startedAt: number;
  status: LocalTwapStatus;
  reason?: string;
  pending?: { clientId: string; size: string };
  updatedAt: number;
}
interface Options {
  read: () => Promise<LocalTwapJob[]>;
  write: (jobs: LocalTwapJob[]) => Promise<void>;
  acquire: (id: string) => Promise<() => Promise<void>>;
  execute: (ticket: TicketRequest) => Promise<TradingResult>;
  mark: (coin: string) => Promise<number>;
  now?: () => number;
  random?: () => number;
  automatic?: boolean;
  onChange?: () => void;
}
const clone = <T>(value: T): T => structuredClone(value);
const uncertain =
  "Slice outcome needs review. No retry. Inspect Orders and Fills, then cancel this schedule.";

/** A local slice is exactly one IOC order, with no attached legs or resting remainder. */
export function confirmedFillSize(response: unknown): number {
  const raw = response as any;
  const statuses =
    raw?.response?.type === "order" ? raw.response.data?.statuses : undefined;
  if (!Array.isArray(statuses) || statuses.length !== 1)
    throw new Error(uncertain);
  const status = statuses[0];
  if (typeof status?.error === "string" && !status.filled && !status.resting)
    return 0;
  if (status?.error || status?.resting) throw new Error(uncertain);
  const rawSize = status?.filled?.totalSz;
  const size =
    typeof rawSize === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawSize)
      ? Number(rawSize)
      : NaN;
  if (!Number.isFinite(size) || size < 0) throw new Error(uncertain);
  return size;
}

/** Persisted local IOC schedule. Restarts and uncertain outcomes never resume automatically. */
export class LocalTwapScheduler {
  private jobs = new Map<string, LocalTwapJob>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = new Map<string, Promise<void>>();
  private disposed = false;
  private storageFailed = false;
  private releaseOwner?: () => Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private saves: Promise<void> = Promise.resolve();
  private disposing?: Promise<void>;
  private now: () => number;
  readonly ready: Promise<void>;

  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.ready = this.restore();
  }
  private async restore() {
    const jobs = await this.options.read();
    const next = new Map<string, LocalTwapJob>();
    for (const saved of jobs) {
      const job = clone(saved);
      if (
        !job?.ticket?.clientId ||
        job.id !== `local:${job.ticket.clientId}` ||
        !["running", "paused", "completed", "canceled"].includes(job.status) ||
        !new Decimal(job.total).isPositive() ||
        !new Decimal(job.total).isFinite() ||
        !new Decimal(job.executed).isFinite() ||
        new Decimal(job.executed).isNegative() ||
        new Decimal(job.executed).gt(job.total) ||
        !Number.isInteger(job.nextSlice) ||
        job.nextSlice < 0 ||
        !Number.isInteger(job.slices) ||
        job.slices < 2 ||
        !Number.isFinite(job.intervalMs) ||
        job.intervalMs <= 0
      )
        throw new Error(
          "Invalid local TWAP journal. Review local trading state before sending orders.",
        );
      if (job.status === "running") {
        job.status = "paused";
        job.reason = job.pending
          ? uncertain
          : "Gloom restarted. Resume explicitly to send remaining slices.";
      }
      next.set(job.id, job);
    }
    this.jobs = next;
    this.notify();
  }
  getJobs() {
    return [...this.jobs.values()].map(clone);
  }
  rows(accountAddress?: string) {
    return this.getJobs()
      .filter(
        (job) =>
          !accountAddress ||
          job.ticket.accountAddress?.toLowerCase() ===
            accountAddress.toLowerCase(),
      )
      .map((job) => ({
        twapId: job.id,
        local: true,
        state: {
          coin: job.ticket.market.coin,
          side: job.ticket.side === "buy" ? "B" : "A",
          sz: job.total,
          executedSz: job.executed,
          minutes: job.ticket.twapMinutes,
          reduceOnly: Boolean(job.ticket.reduceOnly),
        },
        status: { status: job.status },
        reason: job.reason,
        nextTime: job.status === "running" ? job.nextTime : undefined,
      }));
  }
  private notify() {
    try {
      this.options.onChange?.();
    } catch {}
  }
  private assertOpen() {
    if (this.disposed) throw new Error("Local TWAP scheduler is closed.");
    if (this.storageFailed)
      throw new Error(
        "Local TWAP persistence failed. Reopen Gloom and review the schedule before resuming.",
      );
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations
      .catch(() => {})
      .then(async () => {
        await this.ready;
        this.assertOpen();
        return operation();
      });
    this.mutations = result;
    return result;
  }
  /** One owner for the whole journal prevents separate processes overwriting each other's schedules. */
  private async ownJournal() {
    if (!this.releaseOwner) {
      const release = await this.options.acquire("local-twap-scheduler");
      try {
        await this.restore();
        this.assertOpen();
        this.releaseOwner = release;
      } catch (error) {
        await release();
        throw error;
      }
    }
    this.assertOpen();
  }
  private save() {
    const snapshot = this.getJobs();
    this.saves = this.saves
      .catch(() => {})
      .then(() => this.options.write(snapshot))
      .catch((error) => {
        this.storageFailed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const job of this.jobs.values())
          if (job.status === "running") {
            job.status = "paused";
            job.reason =
              "Local TWAP persistence failed. Reopen Gloom and inspect Orders and Fills.";
          }
        this.notify();
        throw error;
      });
    return this.saves;
  }
  private changed() {
    this.notify();
    this.arm();
  }
  private canRun(job: LocalTwapJob) {
    return !this.disposed && !this.storageFailed && job.status === "running";
  }
  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.storageFailed || this.options.automatic === false)
      return;
    const times = [...this.jobs.values()]
      .filter((job) => this.canRun(job) && !this.active.has(job.id))
      .map((job) => job.nextTime);
    if (times.length)
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.runDue().catch(() => {});
        },
        Math.max(50, Math.min(...times) - this.now()),
      );
  }
  start(ticket: TicketRequest, total: string, notional: number) {
    return this.mutate(async () => {
      await this.ownJournal();
      const id = `local:${ticket.clientId}`,
        existing = this.jobs.get(id);
      if (existing) return clone(existing);
      if (this.jobs.size >= 1000)
        throw new Error(
          "The local TWAP journal is full. Keep existing records and contact support before creating another schedule.",
        );
      const duration = (ticket.twapMinutes ?? 0) * 60_000;
      const size = new Decimal(total);
      if (
        !ticket.clientId ||
        ticket.clientId.length > 170 ||
        !ticket.accountAddress ||
        !size.isFinite() ||
        !size.isPositive() ||
        !Number.isFinite(notional) ||
        notional <= 0 ||
        !Number.isInteger(ticket.twapMinutes) ||
        duration < 300_000 ||
        duration > 86_400_000
      )
        throw new Error("Invalid local TWAP schedule.");
      const slices = Math.min(
        400,
        Math.floor(duration / 30_000),
        Math.floor(notional / 12),
      );
      if (slices < 2)
        throw new Error(
          "A local TWAP needs at least $24 so each slice clears the minimum order size.",
        );
      const now = this.now();
      // Only order fields enter the journal; arbitrary caller fields can never persist credentials.
      const safeTicket: TicketRequest = {
        market: clone(ticket.market),
        clientId: ticket.clientId,
        accountAddress: ticket.accountAddress,
        side: ticket.side,
        kind: "twap",
        size: total,
        sizeUnit: "coin",
        leverage: ticket.leverage,
        marginMode: ticket.marginMode,
        reduceOnly: ticket.reduceOnly,
        twapMinutes: ticket.twapMinutes,
        twapRandomize: ticket.twapRandomize ?? true,
      };
      const job: LocalTwapJob = {
        id,
        ticket: safeTicket,
        total,
        executed: "0",
        slices,
        nextSlice: 0,
        intervalMs: duration / (slices - 1),
        nextTime: now + 1000,
        startedAt: now,
        status: "running",
        updatedAt: now,
      };
      this.jobs.set(id, job);
      await this.save();
      this.changed();
      return clone(job);
    });
  }
  resume(id: string) {
    return this.mutate(async () => {
      await this.ownJournal();
      const job = this.jobs.get(id);
      if (!job) throw new Error("Local TWAP not found.");
      if (job.status !== "paused")
        throw new Error("Only a paused local TWAP can resume.");
      if (job.pending) throw new Error(uncertain);
      if (this.active.has(id))
        throw new Error("Wait for the current slice outcome before resuming.");
      job.status = "running";
      job.reason = undefined;
      job.nextTime = this.now() + 1000;
      job.updatedAt = this.now();
      // Explicit resume rebases only the remaining schedule; missed slices never replay in a burst.
      job.startedAt = this.now() - job.nextSlice * job.intervalMs;
      await this.save();
      this.changed();
      return clone(job);
    });
  }
  cancel(id: string) {
    return this.mutate(async () => {
      await this.ownJournal();
      const job = this.jobs.get(id);
      if (!job) throw new Error("Local TWAP not found.");
      if (job.status === "completed" || job.status === "canceled")
        return clone(job);
      job.status = "canceled";
      job.reason = this.active.has(id)
        ? "Future slices canceled. A slice already submitted may still fill."
        : "Future slices canceled.";
      job.updatedAt = this.now();
      await this.save();
      this.changed();
      return clone(job);
    });
  }
  async runDue() {
    await this.ready;
    if (this.disposed || this.storageFailed) return;
    for (const job of this.jobs.values())
      if (
        this.canRun(job) &&
        job.nextTime <= this.now() &&
        !this.active.has(job.id)
      ) {
        const task = this.runSlice(job);
        this.active.set(job.id, task);
        try {
          await task;
        } finally {
          this.active.delete(job.id);
        }
      }
    this.arm();
  }
  private async runSlice(job: LocalTwapJob) {
    try {
      if (this.now() - job.nextTime > job.intervalMs) {
        job.status = "paused";
        job.reason =
          "The schedule fell behind. Resume explicitly to send the remaining slices.";
        await this.save();
        return;
      }
      const remaining = new Decimal(job.total).sub(job.executed),
        slots = Math.max(1, job.slices - job.nextSlice);
      const mark = await this.options.mark(job.ticket.market.coin);
      if (!this.canRun(job)) return;
      if (!Number.isFinite(mark) || mark <= 0)
        throw new Error("A current positive market price is required.");
      const size = roundSize(
        remaining.div(slots).toFixed(),
        job.ticket.market.szDecimals,
      );
      if (Number(size) * mark < 10 && !job.ticket.reduceOnly) {
        job.status = "paused";
        job.reason =
          "Remaining slice is below $10 at the current price. Cancel and resize the remaining quantity.";
        await this.save();
        return;
      }
      const clientId = `${job.ticket.clientId}:slice:${job.nextSlice}`;
      job.pending = { clientId, size };
      job.updatedAt = this.now();
      await this.save();
      if (!this.canRun(job)) {
        job.pending = undefined;
        await this.save();
        return;
      }
      const result = await this.options.execute({
        ...clone(job.ticket),
        kind: "market",
        size,
        sizeUnit: "coin",
        clientId,
      });
      if (result.state === "unknown" || Array.isArray(result.response)) {
        if (job.status !== "canceled") job.status = "paused";
        job.reason = uncertain;
        await this.save();
        return;
      }
      const filled =
        result.state === "rejected" &&
        (result.response as any)?.status === "err"
          ? 0
          : confirmedFillSize(result.response);
      if (
        new Decimal(filled).gt(size) ||
        new Decimal(job.executed).add(filled).gt(job.total)
      )
        throw new Error(
          "Exchange fill exceeds the scheduled quantity. Inspect the account.",
        );
      job.executed = new Decimal(job.executed).add(filled).toFixed();
      job.updatedAt = this.now();
      job.pending = undefined;
      job.nextSlice++;
      if (result.state === "rejected") {
        if (job.status !== "canceled") job.status = "paused";
        job.reason =
          "Slice rejected. Inspect the order result before resuming the remaining quantity.";
      } else if (job.status === "canceled") {
        /* The in-flight fill is accounted for; future slices remain canceled. */
      } else if (this.disposed || this.storageFailed) {
        job.status = "paused";
        job.reason =
          "Gloom closed. Resume explicitly to send remaining slices.";
      } else if (
        new Decimal(job.total)
          .sub(job.executed)
          .lessThan(new Decimal(10).pow(-job.ticket.market.szDecimals))
      ) {
        job.status = "completed";
        job.reason = undefined;
      } else if (job.nextSlice >= job.slices) {
        job.status = "paused";
        job.reason =
          "Schedule ended with an unfilled remainder. Resume to try the remaining quantity.";
      } else {
        const end =
          job.startedAt + 1000 + (job.ticket.twapMinutes ?? 0) * 60_000;
        const random = Math.max(
          0,
          Math.min(1, (this.options.random ?? Math.random)()),
        );
        const jitter =
          job.ticket.twapRandomize && job.nextSlice < job.slices - 1
            ? (random - 0.5) * 0.2 * job.intervalMs
            : 0;
        const planned = Math.min(
          end,
          job.startedAt + 1000 + job.nextSlice * job.intervalMs + jitter,
        );
        if (planned <= this.now()) {
          job.status = "paused";
          job.reason =
            "The schedule fell behind. Resume explicitly to send the remaining slices.";
        } else {
          job.nextTime = planned;
          job.reason =
            filled < Number(size)
              ? "Last slice partially filled; remainder is included in later slices."
              : undefined;
        }
      }
      await this.save();
    } catch {
      if (job.status !== "canceled") job.status = "paused";
      job.reason = job.pending
        ? uncertain
        : "Local TWAP paused before submission. Check market and account availability before resuming.";
      job.updatedAt = this.now();
      await this.save().catch(() => {});
    } finally {
      this.changed();
    }
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.disposing = (async () => {
      try {
        await this.ready;
        await this.mutations.catch(() => {});
        for (const job of this.jobs.values())
          if (job.status === "running") {
            job.status = "paused";
            job.reason = job.pending
              ? uncertain
              : "Gloom closed. Resume explicitly to send remaining slices.";
            job.updatedAt = this.now();
          }
        await Promise.allSettled([...this.active.values()]);
        if (this.releaseOwner) await this.save();
      } finally {
        const release = this.releaseOwner;
        this.releaseOwner = undefined;
        await release?.();
      }
    })();
    return this.disposing;
  }
}
