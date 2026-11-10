-- v0.9 slice 3: sales rung up while the till had no connection (technical plan 5.5, NFR-AVL-03).
--
-- An offline sale is kept on the device and sent when the connection returns. It is posted by the same function as any sale, so it is
-- numbered, costed and taken from stock in the normal way; this migration only adds what is special about it:
--   * the REFERENCE the slip printed at the time (T3-OFF-000001), kept on the invoice and unique per terminal, so the slip in the
--     customer's hand can be matched to the invoice and a sale can never arrive twice under two references;
--   * the time it was really sold (posted_at is set back from "now" to then);
--   * FLAGS for anything the shop should look at: stock that went below zero, a price or tax that changed meanwhile, a discount above
--     the cashier's limit that no manager could approve offline. A flagged sale is posted, not refused (the customer has already paid
--     and left); somebody with authority reviews it afterwards.
-- The invoice itself stays immutable: only these two columns may be set, once, by stamp_offline_sale.

ALTER TABLE sales_invoices ADD COLUMN offline_ref text CHECK (offline_ref IS NULL OR length(btrim(offline_ref)) > 0);
CREATE UNIQUE INDEX sales_invoices_offline_ref_uidx ON sales_invoices (business_id, terminal_id, offline_ref) WHERE offline_ref IS NOT NULL;

CREATE TABLE offline_sale_flags (
  invoice_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  flags text[] NOT NULL CHECK (cardinality(flags) > 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, business_id) REFERENCES sales_invoices(id, business_id)
);
CREATE INDEX offline_sale_flags_open_idx ON offline_sale_flags (business_id, created_at DESC) WHERE reviewed_at IS NULL;

-- A posted invoice cannot change, except that stamp_offline_sale may set the time and the reference in the transaction that posts it.
CREATE OR REPLACE FUNCTION protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sales_invoice_lines' AND (to_jsonb(NEW) - 'returned_qty_base') = (to_jsonb(OLD) - 'returned_qty_base') THEN
    RETURN NEW;
  END IF;
  -- As in 0026: FBR's answer may be written onto a posted invoice or return, and a number FBR has given is final.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('sales_invoices', 'sales_returns')
     AND (to_jsonb(NEW) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') = (to_jsonb(OLD) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') THEN
    IF OLD.fbr_irn IS NOT NULL AND NEW.fbr_irn IS DISTINCT FROM OLD.fbr_irn THEN RAISE EXCEPTION 'the FBR number of a posted document cannot be changed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'sales_invoices' AND TG_OP = 'UPDATE' AND coalesce(current_setting('pos.offline_stamp', true), '') = 'on'
     AND OLD.offline_ref IS NULL AND (to_jsonb(NEW) - 'posted_at' - 'offline_ref') = (to_jsonb(OLD) - 'posted_at' - 'offline_ref') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;

-- Called right after post_sales_invoice, in the same transaction. Sets when the sale really happened and what the slip called it, and
-- records anything for review.
CREATE FUNCTION stamp_offline_sale(p_business uuid, p_invoice uuid, p_posted_at timestamptz, p_reference text, p_flags jsonb, p_detail jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_posted_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'OFFLINE_TIME_INVALID: the sale is dated in the future'; END IF;
  PERFORM set_config('pos.offline_stamp', 'on', true);
  UPDATE sales_invoices SET posted_at = p_posted_at, offline_ref = p_reference WHERE id = p_invoice AND business_id = p_business;
  PERFORM set_config('pos.offline_stamp', 'off', true);
  IF jsonb_array_length(coalesce(p_flags, '[]'::jsonb)) > 0 THEN
    INSERT INTO offline_sale_flags (invoice_id, business_id, flags, detail)
    SELECT p_invoice, p_business, array_agg(x), coalesce(p_detail, '{}'::jsonb) FROM jsonb_array_elements_text(p_flags) x;
  END IF;
END;
$$;

-- Review: somebody with authority has looked at the flagged sale. The note is theirs; the sale does not change.
CREATE FUNCTION review_offline_sale(p_business uuid, p_invoice uuid, p_note text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE offline_sale_flags SET reviewed_at = now(), reviewed_by = p_actor, review_note = coalesce(p_note, '')
  WHERE invoice_id = p_invoice AND business_id = p_business AND reviewed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: nothing to review on that sale'; END IF;
END;
$$;

ALTER TABLE offline_sale_flags ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions (key, description) VALUES
  ('sales.offline_review', 'See sales rung up offline that need a look (stock below zero, price changed, discount over the limit) and mark them reviewed')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'sales.offline_review' FROM roles r WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
