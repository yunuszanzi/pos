-- Fixes 0030: the protection function read OLD.offline_ref for every posted-document table, and only sales_invoices has that column,
-- so an attempt to change a payment, a return or an invoice line failed with "record old has no field" instead of the proper refusal.
-- The offline exception is now checked only for sales_invoices.

CREATE OR REPLACE FUNCTION protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sales_invoice_lines' AND (to_jsonb(NEW) - 'returned_qty_base') = (to_jsonb(OLD) - 'returned_qty_base') THEN
    RETURN NEW;
  END IF;
  -- FBR's answer may be written onto a posted invoice or return, and a number FBR has given is final (0026).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('sales_invoices', 'sales_returns')
     AND (to_jsonb(NEW) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') = (to_jsonb(OLD) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') THEN
    IF OLD.fbr_irn IS NOT NULL AND NEW.fbr_irn IS DISTINCT FROM OLD.fbr_irn THEN RAISE EXCEPTION 'the FBR number of a posted document cannot be changed'; END IF;
    RETURN NEW;
  END IF;
  -- stamp_offline_sale may set the time and the slip reference of an invoice, once, in the transaction that posts it (0030).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sales_invoices' AND coalesce(current_setting('pos.offline_stamp', true), '') = 'on' THEN
    IF (to_jsonb(OLD) ->> 'offline_ref') IS NULL AND (to_jsonb(NEW) - 'posted_at' - 'offline_ref') = (to_jsonb(OLD) - 'posted_at' - 'offline_ref') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;
