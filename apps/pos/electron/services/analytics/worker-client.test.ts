/**
 * The main process's side of the Reports worker (costing spec Phase 3),
 * with a stand-in worker thread: ids pair answers with questions, the 30 s
 * timeout (and a fresh worker after it), superseding by kind, the same ask
 * shared, a crash answered and the worker restarted, too many crashes or a
 * failed start given up on (and said so in the log), and where the files
 * are in dev and in an installed till.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { BusinessReportRequest } from '@cheeseoclock/shared-types';
import { AnalyticsWorkerClient, resolveWorkerPaths, unpackedPath, WorkerRunError, type WorkerLike } from './worker-client.js';
import type { RunRequest, WorkerRequest } from './worker-protocol.js';

type Listener = (arg: never) => void;

/**
 * A worker thread stand-in: records what it is sent; the test says what it
 * answers. Like a real thread, it ends ('exit') on a close request (unless
 * `busy`: in the middle of a long query it does not read it) and when
 * terminated.
 */
class FakeWorker implements WorkerLike {
  readonly sent: RunRequest[] = [];
  closeAsked = false;
  terminated = false;
  exited = false;
  busy = false;
  private readonly listeners = new Map<string, Listener[]>();
  postMessage(msg: WorkerRequest): void {
    if (msg.type === 'close') {
      this.closeAsked = true;
      if (!this.busy) queueMicrotask(() => this.exit(0));
      return;
    }
    this.sent.push(msg);
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    if (!this.busy) queueMicrotask(() => this.exit(1));
    return Promise.resolve(1);
  }
  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
  emit(event: 'message' | 'error' | 'exit', arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) (l as (a: unknown) => void)(arg);
  }
  ready(): void {
    this.emit('message', { type: 'ready', journalMode: 'wal', ms: 3 });
  }
  answer(id: number, data: unknown): void {
    this.emit('message', { type: 'result', id, ok: true, data, ms: 5 });
  }
}

