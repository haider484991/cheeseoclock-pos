/**
 * Line protocol between the main process and the Windows RAW print worker.
 *
 * The worker is a Windows PowerShell child process (see `buildWorkerScript`)
 * that compiles a tiny winspool.drv P/Invoke helper once, then loops on
 * stdin. Each job is one line; each answer is one line:
 *
 *   request:  <id> TAB <base64 printer queue name> TAB <base64 ESC/POS bytes>
 *             [TAB K<ms>]  — a cash-drawer pulse: checked, and confirmed
 *                            gone from the queue within <ms> or deleted
 *   response: <id> TAB OK  TAB <bytes written>
 *             <id> TAB ERR TAB <base64 message>
 *
 * A drawer job's ERR message may start with [offline], [not_sent] or
 * [maybe_sent] (see DrawerFailure): a prefix, so a reply stays three fields
 * and a message may still contain tabs.
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

/** Longest a drawer job may wait to leave the Windows queue (the worker's job timeout is 20 s). */
export const MAX_DRAWER_CONFIRM_MS = 12_000;

export function encodeJobLine(
  id: string,
  printerName: string,
  bytes: Uint8Array,
  flags: { drawerConfirmMs?: number } = {},
): string {
  const name = Buffer.from(printerName, 'utf8').toString('base64');
  const payload = Buffer.from(bytes).toString('base64');
  if (flags.drawerConfirmMs === undefined) return `${id}\t${name}\t${payload}\n`;
  const ms = Math.max(500, Math.min(MAX_DRAWER_CONFIRM_MS, Math.round(flags.drawerConfirmMs) || 0));
  return `${id}\t${name}\t${payload}\tK${ms}\n`;
}

/**
 * How a drawer job failed, from the worker's own checks:
 *  - offline: nothing reached the printer and nothing is left in the queue,
 *    so trying again is safe;
 *  - not_sent: Windows refused the job before taking it;
 *  - maybe_sent: the pulse may have reached the printer, or may still sit in
 *    the queue — never send it again.
 */
export type DrawerFailure = 'offline' | 'not_sent' | 'maybe_sent';

export type WorkerReply =
  | { id: string; ok: true; written: number }
  | { id: string; ok: false; message: string; code?: DrawerFailure };

const DRAWER_FAILURE_PREFIX = /^\[(offline|not_sent|maybe_sent)\]\s*/;

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
    const text = decodeMessage(rest);
    const tagged = DRAWER_FAILURE_PREFIX.exec(text);
    if (tagged) {
      const message = text.slice(tagged[0].length).trim() || 'Unknown printer error';
      return { id, ok: false, message, code: tagged[1] as DrawerFailure };
    }
    return { id, ok: false, message: text || 'Unknown printer error' };
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
 * That is fine for a receipt and wrong for a cash-drawer pulse, which would
 * pop the drawer minutes later with nobody at it. So a drawer job (the K
 * flag) goes through `SendDrawer`: it checks the printer and the queue
 * first, then waits for the job to leave the queue and deletes it if it
 * does not (pausing it first, so it cannot start in between), and says in
 * the error prefix whether sending again is safe. A worker killed mid-wait
 * (app quit, job timeout) can leave its pulse queued, so every job — drawer
 * or paper, printer offline or not — first deletes any drawer job it finds.
 *
 * Keep this free of backticks — it lives in a template literal — and of C#
 * features newer than C# 5, which is what Windows PowerShell 5.1's Add-Type
 * compiles with. Comment-only C# lines are left out of the script it returns.
 */
