import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  WORKER_READY_LINE,
  buildWorkerScript,
  encodeJobLine,
  encodePowerShellCommand,
  isValidPrinterName,
  parseReplyLine,
} from './windows-raw-print-protocol.js';

/**
 * Owns the Windows RAW print worker process (protocol in
 * windows-raw-print-protocol.ts) and turns "send these bytes to that
 * queue" into a promise.
 *
 * Why a long-lived child rather than one PowerShell per receipt: compiling
 * the winspool helper (`Add-Type`) costs a second or two, and a till prints
 * every few minutes. The worker is started lazily on the first print, kept
 * around, and respawned on the next print if it ever dies. Its stdin closes
 * when we exit, and the script exits on stdin EOF, so it never outlives us.
 *
 * Every failure is reported as a RawPrintError with `recoverable` set the way
 * the print spooler wants it: transport hiccups retry with backoff, a bad
 * config does not.
 */

export interface WorkerProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(): unknown;
}

export type SpawnWorker = () => WorkerProcessLike;

export interface RawPrintWorkerOptions {
  /** How long `Add-Type` may take on a cold machine before we give up. */
  readyTimeoutMs?: number;
  /** Spooling is quick; anything longer means the worker is wedged. */
  jobTimeoutMs?: number;
  /** Diagnostics sink — the adapter routes this to electron-log. */
  onEvent?: (message: string, meta?: Record<string, unknown>) => void;
}

export class RawPrintError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  constructor(code: string, message: string, recoverable: boolean) {
    super(message);
    this.name = 'RawPrintError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

interface PendingJob {
  resolve: (written: number) => void;
  reject: (err: RawPrintError) => void;
  timer: NodeJS.Timeout;
}

const STDERR_TAIL_LIMIT = 2_000;

export function spawnPowerShellWorker(): WorkerProcessLike {
  // Windows PowerShell 5.1 ships with every Windows 10/11; pin the path so an
  // odd PATH on a per-user install can't send us to something else.
  const systemRoot = process.env['SystemRoot'];
  const exe = systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return spawn(
    exe,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(buildWorkerScript()),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export class RawPrintWorker {
  private proc: WorkerProcessLike | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingJob>();
  private stderrTail = '';
  private seq = 0;
  private disposed = false;
  private readonly readyTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly onEvent: NonNullable<RawPrintWorkerOptions['onEvent']>;

  constructor(
    private readonly spawnWorker: SpawnWorker = spawnPowerShellWorker,
    opts: RawPrintWorkerOptions = {},
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 45_000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 20_000;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /** Resolves with the byte count the spooler accepted. */
  async send(printerName: string, bytes: Uint8Array): Promise<number> {
    if (this.disposed) {
      throw new RawPrintError('disposed', 'Print worker was shut down', true);
    }
    if (!isValidPrinterName(printerName)) {
      throw new RawPrintError('bad_printer_name', 'Printer name is empty or invalid', false);
    }
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc) throw new RawPrintError('worker_exited', 'Print worker is not running', true);

    const id = `${Date.now().toString(36)}-${(this.seq += 1)}`;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onEvent('Print job timed out; restarting worker', { id, printerName });
        // A wedged worker won't answer anything else either.
        this.kill();
        reject(
          new RawPrintError(
            'timeout',
            `Windows did not accept the print job within ${this.jobTimeoutMs}ms`,
            true,
          ),
        );
      }, this.jobTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(encodeJobLine(id, printerName, bytes), (err) => {
        if (err) {
          const job = this.pending.get(id);
          if (!job) return;
          clearTimeout(job.timer);
          this.pending.delete(id);
          reject(new RawPrintError('write_error', err.message, true));
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let proc: WorkerProcessLike;
      try {
        proc = this.spawnWorker();
      } catch (e) {
        this.ready = null;
        reject(
          new RawPrintError(
            'spawn_failed',
            `Could not start Windows PowerShell: ${e instanceof Error ? e.message : String(e)}`,
            false,
          ),
        );
        return;
      }
      this.proc = proc;
      this.stderrTail = '';
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.onEvent('Print worker did not become ready in time', {
          readyTimeoutMs: this.readyTimeoutMs,
        });
        this.kill();
        reject(
          new RawPrintError(
            'worker_start_timeout',
            'Windows PowerShell took too long to get ready for printing',
            true,
          ),
        );
      }, this.readyTimeoutMs);

      // A write after the child died surfaces through its exit handler and the
      // write callback; without this the same EPIPE would also be an unhandled
      // 'error' event on the stream.
      proc.stdin.on('error', () => {});
      proc.stderr.on('data', (chunk: Buffer | string) => {
        this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
      });

      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        if (!settled && line.trim() === WORKER_READY_LINE) {
          settled = true;
          clearTimeout(readyTimer);
          this.onEvent('Print worker ready');
          resolve();
          return;
        }
        const reply = parseReplyLine(line);
        if (!reply) return;
        const job = this.pending.get(reply.id);
        if (!job) return;
        clearTimeout(job.timer);
        this.pending.delete(reply.id);
        if (reply.ok) job.resolve(reply.written);
        else job.reject(new RawPrintError('spooler_error', reply.message, true));
      });

      const onGone = (why: string) => {
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
        const detail = this.stderrTail.trim();
        const message = detail ? `${why}: ${detail}` : why;
        this.onEvent('Print worker exited', { why, detail });
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new RawPrintError('worker_start_failed', message, true));
        }
        for (const [id, job] of this.pending) {
          clearTimeout(job.timer);
          this.pending.delete(id);
          job.reject(new RawPrintError('worker_exited', message, true));
        }
      };
      proc.on('exit', (code, signal) =>
        onGone(`Print worker exited (${signal ?? `code ${code ?? 'unknown'}`})`),
      );
      proc.on('error', (err) => onGone(`Print worker error: ${err.message}`));
    });
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // Already gone — its exit handler has cleaned up.
    }
  }
}
