-- 0041_channel_terms_uplift_and_fee.sql
-- Two more of a foodpanda order's terms, kept when it is paid
-- (order_channel_terms, 0040), so a paid order's figures never move with a
-- later change in Settings → foodpanda:
--      uplift_bps          how much dearer the foodpanda listing was at
--                          payment (basis points; 0 = the till's prices).
--                          The tablet total Pay expected and the price
--                          uplift Reports count are worked from it, exactly.
--      payment_fee_cents   foodpanda's % of the order's total (the
--                          'foodpanda.fees' paymentFeeBps, on the tablet
--                          total), beside the commission, fee and tax.
-- NULL on a row kept without them (Reports work the uplift back from the
-- kept payout, and count no fee on the total).
--
-- Plain nullable ADD COLUMN, no CHECKs (the 0033 / 0040 practice). Row
-- images are built from the live schema, so the columns travel without a
-- sync-core change; a till without them ignores them.
ALTER TABLE order_channel_terms ADD COLUMN uplift_bps INTEGER;
ALTER TABLE order_channel_terms ADD COLUMN payment_fee_cents INTEGER;