export function buildWorkerScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class CheeseOclockRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOB_INFO_1 {
    public int JobId;
    public IntPtr pPrinterName, pMachineName, pUserName, pDocument, pDatatype, pStatus;
    public int Status, Priority, Position, TotalPages, PagesPrinted;
    public short y, mo, dw, d, h, mi, s, ms;
  }
  [DllImport("winspool.drv", EntryPoint = "GetPrinterW", SetLastError = true, ExactSpelling = true)]
  static extern bool GetPrinter(IntPtr handle, int level, IntPtr buf, int size, out int needed);
  [DllImport("winspool.drv", EntryPoint = "EnumJobsW", SetLastError = true, ExactSpelling = true)]
  static extern bool EnumJobs(IntPtr handle, int first, int count, int level, IntPtr buf, int size, out int needed, out int returned);
  [DllImport("winspool.drv", EntryPoint = "GetJobW", SetLastError = true, ExactSpelling = true)]
  static extern bool GetJob(IntPtr handle, int job, int level, IntPtr buf, int size, out int needed);
  [DllImport("winspool.drv", EntryPoint = "SetJobW", SetLastError = true, ExactSpelling = true)]
  static extern bool SetJob(IntPtr handle, int job, int level, IntPtr info, int command);
  [DllImport("winspool.drv", EntryPoint = "AbortPrinter", SetLastError = true, ExactSpelling = true)]
  static extern bool AbortPrinter(IntPtr handle);
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
      int ahead;
      Blocked(handle, out ahead); // clears a left-over drawer pulse
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

  public const string DrawerDoc = "CheeseOclock POS drawer";
  delegate bool Getter(IntPtr buf, int size, out int needed);

  // A winspool read: ask the size, then read. Zero = nothing (err 0) or failed (err). Caller frees.
  static IntPtr Get(Getter g, out int err) {
    int n;
    err = 0;
    if (g(IntPtr.Zero, 0, out n)) return IntPtr.Zero;
    err = Marshal.GetLastWin32Error();
    if (err != 122) return IntPtr.Zero;
    IntPtr b = Marshal.AllocHGlobal(n);
    if (g(b, n, out n)) { err = 0; return b; }
    err = Marshal.GetLastWin32Error();
    Marshal.FreeHGlobal(b);
    return IntPtr.Zero;
  }

  // PRINTER_INFO_2 status (0 when unknown); Use Printer Offline counts as offline.
  static int PrinterStatus(IntPtr h) {
    int e;
    IntPtr p = Get((IntPtr b, int c, out int n) => GetPrinter(h, 2, b, c, out n), out e);
    if (p == IntPtr.Zero) return 0;
    int o = 13 * IntPtr.Size, st = Marshal.ReadInt32(p, o + 20);
    if ((Marshal.ReadInt32(p, o) & 0x400) != 0) st |= 0x80;
    Marshal.FreeHGlobal(p);
    return st;
  }

  // Why no pulse should go now, or null; ahead = healthy jobs before ours.
  // First, even offline, deletes drawer jobs a killed worker left.
  static string Blocked(IntPtr h, out int ahead) {
    ahead = 0;
    int e, cnt = 0;
    string why = null;
    IntPtr p = Get((IntPtr b, int c, out int n) => EnumJobs(h, 0, 99, 1, b, c, out n, out cnt), out e);
    if (p != IntPtr.Zero) {
      int sz = Marshal.SizeOf(typeof(JOB_INFO_1));
      for (int i = 0; i < cnt; i++) {
        JOB_INFO_1 j = (JOB_INFO_1)Marshal.PtrToStructure(new IntPtr(p.ToInt64() + i * sz), typeof(JOB_INFO_1));
        if (Marshal.PtrToStringUni(j.pDocument) == DrawerDoc) SetJob(h, j.JobId, 0, IntPtr.Zero, 5);
        else if ((j.Status & 0x663) != 0) why = "Earlier print jobs are stuck in the printer queue (job status 0x" + j.Status.ToString("X") + ")";
        else ahead++;
      }
      Marshal.FreeHGlobal(p);
    }
    int st = PrinterStatus(h);
    // Paused, going away, jam, paper, offline, not available, door open, server offline.
    // Not ERROR or USER_INTERVENTION: drivers often leave those set.
    if ((st & 0x024010DD) != 0) return "Windows says the printer is off, offline, out of paper or open (status 0x" + st.ToString("X") + ")";
    return why;
  }

  // A job's status; -1 once it has left the queue; -2 when Windows would not say.
  static int JobStatus(IntPtr h, int job) {
    int e;
    IntPtr p = Get((IntPtr b, int c, out int n) => GetJob(h, job, 1, b, c, out n), out e);
    if (p == IntPtr.Zero) return e == 87 ? -1 : -2;
    int s = ((JOB_INFO_1)Marshal.PtrToStructure(p, typeof(JOB_INFO_1))).Status;
    Marshal.FreeHGlobal(p);
    return s;
  }

  // A drawer pulse must never wait in the queue and pop the drawer later: check the
  // printer, send, and make sure the job leaves the queue within ms, or delete it.
  // The error prefix says whether trying again is safe.
  public static int SendDrawer(string printerName, byte[] bytes, int ms) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) throw new Exception("[not_sent] " + Fail("OpenPrinter").Message);
    try {
      int ahead, s, seen = 0, w = 0;
      string why = Blocked(h, out ahead);
      if (why != null) throw new Exception("[offline] " + why);
      DOCINFOW di = new DOCINFOW();
      di.pDocName = DrawerDoc;
      di.pDataType = "RAW";
      int job = StartDocPrinter(h, 1, ref di);
      if (job == 0) throw new Exception("[not_sent] " + Fail("StartDocPrinter").Message);
      if (!StartPagePrinter(h) || !WritePrinter(h, bytes, bytes.Length, out w) || w != bytes.Length) {
        string m = Fail("Sending").Message;
        AbortPrinter(h);
        throw new Exception("[not_sent] Windows did not take the drawer pulse: " + m);
      }
      EndPagePrinter(h);
      EndDocPrinter(h);
      DateTime end = DateTime.UtcNow.AddMilliseconds(Math.Min(ms, 5000 + 3000 * ahead));
      while (true) {
        s = JobStatus(h, job);
        if (s == -1 || (s >= 0 && (s & 0x1080) != 0)) return w;
        if (s >= 0) seen |= s;
        if ((s >= 0 && (s & 0x663) != 0) || DateTime.UtcNow > end) break;
        Thread.Sleep(100);
      }
      // Not gone in time. Pause it (a waiting job can no longer start), look again, delete.
      SetJob(h, job, 0, IntPtr.Zero, 1);
      s = JobStatus(h, job);
      if (s == -1 || (s >= 0 && (s & 0x1080) != 0)) return w;
      if (s >= 0) seen |= s;
      if (!SetJob(h, job, 0, IntPtr.Zero, 5)) {
        if (Marshal.GetLastWin32Error() == 87) return w;
        throw new Exception("[maybe_sent] Windows would not cancel the drawer pulse, so the drawer may still open by itself");
      }
      bool gone = false;
      for (int i = 0; i < 20 && !gone; i++) {
        s = JobStatus(h, job);
        if (s >= 0 && (s & 0x1080) != 0) return w;
        if (s >= 0) seen |= s;
        gone = s == -1 || (s >= 0 && (s & 0x104) != 0);
        if (!gone) Thread.Sleep(50);
      }
      if (!gone) throw new Exception("[maybe_sent] The drawer pulse is stuck in the printer queue and may still open the drawer");
      string st = " (job status 0x" + seen.ToString("X") + ")";
      // Never started; or the port failed while the printer reports no paper or lid trouble: nothing reached it.
      if ((seen & 0x10) == 0 || ((seen & 0x222) != 0 && (PrinterStatus(h) & 0x400050) == 0))
        throw new Exception("[offline] The printer did not take the drawer pulse" + st);
      throw new Exception("[maybe_sent] The printer stopped while taking the drawer pulse" + st);
    } finally {
      ClosePrinter(h);
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
    if ($parts.Length -ge 4 -and $parts[3].StartsWith('K')) {
      $written = [CheeseOclockRawPrinter]::SendDrawer($name, $bytes, [int]$parts[3].Substring(1))
    } else {
      $written = [CheeseOclockRawPrinter]::Send($name, 'CheeseOclock POS receipt', $bytes)
    }
    [Console]::Out.WriteLine([string]::Join($tab, @($id, 'OK', $written)))
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$msg))
    [Console]::Out.WriteLine([string]::Join($tab, @($id, 'ERR', $enc)))
  }
  [Console]::Out.Flush()
}
`.replace(C_SHARP_COMMENT_LINE, '');
}

/**
 * A line that is only a C# comment. The comments are for people reading
 * this file; in the script they would only use up the command line (it goes
 * base64-encoded on powershell.exe's, which Windows caps at 32,767 chars).
 */
const C_SHARP_COMMENT_LINE = /^[ \t]*\/\/[^\n]*\n/gm;
