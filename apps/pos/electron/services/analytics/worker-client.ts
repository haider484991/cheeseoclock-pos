/**
 * The main process's side of the Reports worker (costing spec Phase 3):
 * one worker thread, one tab at a time, and the till never waits on it.
 *
 *  - Every request gets an id; the worker's answer is matched by it.
 *  - 30 seconds, then the caller is told the report took too long. The
 *    worker is watched on its own clock too: a tab it has been on for 30
 *    seconds without answering gets it replaced by a fresh one, even when
 *    nobody waits for that tab any more (superseded), so a hung query never
 *    holds up the tabs asked after it.
 *  - Superseded by kind: asking for a tab again with other dates (the owner
 *    tapping from "This year" to "Last year") drops the earlier ask of that
 *    tab: taken off the queue if it has not started, its answer thrown away
 *    if it has. The same ask twice (screen and "Print everything") shares
 *    one answer.
 *  - A worker that crashes is restarted (the tab it was on answers "try
 *    again"); one that crashes again and again, or never starts, is given
 *    up on: `state` says 'unavailable' and the handlers fall back to working
 *    reports out on the main process, 31 days at most (reports-handlers.ts).
 *  - Closing: `stop` asks the worker to close its read connection and waits
 *    (a couple of seconds at most) for the thread to end, so the till's own
 *    connection, closed after it, is the last one open and folds the
 *    write-ahead log into the database file.
 *
 * No Electron and no worker_threads here: the thread is made by `spawn`
 * (worker-host.ts in the till, a stand-in in the tests), so every rule above
 * is unit-tested (worker-client.test.ts).
 */
import path from 'node:path';
import { WORKER_FILE, type AnalyticsKind, type AnalyticsRequest, type WorkerReply, type WorkerRequest } from './worker-protocol.js';

/** What the client needs of a worker thread (node:worker_threads Worker has all of it). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  on(event: 'message', listener: (msg: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

export interface WorkerLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type AnalyticsWorkerState =
  /** Not started yet. */
  | 'idle'
  /** Opening its connection (at boot, or after a crash). */
  | 'starting'
  | 'ready'
  /** Given up on: reports are worked out on the main process (31 days at most). */
  | 'unavailable'
  /** The till is closing. */
  | 'stopped';

export type WorkerRunErrorCode =
  /** The same tab was asked for again with other dates. */
  | 'superseded'
  /** No answer in 30 seconds. */
  | 'timeout'
  /** The worker stopped while working on it (it restarts). */
  | 'crashed'
  /** The worker answered with an error. */
  | 'failed'
  /** There is no worker (never started, given up on, or closing). */
  | 'unavailable';

export class WorkerRunError extends Error {
  readonly code: WorkerRunErrorCode;
  constructor(code: WorkerRunErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkerRunError';
  }
}

export interface AnalyticsWorkerClientOptions {
  spawn: () => WorkerLike;
  log?: WorkerLog;
  /** How long a caller waits for its tab, and how long the worker may be on one tab. */
  runTimeoutMs?: number;
  /** How long a new worker may take to say it is ready. */
  startTimeoutMs?: number;
  /** How long closing waits for the thread (and its read connection) to end. */
  closeTimeoutMs?: number;
  /** Crashes within `crashWindowMs` before the worker is given up on. */
  maxCrashes?: number;
  crashWindowMs?: number;
}

export const RUN_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
/**
 * An idle worker closes in a few milliseconds. One in the middle of a long
 * query only reads the close when the query ends: the till does not wait
 * past this for it (the next start recovers the write-ahead log anyway).
 */
const CLOSE_TIMEOUT_MS = 2_000;

