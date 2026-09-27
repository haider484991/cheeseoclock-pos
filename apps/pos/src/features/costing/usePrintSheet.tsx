import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PRINT_CSS, PRINT_SHEET_CLASS } from '../reports/exporters';

/**
 * Print a sheet built as escaped HTML (the item cost sheet), the way the
 * Reports page prints: the sheet is rendered next to the app, printed, then
 * taken away again. `print(html)` starts it; render `portal` somewhere.
 */
export function usePrintSheet(): { print: (html: string) => void; portal: React.ReactNode } {
  // An id per click, so printing the same sheet twice prints twice.
  const [job, setJob] = useState<{ id: number; html: string } | null>(null);

  useEffect(() => {
    if (job === null) return;
    const done = () => setJob(null);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 60);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [job]);

  return {
    print: (html: string) => setJob({ id: Date.now(), html }),
    portal:
      job !== null
        ? createPortal(
            <div className={PRINT_SHEET_CLASS}>
              <style>{PRINT_CSS}</style>
              {/* Built by costSheetPrintHtml, which escapes every value. */}
              <div dangerouslySetInnerHTML={{ __html: job.html }} />
            </div>,
            document.body,
          )
        : null,
  };
}
