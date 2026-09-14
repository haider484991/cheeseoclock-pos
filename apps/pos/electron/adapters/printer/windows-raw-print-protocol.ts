/**
 * Line protocol between the main process and the Windows RAW print worker.
 *
 * The worker is a Windows PowerShell child process (see `buildWorkerScript`)
 * that compiles a tiny winspool.drv P/Invoke helper once, then loops on
 * stdin. Each job is one line; each answer is one line:
 *
 *   request:  <id> TAB <base64 printer queue name> TAB <base64 ESC/POS bytes>
 *   response: <id> TAB OK  TAB <bytes written>
 *             <id> TAB ERR TAB <base64 message>
 *
 * Plus a single `READY` line from the worker once its helper is compiled.
 * Everything on the wire is ASCII on purpose: the child's console code page
 * is whatever Windows feels like, and changing it from a process that has no
 * console window can fail. Base64 makes the printer name, the payload and
 * any (possibly localised) error text immune to that.
 *
 * Pure module — no Electron, no child_process — so it can be unit-tested.
 */

export const WORKER_READY_LINE = 'READY';

/** A queue name has to fit on one protocol line and inside OpenPrinterW's limits. */
export const MAX_PRINTER_NAME_LENGTH = 220;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isValidPrinterName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_PRINTER_NAME_LENGTH && !CONTROL_CHARS.test(name);
}

export function encodeJobLine(id: string, printerName: string, bytes: Uint8Array): string {
  const name = Buffer.from(printerName, 'utf8').toString('base64');
  const payload = Buffer.from(bytes).toString('base64');
  return `${id}\t${name}\t${payload}\n`;
}

export type WorkerReply =
  | { id: string; ok: true; written: number }
  | { id: string; ok: false; message: string };

/** Returns null for lines that aren't replies (blank lines, stray output). */
export function parseReplyLine(line: string): WorkerReply | null {
  const trimmed = line.replace(/\r$/, '');
  const parts = trimmed.split('\t');
  if (parts.length < 3) return null;
  const [id, status] = parts;
  if (!id || !status) return null;
  const rest = parts.slice(2).join('\t');
  if (status === 'OK') {
    const written = Number.parseInt(rest, 10);
    return { id, ok: true, written: Number.isFinite(written) ? written : 0 };
  }
  if (status === 'ERR') {
    return { id, ok: false, message: decodeMessage(rest) || 'Unknown printer error' };
  }
  return null;
}

/** ERR text is base64 UTF-8 from the worker; tolerate plain text just in case. */
function decodeMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

/**
 * `powershell.exe -EncodedCommand` takes the script as base64 of UTF-16LE.
 * A script this size is well under the 32K command-line limit.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The worker script. It is the textbook "send RAW data to a printer" helper
 * (OpenPrinter → StartDocPrinter datatype RAW → WritePrinter) that every
 * Windows POS uses; the printer's own driver passes RAW jobs through
 * untouched, so ESC/POS cut / drawer / QR commands reach the hardware as-is.
 *
 * `WritePrinter` returns once the job is spooled, not once paper moves —
 * if the printer is off, Windows holds the job and prints it when it's back.
 *
 * Keep this free of backticks — it lives in a template literal — and of C#
 * features newer than C# 5, which is what Windows PowerShell 5.1's Add-Type
 * compiles with.
 */
export function buildWorkerScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class CheeseOclockRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPWStr)] string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, ref DOCINFOW docInfo);
  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

  static Exception Fail(string step) {
    int code = Marshal.GetLastWin32Error();
    string detail = new System.ComponentModel.Win32Exception(code).Message;
    return new Exception(step + " failed (" + code + "): " + detail);
  }

  public static int Send(string printerName, string docName, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(printerName, out handle, IntPtr.Zero)) throw Fail("OpenPrinter");
    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = docName;
      di.pOutputFile = null;
      di.pDataType = "RAW";
      if (StartDocPrinter(handle, 1, ref di) == 0) throw Fail("StartDocPrinter");
      try {
        if (!StartPagePrinter(handle)) throw Fail("StartPagePrinter");
        int written;
        if (!WritePrinter(handle, bytes, bytes.Length, out written)) throw Fail("WritePrinter");
        EndPagePrinter(handle);
        return written;
      } finally {
        EndDocPrinter(handle);
      }
    } finally {
      ClosePrinter(handle);
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$tab = [string][char]9
[Console]::Out.WriteLine('${WORKER_READY_LINE}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split($tab)
  $id = $parts[0]
  try {
    if ($parts.Length -lt 3) { throw 'Malformed print job' }
    $name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $bytes = [Convert]::FromBase64String($parts[2])
    $written = [CheeseOclockRawPrinter]::Send($name, 'CheeseOclock POS receipt', $bytes)
    [Console]::Out.WriteLine([string]::Join($tab, @($id, 'OK', $written)))
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$msg))
    [Console]::Out.WriteLine([string]::Join($tab, @($id, 'ERR', $enc)))
  }
  [Console]::Out.Flush()
}
`;
}