interface Job {
  id: number;
  kind: AnalyticsKind;
  /** The ask, for "the same ask twice". */
  key: string;
  request: unknown;
  nowIso: string;
  promise: Promise<unknown>;
  resolve: (data: unknown) => void;
  reject: (err: WorkerRunError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Answered already (or superseded / timed out): a late answer is dropped. */
  settled: boolean;
}

const quiet: WorkerLog = { info: () => {}, warn: () => {} };

/** Timers of the client must never keep the till's process alive on quit. */
function unrefd<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

export class AnalyticsWorkerClient {
  private readonly opts: Required<Omit<AnalyticsWorkerClientOptions, 'log'>> & { log: WorkerLog };
  private worker: WorkerLike | null = null;
  /** Bumped for every new worker: events of an earlier one are ignored. */
  private generation = 0;
  private current: AnalyticsWorkerState = 'idle';
  private reason: string | null = null;
  private readonly queue: Job[] = [];
  /** The job the worker is on (it may be settled already: superseded, or its caller timed out). */
  private running: Job | null = null;
  /**
   * The worker's own clock on `running`, from the moment it was sent until
   * its answer comes back, whether or not anyone still waits for it. Past
   * runTimeoutMs the worker is stuck, and is replaced.
   */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private crashes: number[] = [];
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private waiters: Array<(s: AnalyticsWorkerState) => void> = [];
  private nextId = 1;
  /** Resolves when the current thread has ended (its 'exit'). */
  private exited: Promise<void> = Promise.resolve();
  /** Threads already ended (replaced after a crash or a hang) that have not exited yet. */
  private readonly ending = new Set<Promise<void>>();
  private stopping: Promise<void> | null = null;

  constructor(opts: AnalyticsWorkerClientOptions) {
    this.opts = {
      spawn: opts.spawn,
      log: opts.log ?? quiet,
      runTimeoutMs: opts.runTimeoutMs ?? RUN_TIMEOUT_MS,
      startTimeoutMs: opts.startTimeoutMs ?? START_TIMEOUT_MS,
      closeTimeoutMs: opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
      maxCrashes: opts.maxCrashes ?? 3,
      crashWindowMs: opts.crashWindowMs ?? 60_000,
    };
  }

  get state(): AnalyticsWorkerState {
    return this.current;
  }

  /** Why the worker is not there ('unavailable'), in words for the log and the page. */
  get unavailableReason(): string | null {
    return this.reason;
  }

  /** Start the worker thread (once). */
  start(): void {
    if (this.current !== 'idle') return;
    this.spawnWorker();
  }

