-- 0016_payments_shift.sql
-- Money is credited to the shift in which it changed hands, not the shift in
-- which the order was created. A COD delivery taken at 19:50 is routinely paid
-- at 20:30 after shift A has closed and shift B has opened; until now that cash
-- joined on orders.shift_id (= A) and so belonged to no open drawer — every
-- night's variance was off by the late deliveries.
--
-- Existing rows keep NULL; readers fall back to the order's shift for them
-- (COALESCE(p.shift_id, o.shift_id)), so history reconciles exactly as before.
ALTER TABLE payments ADD COLUMN shift_id TEXT REFERENCES shifts(id);

CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);
