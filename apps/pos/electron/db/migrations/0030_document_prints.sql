-- 0030_document_prints.sql
-- The print log: one row per paper the till put out for an order (or may
-- have: the printer failed mid-way, or the till stopped mid-send). It is how
-- a second receipt knows to say DUPLICATE ("Reprint #2, 26/09 19:52, by
-- Ali"), how a kitchen ticket knows it is a REPRINT, and how the owner sees
-- who printed what again. print_queue could not answer "was this printed
-- before?": it is per till and its done rows are deleted after 14 days.
--
--   document  receipt | bill | refund | void | kitchen | kitchen_cancel
--   doc_key   the series a paper belongs to: the document, or
--             'refund:<paid_at of that refund>' (one slip per refund)
--   copy      customer | shop | kitchen — the SHOP COPY is its own series,
--             never a duplicate of the customer's
--   print_no  how many papers of the same series went out before this one
--             (0 = the ORIGINAL)
--   outcome   printed | unsure (the printer failed mid-way, or the till
--             stopped mid-send: the paper may or may not exist)
--   reason    why it printed: payment | dispatch | refund | reprint (the
--             Reprint button) | auto | cancel (kitchen)
--   fbr_irn   the FBR number printed on it, if any
--   fbr_qr_payload / fbr_mode  the QR printed with that number and whether
--             it was a sandbox (test) or production number. fbr_submission_queue
--             is per till, so this is how the OTHER till prints the same
--             number and QR on a duplicate of a sale it did not send to FBR.
--
-- Written only by document-print-repo.ts (row + sync_queue + hash-chained
-- audit_log, actions print_original / print_duplicate / print_unsure), and
-- only once the printer took the bytes: a definite failure writes nothing,
-- so the retry is still the ORIGINAL. Replicable: the other till learns what
-- this one printed. Kinds are checked in code, not with CHECK, so a newer
-- till's values still sync to an older one.

CREATE TABLE IF NOT EXISTS document_prints (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES orders(id),
  document             TEXT NOT NULL,
  doc_key              TEXT NOT NULL,
  copy                 TEXT NOT NULL,
  print_no             INTEGER NOT NULL,
  outcome              TEXT NOT NULL,
  reason               TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id),
  approved_by_user_id  TEXT REFERENCES users(id),
  print_job_id         TEXT,
  fbr_irn              TEXT,
  fbr_qr_payload       TEXT,
  fbr_mode             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  synced_at            TEXT,
  deleted_at           TEXT,
  device_id            TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_document_prints_order ON document_prints(order_id, doc_key, copy);
CREATE INDEX IF NOT EXISTS idx_document_prints_requested_by ON document_prints(requested_by_user_id);
CREATE INDEX IF NOT EXISTS idx_document_prints_approved_by ON document_prints(approved_by_user_id);
CREATE INDEX IF NOT EXISTS idx_document_prints_created ON document_prints(created_at);
-- Reprints per person (Reports → Staff) and per order (Order History).
CREATE INDEX IF NOT EXISTS idx_document_prints_reason ON document_prints(reason, created_at);

-- What a job is sending right now (the copies, their document and number),
-- written just before the bytes go out and cleared when the job ends. A job
-- still in flight with a plan at boot may have printed: its papers go in the
-- log as 'unsure' and the re-send says DUPLICATE (printer retry).
ALTER TABLE print_queue ADD COLUMN sending_plan_json TEXT;

-- Papers printed before this version kept no log. Their finished jobs are
-- marked so the log can count them (and housekeeping keeps them): a receipt
-- printed at 3 pm by the old version makes the 4 pm reprint a DUPLICATE.
UPDATE print_queue
   SET sending_plan_json = '"legacy"'
 WHERE status = 'done' AND job_kind IN ('receipt', 'kitchen') AND last_error IS NULL;

-- When the log started. A receipt for an order paid before it, with no job
-- left from then, was printed by the old version.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES (
  'printing.printLogSince',
  '"' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || '"',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