  /** Once the worker is ready or given up on (a worker still starting is waited for). */
  settled(): Promise<AnalyticsWorkerState> {
    if (this.current !== 'starting') return Promise.resolve(this.current);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * One tab's figures from the worker. Rejects with a WorkerRunError: the
   * caller decides what the owner is told, and whether the main process
   * works it out instead ('unavailable', 'crashed').
   */
  run<K extends AnalyticsKind>(kind: K, request: AnalyticsRequest<K>, nowIso: string = new Date().toISOString()): Promise<unknown> {
    if (this.current !== 'ready' && this.current !== 'starting') {
      return Promise.reject(new WorkerRunError('unavailable', this.reason ?? 'The report worker is not running'));
    }
    // The same ask: the same kind with the same period (or job); the clock is not part of it.
    const key = JSON.stringify([kind, request]);
    for (const other of [this.running, ...this.queue]) {
      if (!other || other.settled || other.kind !== kind) continue;
      if (other.key === key) return other.promise;
      this.settle(other, new WorkerRunError('superseded', 'A newer report was asked for'));
    }
    let resolve!: (data: unknown) => void;
    let reject!: (err: WorkerRunError) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { id: this.nextId++, kind, key, request, nowIso, promise, resolve, reject, timer: null, settled: false };
    job.timer = unrefd(setTimeout(() => this.timedOut(job), this.opts.runTimeoutMs));
    this.queue.push(job);
    this.pump();
    return promise;
  }

  /**
   * The till is closing: no more work, and the worker's read connection is
   * closed. Resolves once the thread has ended (or after closeTimeoutMs, when
   * it is in the middle of a long query): only then may the main process
   * close its own connection, so that one is the last to close and folds the
   * write-ahead log into the database file. Never rejects; calling it again
   * returns the same wait.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutDown();
    return this.stopping;
  }

  private async shutDown(): Promise<void> {
    this.current = 'stopped';
    this.reason = 'The till is closing';
    this.generation += 1;
    this.clearStartTimer();
    this.failAll(new WorkerRunError('unavailable', 'The till is closing'));
    this.notifyWaiters();
    const w = this.worker;
    this.worker = null;
    const threads = [...this.ending];
    if (w) {
      threads.push(this.exited);
      try {
        // Close the connection, then end: the worker's own way out.
        w.postMessage({ type: 'close' });
      } catch {
        // It is gone already: terminate below is all there is.
      }
    }
    if (threads.length === 0) return;
    const ended = await this.within(Promise.all(threads), this.opts.closeTimeoutMs);
    if (!ended) {
      this.opts.log.warn('analytics worker did not close in time; ending it', { ms: this.opts.closeTimeoutMs });
    }
    // Ended already: a no-op. Still in a long query: stopped when it returns
    // (better-sqlite3 closes its connection as the thread ends).
    if (w) void Promise.resolve(w.terminate()).catch(() => undefined);
  }

  /** Whether `p` settles within `ms` (never keeps the process alive). */
  private within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<boolean>((resolve) => {
      timer = unrefd(setTimeout(() => resolve(false), ms));
    });
    return Promise.race([p.then(() => true, () => true), late]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // ------------------------------------------------------------------ inside --

  private spawnWorker(): void {
    const gen = ++this.generation;
    this.current = 'starting';
    this.clearRunning();
    this.startedAt = Date.now();
    let w: WorkerLike;
    try {
      w = this.opts.spawn();
    } catch (e) {
      this.giveUp(`it could not be started (${errorText(e)})`);
      return;
    }
    this.worker = w;
    let markExited!: () => void;
    this.exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    // Whatever generation: closing waits for every thread's end.
    w.on('exit', () => markExited());
    this.clearStartTimer();
    this.startTimer = unrefd(
      setTimeout(() => {
        if (gen === this.generation && this.current === 'starting') {
          this.giveUp(`it did not start within ${Math.round(this.opts.startTimeoutMs / 1000)} s`);
        }
      }, this.opts.startTimeoutMs),
    );
    w.on('message', (msg) => {
      if (gen === this.generation) this.onMessage(msg);
    });
    w.on('error', (err) => {
      if (gen === this.generation) this.onStopped(`it stopped with an error (${errorText(err)})`);
    });
    w.on('exit', (code) => {
      if (gen === this.generation) this.onStopped(`it stopped (exit code ${code})`);
    });
  }

  private onMessage(raw: unknown): void {
    const msg = raw as WorkerReply;
    if (msg?.type === 'ready') {
      if (this.current !== 'starting') return;
      this.clearStartTimer();
      this.current = 'ready';
      this.reason = null;
      this.opts.log.info('analytics worker ready', { journalMode: msg.journalMode, ms: Date.now() - this.startedAt });
      this.notifyWaiters();
      this.pump();
    } else if (msg?.type === 'startFailed') {
      this.giveUp(msg.reason);
    } else if (msg?.type === 'result') {
      const job = this.running;
      if (!job || job.id !== msg.id) return;
      // Answered (even if nobody waits for it any more): the worker is free.
      this.clearRunning();
      if (msg.ok) this.settle(job, null, msg.data);
      else this.settle(job, new WorkerRunError('failed', msg.message));
      if (msg.ms >= 2_000) this.opts.log.info('analytics worker: slow report tab', { kind: job.kind, ms: msg.ms });
      this.pump();
    }
  }

  /** The thread ended or threw on its own. */
  private onStopped(why: string): void {
    if (this.current === 'starting') {
      this.giveUp(why);
      return;
    }
    if (this.current !== 'ready') return;
    const job = this.running;
    this.clearRunning();
    if (job) this.settle(job, new WorkerRunError('crashed', 'The report stopped part-way. Please try again.'));
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.opts.crashWindowMs), now];
    if (this.crashes.length >= this.opts.maxCrashes) {
      this.giveUp(`${why}, ${this.crashes.length} times in ${Math.round(this.opts.crashWindowMs / 1000)} s`);
      return;
    }
    this.opts.log.warn('analytics worker stopped; starting a new one', { why });
    this.endWorker();
    this.spawnWorker();
  }

  /** The caller's 30 s: it is told, and a worker stuck on this very job is replaced. */
  private timedOut(job: Job): void {
    if (job.settled) return;
    this.settle(job, new WorkerRunError('timeout', 'The report took too long'));
    if (this.running === job) this.replaceStuckWorker(job);
  }

  /**
   * The worker's 30 s on the job it is on, kept even after that job is
   * settled: a superseded job that hangs would otherwise hold the worker,
   * and every tab queued behind it, for good.
   */
  private watchdogFired(gen: number, job: Job): void {
    this.watchdog = null;
    if (gen !== this.generation || this.running !== job) return;
    this.settle(job, new WorkerRunError('timeout', 'The report took too long'));
    this.replaceStuckWorker(job);
  }

