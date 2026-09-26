import { describe, expect, it } from 'vitest';
import {
  MAX_DRAWER_CONFIRM_MS,
  MAX_PRINTER_NAME_LENGTH,
  WORKER_READY_LINE,
  buildWorkerScript,
  encodeJobLine,
  encodePowerShellCommand,
  isValidPrinterName,
  parseReplyLine,
} from './windows-raw-print-protocol.js';

describe('windows raw print protocol', () => {
  it('encodes a job as one tab-separated ASCII line', () => {
    const line = encodeJobLine('j1', 'BC-85AC G1 (Ürdu)', new Uint8Array([0x1b, 0x40, 0x0a, 0x09]));
    expect(line.endsWith('\n')).toBe(true);
    const [id, name, payload] = line.trimEnd().split('\t');
    expect(id).toBe('j1');
    expect(Buffer.from(name!, 'base64').toString('utf8')).toBe('BC-85AC G1 (Ürdu)');
    expect([...Buffer.from(payload!, 'base64')]).toEqual([0x1b, 0x40, 0x0a, 0x09]);
    // Nothing but the separators is outside printable ASCII.
    expect(/^[\x21-\x7e]+\t[\x21-\x7e]+\t[\x21-\x7e]+\n$/.test(line)).toBe(true);
  });

  it('parses OK and ERR replies and ignores anything else', () => {
    expect(parseReplyLine('j1\tOK\t312')).toEqual({ id: 'j1', ok: true, written: 312 });
    expect(parseReplyLine('j1\tOK\t312\r')).toEqual({ id: 'j1', ok: true, written: 312 });
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    expect(
      parseReplyLine(`j2\tERR\t${b64('OpenPrinter failed (1801): The printer name is invalid.')}`),
    ).toEqual({
      id: 'j2',
      ok: false,
      message: 'OpenPrinter failed (1801): The printer name is invalid.',
    });
    // Localised Windows text survives the trip.
    expect(parseReplyLine(`j2\tERR\t${b64('پرنٹر کا نام غلط ہے')}`)).toEqual({
      id: 'j2',
      ok: false,
      message: 'پرنٹر کا نام غلط ہے',
    });
    // Plain text is tolerated, and a message containing a tab is kept whole.
    expect(parseReplyLine('j3\tERR\tnot base64!\tb')).toEqual({
      id: 'j3',
      ok: false,
      message: 'not base64!\tb',
    });
    expect(parseReplyLine('j4\tERR\t')).toEqual({
      id: 'j4',
      ok: false,
      message: 'Unknown printer error',
    });
    expect(parseReplyLine('')).toBeNull();
    expect(parseReplyLine(WORKER_READY_LINE)).toBeNull();
    expect(parseReplyLine('j5\tWHAT\t1')).toBeNull();
    expect(parseReplyLine('\tOK\t1')).toBeNull();
  });

  it('flags a drawer job with a 4th field only when asked, with its confirm window', () => {
    const plain = encodeJobLine('j1', 'P', new Uint8Array([1]));
    expect(plain.trimEnd().split('\t')).toHaveLength(3);
    const kick = encodeJobLine('j2', 'P', new Uint8Array([0x1b, 0x70, 0, 25, 250]), { drawerConfirmMs: 5000 });
    const parts = kick.trimEnd().split('\t');
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe('K5000');
    expect([...Buffer.from(parts[2]!, 'base64')]).toEqual([0x1b, 0x70, 0, 25, 250]);
    // The window stays inside the worker's job timeout, and never below half a second.
    expect(encodeJobLine('j3', 'P', new Uint8Array([1]), { drawerConfirmMs: 99_999 }).trimEnd().split('\t')[3]).toBe(
      `K${MAX_DRAWER_CONFIRM_MS}`,
    );
    expect(encodeJobLine('j4', 'P', new Uint8Array([1]), { drawerConfirmMs: -5 }).trimEnd().split('\t')[3]).toBe('K500');
    expect(MAX_DRAWER_CONFIRM_MS).toBeLessThan(20_000);
    expect(/^[\x21-\x7e]+(\t[\x21-\x7e]+){3}\n$/.test(kick)).toBe(true);
  });

  it('reads a drawer failure prefix into a code, and leaves other messages alone', () => {
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    expect(parseReplyLine(`j1\tERR\t${b64('[offline] Windows says the printer is offline (status 0x80)')}`)).toEqual({
      id: 'j1',
      ok: false,
      message: 'Windows says the printer is offline (status 0x80)',
      code: 'offline',
    });
    expect(parseReplyLine(`j2\tERR\t${b64('[not_sent] OpenPrinter failed (1801): bad name')}`)).toEqual({
      id: 'j2',
      ok: false,
      message: 'OpenPrinter failed (1801): bad name',
      code: 'not_sent',
    });
    expect(parseReplyLine(`j3\tERR\t${b64('[maybe_sent] The printer stopped while taking the drawer pulse')}`)).toEqual({
      id: 'j3',
      ok: false,
      message: 'The printer stopped while taking the drawer pulse',
      code: 'maybe_sent',
    });
    expect(parseReplyLine(`j4\tERR\t${b64('[maybe_sent]')}`)).toEqual({
      id: 'j4',
      ok: false,
      message: 'Unknown printer error',
      code: 'maybe_sent',
    });
    // Only a known tag at the very start counts.
    expect(parseReplyLine(`j5\tERR\t${b64('Printer [offline] somewhere')}`)).toEqual({
      id: 'j5',
      ok: false,
      message: 'Printer [offline] somewhere',
    });
    expect(parseReplyLine(`j6\tERR\t${b64('[busy] later')}`)).toEqual({ id: 'j6', ok: false, message: '[busy] later' });
  });

  it('accepts real queue names and rejects ones that would break the line protocol', () => {
    expect(isValidPrinterName('BC-85AC G1')).toBe(true);
    expect(isValidPrinterName('POS-80 (Copy 1)')).toBe(true);
    expect(isValidPrinterName('\\\\SHOP-PC\\Receipt')).toBe(true);
    expect(isValidPrinterName('')).toBe(false);
    expect(isValidPrinterName('a\tb')).toBe(false);
    expect(isValidPrinterName('a\nb')).toBe(false);
    expect(isValidPrinterName('x'.repeat(MAX_PRINTER_NAME_LENGTH))).toBe(true);
    expect(isValidPrinterName('x'.repeat(MAX_PRINTER_NAME_LENGTH + 1))).toBe(false);
  });

  it('encodes the PowerShell command as base64 UTF-16LE', () => {
    const encoded = encodePowerShellCommand('Write-Output 1');
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output 1');
  });

  it('builds a worker script that announces READY and speaks the protocol', () => {
    const script = buildWorkerScript();
    expect(script).toContain(`WriteLine('${WORKER_READY_LINE}')`);
    expect(script).toContain('"RAW"');
    expect(script).toContain('winspool.drv');
    expect(script).toContain('[Console]::In.ReadLine()');
    expect(script).toContain("@($id, 'OK', $written)");
    expect(script).toContain("@($id, 'ERR', $enc)");
    // Drawer pulses take the checked path: status first, confirm or delete after.
    expect(script).toContain('SendDrawer($name, $bytes, [int]$parts[3].Substring(1))');
    expect(script).toContain("$parts[3].StartsWith('K')");
    for (const api of ['GetPrinterW', 'EnumJobsW', 'GetJobW', 'SetJobW', 'AbortPrinter']) {
      expect(script).toContain(`"${api}"`);
    }
    for (const tag of ['[offline]', '[not_sent]', '[maybe_sent]']) expect(script).toContain(tag);
    // Receipts still go the plain way.
    expect(script).toContain("Send($name, 'CheeseOclock POS receipt', $bytes)");
    // A drawer pulse left queued by a killed worker is deleted before anything
    // else — also while Windows says the printer is offline, which is exactly
    // when it would wait and pop the drawer later — and by paper jobs too.
    const blocked = script.slice(script.indexOf('static string Blocked('), script.indexOf('static int JobStatus('));
    expect(blocked.indexOf('EnumJobs(h,')).toBeGreaterThan(-1);
    expect(blocked.indexOf('== DrawerDoc) SetJob(h, j.JobId, 0, IntPtr.Zero, 5)')).toBeGreaterThan(-1);
    expect(blocked.indexOf('EnumJobs(h,')).toBeLessThan(blocked.indexOf('PrinterStatus(h)'));
    const send = script.slice(script.indexOf('public static int Send('), script.indexOf('public const string DrawerDoc'));
    expect(send.indexOf('Blocked(handle, out ahead)')).toBeGreaterThan(-1);
    expect(send.indexOf('Blocked(handle, out ahead)')).toBeLessThan(send.indexOf('StartDocPrinter(handle'));
    // Never touch the console code page — see the module comment.
    expect(script).not.toContain('InputEncoding');
    expect(script).not.toContain('OutputEncoding');
    // No leftover JS interpolation and nothing that would trip the here-string.
    expect(script).not.toContain('${');
    expect(script).not.toContain('`');
    expect(script.split("@'").length).toBe(2);
    expect(script.split("'@").length).toBe(2);
    // Comfortably inside the Windows command-line limit once encoded: the C#
    // comments stay in the source file, not on the command line.
    expect(script.split('\n').filter((l) => /^\s*\/\//.test(l))).toEqual([]);
    expect(script).toContain('Blocked(handle, out ahead); // clears a left-over drawer pulse');
    expect(encodePowerShellCommand(script).length).toBeLessThan(30_000);
  });
});
