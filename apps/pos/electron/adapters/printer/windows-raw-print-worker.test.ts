import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WORKER_READY_LINE, parseReplyLine } from './windows-raw-print-protocol.js';
import {
  RawPrintError,
  RawPrintWorker,
  type WorkerProcessLike,
} from './windows-raw-print-worker.js';

/**
 * A stand-in for the PowerShell child: stdin we can read jobs from, stdout
 * and stderr we can write to, and exit/error events we can fire.
 */
class FakeProcess extends EventEmitter implements WorkerProcessLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  readonly jobs: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) this.jobs.push(line);
      }
    });
  }

  ready(): void {
    this.stdout.write(`${WORKER_READY_LINE}\n`);
  }

  reply(id: string, status: 'OK' | 'ERR', rest: string): void {
    this.stdout.write(`${id}\t${status}\t${rest}\n`);
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
  }
}

async function nextJob(proc: FakeProcess): Promise<{ id: string; name: string; bytes: number[] }> {
  for (let i = 0; i < 50 && proc.jobs.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
  const line = proc.jobs.shift();
  if (!line) throw new Error('worker received no job');
  const [id, name, payload] = line.split('\t');
  return {
    id: id!,
    name: Buffer.from(name!, 'base64').toString('utf8'),
    bytes: [...Buffer.from(payload!, 'base64')],
  };
}

function harness(opts: { readyTimeoutMs?: number; jobTimeoutMs?: number } = {}) {
  const spawned: FakeProcess[] = [];
  const events: string[] = [];
  const worker = new RawPrintWorker(
    () => {
      const p = new FakeProcess();
      spawned.push(p);
      return p;
    },
    { readyTimeoutMs: 200, jobTimeoutMs: 200, onEvent: (m) => events.push(m), ...opts },
  );
  return { worker, spawned, events };
}

async function rejection(p: Promise<unknown>): Promise<RawPrintError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RawPrintError) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

