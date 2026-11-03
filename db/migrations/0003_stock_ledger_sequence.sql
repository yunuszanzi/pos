-- created_at is the transaction start time, so entries from one transaction tie and ids are random: neither gives the
-- order movements were applied in. Running balances and "valuation as of a date" need that order, so every entry gets
-- a sequence number. post_stock_adjustment locks the balance row before inserting, so for a given SKU and location
-- the sequence order is the order the balance was updated in.
ALTER TABLE stock_ledger ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX stock_ledger_seq_uidx ON stock_ledger (seq);
CREATE INDEX stock_ledger_variant_seq_idx ON stock_ledger (business_id, variant_id, location_id, seq);
