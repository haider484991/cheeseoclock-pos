/**
 * The LAN printer adapter against a local TCP server standing in for the
 * printer: a drawer pulse first asks the printer whether it is online (DLE
 * EOT 1) and is not sent when it clearly says "offline"; a printer that does
 * not answer the question still gets the pulse; receipts never ask.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrinterConnectionConfig } from '@cheeseoclock/shared-types';
import { NetworkPrinterAdapter } from './network-printer-adapter.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

const KICK = new Uint8Array([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
const ASK = [0x10, 0x04, 0x01];

interface FakePrinter {
  server: Server;
  port: number;
  /** Every byte received, per connection. */
  received: number[][];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

/** A printer on 127.0.0.1 that answers the status question with `status` (or never, when null). */
async function fakePrinter(status: number | null): Promise<FakePrinter> {
  const received: number[][] = [];
  const server = createServer((sock: Socket) => {
    const mine: number[] = [];
    received.push(mine);
    sock.on('data', (chunk: Buffer) => {
      mine.push(...chunk);
      if (status !== null && chunk.length >= 3 && chunk[0] === 0x10 && chunk[1] === 0x04) {
        sock.write(Buffer.from([status]));
      }
    });
    sock.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { server, port: addr.port, received };
}

const adapter = (port: number) =>
  new NetworkPrinterAdapter({
    transport: 'network',
    network: { host: '127.0.0.1', port, timeoutMs: 2_000 },
    width: 48,
  } satisfies PrinterConnectionConfig);

/** Wait until the server has seen the connection close and flush its bytes. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('NetworkPrinterAdapter — the cash drawer', () => {
  it('asks first, then sends the pulse to a printer that is online', async () => {
    const p = await fakePrinter(0x12);
    const r = await adapter(p.port).send(KICK, { drawer: true });
    await settle();
    expect(r.ok).toBe(true);
    expect(p.received[0]).toEqual([...ASK, ...KICK]);
  });

  it('does not send the pulse to a printer that says it is offline, and may retry', async () => {
    const p = await fakePrinter(0x1a);
    const r = await adapter(p.port).send(KICK, { drawer: true });
    await settle();
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'printer_offline', recoverable: true });
    expect(r.error?.maybeSent).toBeUndefined();
    expect(p.received[0]).toEqual(ASK);
  });

  it('a printer that does not answer the question still gets the pulse', async () => {
    const p = await fakePrinter(null);
    const r = await adapter(p.port).send(KICK, { drawer: true });
    await settle();
    expect(r.ok).toBe(true);
    expect(p.received[0]).toEqual([...ASK, ...KICK]);
  });

  it('a pulse too late to be of use is not sent at all', async () => {
    const p = await fakePrinter(0x12);
    const r = await adapter(p.port).send(KICK, { drawer: true, notAfter: Date.now() - 1 });
    await settle();
    expect(r.error).toMatchObject({ code: 'drawer_too_late', recoverable: false });
    expect(p.received.flat()).not.toContain(0x70);
  });

  it('receipts never ask', async () => {
    const p = await fakePrinter(0x12);
    const bytes = new Uint8Array([0x1b, 0x40, 0x41, 0x0a]);
    const r = await adapter(p.port).send(bytes);
    await settle();
    expect(r.ok).toBe(true);
    expect(p.received[0]).toEqual([...bytes]);
  });

  it('nobody listening: not sent, safe to retry', async () => {
    const p = await fakePrinter(0x12);
    const port = p.port;
    await new Promise((r) => p.server.close(() => r(undefined)));
    servers.splice(servers.indexOf(p.server), 1);
    const r = await adapter(port).send(KICK, { drawer: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'network_error', recoverable: true });
    expect(r.error?.maybeSent).toBeUndefined();
  });
});