describe('RawPrintWorker', () => {
  it('starts the worker lazily, sends the job, and resolves on OK', async () => {
    const { worker, spawned } = harness();
    expect(spawned).toHaveLength(0);

    const bytes = new Uint8Array([0x1b, 0x40, 0x48, 0x69, 0x0a]);
    const result = worker.send('BC-85AC G1', bytes);
    expect(spawned).toHaveLength(1);
    const proc = spawned[0]!;
    proc.ready();

    const job = await nextJob(proc);
    expect(job.name).toBe('BC-85AC G1');
    expect(job.bytes).toEqual([...bytes]);
    proc.reply(job.id, 'OK', String(bytes.length));

    await expect(result).resolves.toBe(bytes.length);
  });

  it('reuses one worker across jobs and matches replies by id', async () => {
    const { worker, spawned } = harness();
    const a = worker.send('P', new Uint8Array([1]));
    const proc = spawned[0]!;
    proc.ready();
    const b = worker.send('P', new Uint8Array([2]));
    const ja = await nextJob(proc);
    const jb = await nextJob(proc);
    expect(spawned).toHaveLength(1);
    // Answer out of order — each promise still gets its own result.
    proc.reply(jb.id, 'OK', '2');
    proc.reply(ja.id, 'OK', '1');
    await expect(b).resolves.toBe(2);
    await expect(a).resolves.toBe(1);
  });

  it('surfaces a spooler ERR as a retryable error with the message', async () => {
    const { worker, spawned } = harness();
    const result = worker.send('Missing Printer', new Uint8Array([1]));
    const proc = spawned[0]!;
    proc.ready();
    const job = await nextJob(proc);
    proc.reply(
      job.id,
      'ERR',
      Buffer.from('OpenPrinter failed (1801): The printer name is invalid.').toString('base64'),
    );
    const err = await rejection(result);
    expect(err.code).toBe('spooler_error');
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain('printer name is invalid');
  });

  it('rejects a bad printer name up front, without starting a worker', async () => {
    const { worker, spawned } = harness();
    const err = await rejection(worker.send('a\tb', new Uint8Array([1])));
    expect(err.code).toBe('bad_printer_name');
    expect(err.recoverable).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('reports a worker that dies before READY with its stderr, then respawns next time', async () => {
    const { worker, spawned } = harness();
    const first = worker.send('P', new Uint8Array([1]));
    const proc = spawned[0]!;
    proc.stderr.write('Add-Type : Cannot add type. Compilation errors occurred.\n');
    await new Promise((r) => setTimeout(r, 5));
    proc.emit('exit', 1, null);
    const err = await rejection(first);
    expect(err.code).toBe('worker_start_failed');
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain('code 1');
    expect(err.message).toContain('Compilation errors');

    const second = worker.send('P', new Uint8Array([2]));
    expect(spawned).toHaveLength(2);
    const proc2 = spawned[1]!;
    proc2.ready();
    const job = await nextJob(proc2);
    proc2.reply(job.id, 'OK', '1');
    await expect(second).resolves.toBe(1);
  });

  it('fails in-flight jobs when the worker exits mid-job', async () => {
    const { worker, spawned } = harness();
    const result = worker.send('P', new Uint8Array([1]));
    const proc = spawned[0]!;
    proc.ready();
    await nextJob(proc);
    proc.emit('exit', null, 'SIGKILL');
    const err = await rejection(result);
    expect(err.code).toBe('worker_exited');
    expect(err.recoverable).toBe(true);
  });

  it('times out a job the worker never answers and kills the worker', async () => {
    const { worker, spawned, events } = harness({ jobTimeoutMs: 30 });
    const result = worker.send('P', new Uint8Array([1]));
    const proc = spawned[0]!;
    proc.ready();
    await nextJob(proc);
    const err = await rejection(result);
    expect(err.code).toBe('timeout');
    expect(err.recoverable).toBe(true);
    expect(proc.killed).toBe(true);
    expect(events.some((e) => e.includes('timed out'))).toBe(true);

    // The next print gets a fresh worker.
    const next = worker.send('P', new Uint8Array([2]));
    expect(spawned).toHaveLength(2);
    spawned[1]!.ready();
    const job = await nextJob(spawned[1]!);
    spawned[1]!.reply(job.id, 'OK', '1');
    await expect(next).resolves.toBe(1);
  });

  it('gives up on a worker that never says READY', async () => {
    const { worker, spawned } = harness({ readyTimeoutMs: 30 });
    const err = await rejection(worker.send('P', new Uint8Array([1])));
    expect(err.code).toBe('worker_start_timeout');
    expect(err.recoverable).toBe(true);
    expect(spawned[0]!.killed).toBe(true);
  });

  it('reports a spawn failure as not recoverable', async () => {
    const worker = new RawPrintWorker(() => {
      throw new Error('ENOENT powershell.exe');
    });
    const err = await rejection(worker.send('P', new Uint8Array([1])));
    expect(err.code).toBe('spawn_failed');
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain('ENOENT');
  });

  it('dispose kills the worker and refuses further jobs', async () => {
    const { worker, spawned } = harness();
    const inflight = worker.send('P', new Uint8Array([1]));
    spawned[0]!.ready();
    await nextJob(spawned[0]!);
    worker.dispose();
    expect(spawned[0]!.killed).toBe(true);
    expect((await rejection(inflight)).code).toBe('worker_exited');
    expect((await rejection(worker.send('P', new Uint8Array([1])))).code).toBe('disposed');
    expect(spawned).toHaveLength(1);
  });

  describe('drawer pulses', () => {
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    const KICK = new Uint8Array([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);

    async function drawerJob(opts: { notAfter?: number } = {}) {
      const h = harness();
      const result = h.worker.send('P', KICK, { drawer: true, ...opts });
      const proc = h.spawned[0]!;
      proc.ready();
      for (let i = 0; i < 50 && proc.jobs.length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
      const line = proc.jobs[0]!;
      const job = await nextJob(proc);
      return { ...h, proc, result, job, line };
    }

    it('sends a drawer job with the K flag and its confirm window; receipts go without', async () => {
      const { proc, result, job, line } = await drawerJob({ notAfter: Date.now() + 8_000 });
      const flag = line.split('\t')[3]!;
      expect(flag).toMatch(/^K\d+$/);
      const ms = Number(flag.slice(1));
      expect(ms).toBeGreaterThan(6_000);
      expect(ms).toBeLessThanOrEqual(8_000);
      expect(job.bytes).toEqual([...KICK]);
      proc.reply(job.id, 'OK', String(KICK.length));
      await expect(result).resolves.toBe(KICK.length);

      const { worker, spawned } = harness();
      const receipt = worker.send('P', new Uint8Array([1]));
      spawned[0]!.ready();
      for (let i = 0; i < 50 && spawned[0]!.jobs.length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
      expect(spawned[0]!.jobs[0]!.split('\t')).toHaveLength(3);
      spawned[0]!.reply((await nextJob(spawned[0]!)).id, 'OK', '1');
      await receipt;
    });

    it('offline: retryable, nothing sent', async () => {
      const { proc, result, job } = await drawerJob();
      proc.reply(job.id, 'ERR', b64('[offline] Windows says the printer is off (status 0x80)'));
      const err = await rejection(result);
      expect(err.code).toBe('printer_offline');
      expect(err.recoverable).toBe(true);
      expect(err.maybeSent).toBe(false);
      expect(err.message).toBe('Windows says the printer is off (status 0x80)');
    });

    it('not sent: retryable', async () => {
      const { proc, result, job } = await drawerJob();
      proc.reply(job.id, 'ERR', b64('[not_sent] OpenPrinter failed (1801): bad name'));
      const err = await rejection(result);
      expect(err.code).toBe('printer_not_sent');
      expect(err.recoverable).toBe(true);
      expect(err.maybeSent).toBe(false);
    });

    it('maybe sent: never retried', async () => {
      const { proc, result, job } = await drawerJob();
      proc.reply(job.id, 'ERR', b64('[maybe_sent] The printer stopped while taking the drawer pulse'));
      const err = await rejection(result);
      expect(err.code).toBe('printer_maybe_sent');
      expect(err.recoverable).toBe(false);
      expect(err.maybeSent).toBe(true);
    });

    it('an untagged failure of a drawer job counts as maybe sent (a receipt just retries)', async () => {
      const { proc, result, job } = await drawerJob();
      proc.reply(job.id, 'ERR', b64('Object reference not set to an instance of an object.'));
      const err = await rejection(result);
      expect(err.recoverable).toBe(false);
      expect(err.maybeSent).toBe(true);
    });

    it('a timeout or a dying worker after the line went out may have sent it', async () => {
      const t = harness({ jobTimeoutMs: 30 });
      const timedOut = t.worker.send('P', KICK, { drawer: true });
      t.spawned[0]!.ready();
      await nextJob(t.spawned[0]!);
      const e1 = await rejection(timedOut);
      expect(e1.code).toBe('timeout');
      expect(e1.maybeSent).toBe(true);

      const { proc, result } = await drawerJob();
      proc.emit('exit', null, 'SIGKILL');
      const e2 = await rejection(result);
      expect(e2.code).toBe('worker_exited');
      expect(e2.maybeSent).toBe(true);
    });

    it('refuses to hand over a pulse once it is too late, without sending anything', async () => {
      const { worker, spawned } = harness();
      const late = worker.send('P', KICK, { drawer: true, notAfter: Date.now() - 1 });
      spawned[0]!.ready();
      const err = await rejection(late);
      expect(err.code).toBe('drawer_too_late');
      expect(err.recoverable).toBe(false);
      expect(err.maybeSent).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      expect(spawned[0]!.jobs).toHaveLength(0);
    });

    it('warm() starts the worker ahead of the first job', async () => {
      const { worker, spawned } = harness();
      worker.warm();
      expect(spawned).toHaveLength(1);
      spawned[0]!.ready();
      const sent = worker.send('P', new Uint8Array([1]));
      spawned[0]!.reply((await nextJob(spawned[0]!)).id, 'OK', '1');
      await expect(sent).resolves.toBe(1);
      expect(spawned).toHaveLength(1);
    });
  });

  it('round-trips through the same parser the worker replies are read with', () => {
    expect(parseReplyLine('x\tOK\t5')).toEqual({ id: 'x', ok: true, written: 5 });
  });
});