const DAY: BusinessReportRequest = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' };
const YEAR: BusinessReportRequest = { sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' };
const LAST_YEAR: BusinessReportRequest = { sinceIso: '2025-01-01T00:00:00.000Z', untilIso: '2026-01-01T00:00:00.000Z' };

function setup(opts: { maxCrashes?: number; runTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const client = new AnalyticsWorkerClient({
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    log,
    ...opts,
  });
  const latest = () => workers[workers.length - 1]!;
  return { client, workers, latest, log };
}

/** Let promise callbacks run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Reports worker client', () => {
  it('starts one worker, says so in the log, and answers each ask by its id', async () => {
    const { client, workers, latest, log } = setup();
    client.start();
    client.start();
    expect(workers).toHaveLength(1);
    expect(client.state).toBe('starting');
    const settled = client.settled();
    latest().ready();
    expect(await settled).toBe('ready');
    expect(log.info).toHaveBeenCalledWith('analytics worker ready', expect.objectContaining({ journalMode: 'wal' }));

    const a = client.run('overview', DAY);
    const b = client.run('menu', DAY);
    // One at a time: the worker is single-threaded, the next waits in the main process.
    expect(latest().sent.map((m) => m.kind)).toEqual(['overview']);
    const [first] = latest().sent;
    expect(first).toMatchObject({ type: 'run', kind: 'overview', request: DAY });
    latest().answer(first!.id, { tab: 'overview' });
    await expect(a).resolves.toEqual({ tab: 'overview' });
    expect(latest().sent.map((m) => m.kind)).toEqual(['overview', 'menu']);
    // An answer for an id nobody is waiting on is ignored.
    latest().answer(9_999, { tab: 'nobody' });
    latest().answer(latest().sent[1]!.id, { tab: 'menu' });
    await expect(b).resolves.toEqual({ tab: 'menu' });
  });

  it('asks made while the worker starts wait for it', async () => {
    const { client, latest } = setup();
    client.start();
    const p = client.run('when', DAY);
    expect(latest().sent).toHaveLength(0);
    latest().ready();
    expect(latest().sent.map((m) => m.kind)).toEqual(['when']);
    latest().answer(latest().sent[0]!.id, 'figures');
    await expect(p).resolves.toBe('figures');
  });

  it('30 seconds without an answer: the caller is told, and a stuck worker is replaced', async () => {
    const { client, workers, latest } = setup();
    client.start();
    latest().ready();
    const slow = client.run('team', YEAR);
    const slowCaught = slow.catch((e: unknown) => e);
    vi.advanceTimersByTime(20_000);
    // Asked 20 s later, behind it.
    const waiting = client.run('menu', DAY);
    vi.advanceTimersByTime(9_999);
    await flush();
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const err = (await slowCaught) as WorkerRunError;
    expect(err).toBeInstanceOf(WorkerRunError);
    expect(err.code).toBe('timeout');
    // The stuck worker is ended and a fresh one takes the queue.
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(client.state).toBe('starting');
    latest().ready();
    expect(latest().sent.map((m) => m.kind)).toEqual(['menu']);
    // The first worker's late answer changes nothing.
    workers[0]!.answer(workers[0]!.sent[0]!.id, 'late');
    latest().answer(latest().sent[0]!.id, 'menu figures');
    await expect(waiting).resolves.toBe('menu figures');
  });

  it('asking for a tab again with other dates drops the earlier ask: off the queue, or its answer thrown away', async () => {
    const { client, workers, latest } = setup();
    client.start();
    latest().ready();
    const busy = client.run('overview', DAY);
    const thisYear = client.run('menu', YEAR).catch((e: unknown) => e);
    const lastYear = client.run('menu', { sinceIso: '2025-01-01T00:00:00.000Z', untilIso: '2026-01-01T00:00:00.000Z' });
    expect(((await thisYear) as WorkerRunError).code).toBe('superseded');
    latest().answer(latest().sent[0]!.id, 'overview figures');
    await expect(busy).resolves.toBe('overview figures');
    // The superseded ask never reached the worker.
    expect(latest().sent.map((m) => [m.kind, (m.request as { sinceIso: string }).sinceIso])).toEqual([
      ['overview', DAY.sinceIso],
      ['menu', '2025-01-01T00:00:00.000Z'],
    ]);
    latest().answer(latest().sent[1]!.id, 'last year');
    await expect(lastYear).resolves.toBe('last year');

    // Already running: the caller is let go at once, the late answer is dropped.
    const running = client.run('when', YEAR).catch((e: unknown) => e);
    const newer = client.run('when', DAY);
    expect(((await running) as WorkerRunError).code).toBe('superseded');
    const [runningMsg] = latest().sent.slice(-1);
    expect(runningMsg!.request).toEqual(YEAR);
    latest().answer(runningMsg!.id, 'year figures (too late)');
    expect(latest().sent.slice(-1)[0]!.request).toEqual(DAY);
    latest().answer(latest().sent.slice(-1)[0]!.id, 'day figures');
    await expect(newer).resolves.toBe('day figures');
    // Every ask was answered in time: the worker is never taken for stuck.
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(1);
    expect(client.state).toBe('ready');
  });

  it('a superseded tab the worker hangs on still gets the worker replaced: the tabs asked after it are served by a fresh one', async () => {
    const { client, workers, latest, log } = setup();
    client.start();
    latest().ready();
    // Food cost & stock for "This year"; 10 s later the owner taps "Last year".
    const thisYear = client.run('foodStock', YEAR).catch((e: unknown) => e);
    vi.advanceTimersByTime(10_000);
    const lastYear = client.run('foodStock', LAST_YEAR);
    expect(((await thisYear) as WorkerRunError).code).toBe('superseded');
    // Nobody waits for "This year" any more, but the worker is still on it, and never answers.
    expect(workers[0]!.sent.map((m) => m.request)).toEqual([YEAR]);
    vi.advanceTimersByTime(19_999);
    expect(workers).toHaveLength(1);
    // 30 s after it was sent: stuck, replaced.
    vi.advanceTimersByTime(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith('analytics worker: no answer in time; starting a new one', { kind: 'foodStock', ms: 30_000 });
    // The fresh worker serves "Last year" (20 s into its own 30 s)...
    latest().ready();
    expect(latest().sent.map((m) => m.request)).toEqual([LAST_YEAR]);
    latest().answer(latest().sent[0]!.id, 'last year');
    await expect(lastYear).resolves.toBe('last year');
    // ...and every tab after it, "Today" included.
    const today = client.run('menu', DAY);
    latest().answer(latest().sent[1]!.id, 'menu today');
    await expect(today).resolves.toBe('menu today');
    expect(workers).toHaveLength(2);
  });

  it('a hang with the asks made together: the waiting ask times out with it, and the next one gets a fresh worker', async () => {
    const { client, workers, latest } = setup({ runTimeoutMs: 100 });
    client.start();
    latest().ready();
    const a = client.run('foodStock', YEAR).catch((e: unknown) => e);
    const b = client.run('foodStock', LAST_YEAR).catch((e: unknown) => e);
    expect(((await a) as WorkerRunError).code).toBe('superseded');
    vi.advanceTimersByTime(100);
    // "Last year" waited its full 100 ms behind the hung ask: timed out, but the worker was replaced.
    expect(((await b) as WorkerRunError).code).toBe('timeout');
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    latest().ready();
    const menu = client.run('menu', DAY);
    expect(latest().sent.map((m) => m.kind)).toEqual(['menu']);
    latest().answer(latest().sent[0]!.id, 'menu');
    await expect(menu).resolves.toBe('menu');
  });

  it('the same ask twice (the screen and "Print everything") shares one answer', async () => {
    const { client, latest } = setup();
    client.start();
    latest().ready();
    const a = client.run('channels', DAY, '2026-09-26T10:00:00.000Z');
    const b = client.run('channels', { ...DAY }, '2026-09-26T10:00:05.000Z');
    expect(latest().sent).toHaveLength(1);
    latest().answer(latest().sent[0]!.id, 'channels');
    await expect(Promise.all([a, b])).resolves.toEqual(['channels', 'channels']);
  });

  it('a worker that crashes answers "try again" and is restarted', async () => {
    const { client, workers, latest, log } = setup();
    client.start();
    latest().ready();
    const lost = client.run('team', DAY).catch((e: unknown) => e);
    const queued = client.run('menu', DAY);
    latest().emit('error', new Error('boom'));
    const err = (await lost) as WorkerRunError;
    expect(err.code).toBe('crashed');
    expect(err.message).toMatch(/try again/i);
    expect(workers).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith('analytics worker stopped; starting a new one', { why: 'it stopped with an error (boom)' });
    // The old thread's exit after its error is not a second crash.
    workers[0]!.emit('exit', 1);
    expect(workers).toHaveLength(2);
    latest().ready();
    latest().answer(latest().sent[0]!.id, 'menu after restart');
    await expect(queued).resolves.toBe('menu after restart');
  });

  it('crashing again and again, it is given up on: the main process takes over', async () => {
    const { client, workers, latest, log } = setup({ maxCrashes: 3 });
    client.start();
    for (let i = 0; i < 2; i++) {
      latest().ready();
      latest().emit('exit', 1);
    }
    expect(workers).toHaveLength(3);
    latest().ready();
    const pending = client.run('menu', DAY).catch((e: unknown) => e);
    latest().emit('exit', 134);
    expect(((await pending) as WorkerRunError).code).toBe('crashed');
    expect(client.state).toBe('unavailable');
    expect(workers).toHaveLength(3);
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringMatching(/^analytics worker failed, using main-thread fallback: it stopped \(exit code 134\), 3 times in 60 s$/));
    await expect(client.run('menu', DAY)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await client.settled()).toBe('unavailable');
  });

  it('a worker that cannot open the database is given up on at once, with its reason in the log', async () => {
    const { client, workers, latest, log } = setup();
    client.start();
    const waiting = client.run('overview', DAY).catch((e: unknown) => e);
    const settled = client.settled();
    latest().emit('message', { type: 'startFailed', reason: 'unable to open database file' });
    expect(await settled).toBe('unavailable');
    expect(client.unavailableReason).toBe('unable to open database file');
    expect(((await waiting) as WorkerRunError).code).toBe('unavailable');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('analytics worker failed, using main-thread fallback: unable to open database file');
  });

  it('a worker whose thread dies before it is ready, or never says ready, or cannot be made, is given up on', async () => {
    const died = setup();
    died.client.start();
    died.latest().emit('exit', 1);
    expect(died.client.state).toBe('unavailable');
    expect(died.workers).toHaveLength(1);

    const silent = setup();
    silent.client.start();
    vi.advanceTimersByTime(20_000);
    expect(silent.client.state).toBe('unavailable');
    expect(silent.client.unavailableReason).toBe('it did not start within 20 s');

    const log = { info: vi.fn(), warn: vi.fn() };
    const cannot = new AnalyticsWorkerClient({
      spawn: () => {
        throw new Error("Cannot find module 'analytics-worker.cjs'");
      },
      log,
    });
    cannot.start();
    expect(cannot.state).toBe('unavailable');
    expect(log.warn).toHaveBeenCalledWith(
      "analytics worker failed, using main-thread fallback: it could not be started (Cannot find module 'analytics-worker.cjs')",
    );
  });

  it('a worker that answers with an error: that ask fails, the worker carries on', async () => {
    const { client, latest } = setup();
    client.start();
    latest().ready();
    const bad = client.run('foodStock', DAY);
    const next = client.run('when', DAY);
    latest().emit('message', { type: 'result', id: latest().sent[0]!.id, ok: false, message: 'no such table: x', ms: 1 });
    await expect(bad).rejects.toMatchObject({ code: 'failed', message: 'no such table: x' });
    latest().answer(latest().sent[1]!.id, 'when');
    await expect(next).resolves.toBe('when');
    expect(client.state).toBe('ready');
  });

  it('stop asks the worker to close its connection, waits for the thread to end, and answers what is left', async () => {
    const { client, latest } = setup();
    client.start();
    latest().ready();
    const w = latest();
    const pending = client.run('overview', DAY);
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    expect(w.closeAsked).toBe(true);
    // Not before the thread (and with it the read connection) has ended:
    // the main process closes its own connection only after this.
    expect(stopped).toBe(false);
    expect(w.exited).toBe(false);
    await stopping;
    expect(w.exited).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.state).toBe('stopped');
    await expect(client.run('overview', DAY)).rejects.toMatchObject({ code: 'unavailable' });
    // Asked twice (restore, then quit): one close, the same wait.
    await client.stop();
    expect(w.sent).toHaveLength(1);
  });

  it('stop waits 2 s at most for a worker in the middle of a long query, then ends it', async () => {
    const { client, latest, log } = setup();
    client.start();
    latest().ready();
    const w = latest();
    void client.run('overview', YEAR).catch(() => undefined);
    w.busy = true;
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(w.closeAsked).toBe(true);
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(1_999);
    await flush();
    expect(stopped).toBe(false);
    vi.advanceTimersByTime(1);
    await stopping;
    expect(w.terminated).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('analytics worker did not close in time; ending it', { ms: 2_000 });
  });

  it('stop also waits for a worker replaced earlier whose query has not returned yet', async () => {
    const { client, workers, latest } = setup();
    client.start();
    latest().ready();
    workers[0]!.busy = true;
    void client.run('team', YEAR).catch(() => undefined);
    vi.advanceTimersByTime(30_000);
    // Replaced; the old thread is still in its query, its connection still open.
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[0]!.exited).toBe(false);
    latest().ready();
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(latest().exited).toBe(true);
    expect(stopped).toBe(false);
    // Its query returns and the thread ends: now the till may close its connection.
    workers[0]!.exit(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('never started: every ask is "unavailable" (the main process works it out)', async () => {
    const { client } = setup();
    expect(await client.settled()).toBe('idle');
    await expect(client.run('overview', DAY)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('where the worker and SQLite are', () => {
  it('maps a path inside app.asar to app.asar.unpacked, and leaves dev paths alone', () => {
    expect(unpackedPath('C:\\Program Files\\POS\\resources\\app.asar\\out\\main\\analytics-worker.cjs')).toBe(
      'C:\\Program Files\\POS\\resources\\app.asar.unpacked\\out\\main\\analytics-worker.cjs',
    );
    expect(unpackedPath('/opt/pos/resources/app.asar/node_modules/better-sqlite3/lib/index.js')).toBe(
      '/opt/pos/resources/app.asar.unpacked/node_modules/better-sqlite3/lib/index.js',
    );
    expect(unpackedPath('C:\\dev\\apps\\pos\\out\\main\\analytics-worker.cjs')).toBe('C:\\dev\\apps\\pos\\out\\main\\analytics-worker.cjs');
    // Not fooled by a folder merely named like it.
    expect(unpackedPath('C:\\x\\app.asar.unpacked\\y.cjs')).toBe('C:\\x\\app.asar.unpacked\\y.cjs');
  });

  it('an installed till: the unpacked worker, better-sqlite3 and its .node file', () => {
    const res = path.join('C:', 'POS', 'resources');
    const asar = path.join(res, 'app.asar');
    const unpacked = path.join(res, 'app.asar.unpacked');
    const onDisk = new Set([
      path.join(unpacked, 'out', 'main', 'analytics-worker.cjs'),
      path.join(unpacked, 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
      path.join(unpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    ]);
    const paths = resolveWorkerPaths({
      mainDir: path.join(asar, 'out', 'main'),
      exists: (p) => onDisk.has(p),
      resolveModule: (id) =>
        id === 'better-sqlite3'
          ? path.join(asar, 'node_modules', 'better-sqlite3', 'lib', 'index.js')
          : path.join(asar, 'node_modules', 'better-sqlite3', 'package.json'),
    });
    expect(paths).toEqual({
      script: path.join(unpacked, 'out', 'main', 'analytics-worker.cjs'),
      betterSqlite3: path.join(unpacked, 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
      nativeBinding: path.join(unpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    });
  });

  it('dev (out/main), and SQLite that cannot be found: loaded by name', () => {
    const main = path.join('C:', 'dev', 'pos', 'out', 'main');
    const paths = resolveWorkerPaths({
      mainDir: main,
      exists: () => false,
      resolveModule: () => {
        throw new Error('not found');
      },
    });
    expect(paths).toEqual({ script: path.join(main, 'analytics-worker.cjs'), betterSqlite3: null, nativeBinding: null });
  });
});
