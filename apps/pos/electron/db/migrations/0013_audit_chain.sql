-- 0013_audit_chain.sql
-- Tamper-evident audit trail.
--
-- Every audit_log row written from this version on carries
--   row_hash  = SHA-256(prev_hash + "\n" + canonical(row))
--   prev_hash = the row_hash of the row before it ("genesis" for the first)
-- so deleting, editing or reordering any row breaks every hash after it.
-- The verifier (electron/db/audit-chain.ts) walks the table in rowid order
-- and reports the first break. Rows written before this migration keep NULL
-- hashes: they are counted as "not covered" and cannot be back-filled
-- honestly, because nobody can vouch for them after the fact.
--
-- The chain head is pinned into every cloud backup's manifest, which anchors
-- the local history to a record the POS itself cannot rewrite. A cloud copy
-- that was trimmed for size stores the hash at the cut in settings
-- ("audit.chainAnchor") so the verifier can start from there.

ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN row_hash TEXT;
