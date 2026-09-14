import { describe, expect, it } from 'vitest';
import {
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
    // Never touch the console code page — see the module comment.
    expect(script).not.toContain('InputEncoding');
    expect(script).not.toContain('OutputEncoding');
    // No leftover JS interpolation and nothing that would trip the here-string.
    expect(script).not.toContain('${');
    expect(script).not.toContain('`');
    expect(script.split("@'").length).toBe(2);
    expect(script.split("'@").length).toBe(2);
    // Comfortably inside the Windows command-line limit once encoded.
    expect(encodePowerShellCommand(script).length).toBeLessThan(30_000);
  });
});