  /** Stuck on `job`: a fresh worker takes the rest of the queue. */
  private replaceStuckWorker(job: Job): void {
    if (this.current !== 'ready') return;
    this.opts.log.warn('analytics worker: no answer in time; starting a new one', { kind: job.kind, ms: this.opts.runTimeoutMs });
    this.clearRunning();
    this.endWorker();
    this.spawnWorker();
  }

  private giveUp(reason: string): void {
    this.clearStartTimer();
    this.current = 'unavailable';
    this.reason = reason;
    this.endWorker();
    this.opts.log.warn(`analytics worker failed, using main-thread fallback: ${reason}`);
    this.failAll(new WorkerRunError('unavailable', reason));
    this.notifyWaiters();
  }

  private pump(): void {
    if (this.current !== 'ready' || this.running !== null || !this.worker) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    const gen = this.generation;
    this.watchdog = unrefd(setTimeout(() => this.watchdogFired(gen, job), this.opts.runTimeoutMs));
    try {
      this.worker.postMessage({ type: 'run', id: job.id, kind: job.kind, request: job.request, nowIso: job.nowIso });
    } catch (e) {
      this.clearRunning();
      this.settle(job, new WorkerRunError('failed', errorText(e)));
      this.pump();
    }
  }

  /** The worker is on nothing (answered, crashed, replaced or closing). */
  private clearRunning(): void {
    this.running = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Answer a job once: its data, or why not. A job still queued leaves the queue. */
  private settle(job: Job, err: WorkerRunError | null, data?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const at = this.queue.indexOf(job);
    if (at >= 0) this.queue.splice(at, 1);
    if (err) job.reject(err);
    else job.resolve(data);
  }

  private failAll(err: WorkerRunError): void {
    if (this.running) this.settle(this.running, err);
    this.clearRunning();
    for (const job of [...this.queue]) this.settle(job, err);
  }

  /** End the current thread (a new one, if any, is started by the caller). */
  private endWorker(): void {
    this.generation += 1;
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    // Closing the till waits for this one's end too: its read connection is
    // only closed when the thread is (a hung one, when its query returns).
    const exited = this.exited;
    this.ending.add(exited);
    void exited.then(() => this.ending.delete(exited));
    void Promise.resolve(w.terminate()).catch(() => undefined);
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(this.current);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------- paths --

/**
 * The same path inside app.asar.unpacked: where electron-builder puts the
 * files listed in asarUnpack (the worker, better-sqlite3). Unchanged outside
 * an installed till (dev runs from out/main).
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

export interface WorkerPaths {
  /** The worker's script: the unpacked copy when there is one. */
  script: string;
  /** better-sqlite3's entry file (unpacked copy when there is one), or null to load it by name. */
  betterSqlite3: string | null;
  /** Its compiled .node file, or null to let better-sqlite3 look for it. */
  nativeBinding: string | null;
}

/**
 * Where the worker and SQLite are, from the main bundle's folder: in dev
 * out/main; in an installed till resources/app.asar/out/main, whose
 * worker and better-sqlite3 are read from app.asar.unpacked (a worker
 * thread's script and a native module are loaded from real files).
 */
export function resolveWorkerPaths(env: {
  mainDir: string;
  exists: (p: string) => boolean;
  /** require.resolve from the main bundle; throws when not found. */
  resolveModule: (id: string) => string;
}): WorkerPaths {
  const prefer = (p: string): string => {
    const unpacked = unpackedPath(p);
    return unpacked !== p && env.exists(unpacked) ? unpacked : p;
  };
  const script = prefer(path.join(env.mainDir, WORKER_FILE));
  let betterSqlite3: string | null = null;
  let nativeBinding: string | null = null;
  try {
    betterSqlite3 = prefer(env.resolveModule('better-sqlite3'));
    const pkgDir = path.dirname(env.resolveModule('better-sqlite3/package.json'));
    const binding = prefer(path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node'));
    nativeBinding = env.exists(binding) ? binding : null;
  } catch {
    // Not resolvable from here: the worker loads it by name.
  }
  return { script, betterSqlite3, nativeBinding };
}
