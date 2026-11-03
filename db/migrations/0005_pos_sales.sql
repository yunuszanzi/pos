-- v0.3 POS sales (technical-plan 3.1, 3.2, 5.1, 5.7). API-only like the rest: no grants to anon/authenticated (see 0001).

-- ---------------------------------------------------------------- settings, roles, terminals

ALTER TABLE business_settings
  -- Shelf prices include tax by default (retail); wholesale businesses switch to exclusive.
  ADD COLUMN tax_mode text NOT NULL DEFAULT 'inclusive' CHECK (tax_mode IN ('inclusive', 'exclusive')),
  -- Round the cash total to the nearest 1, 5 or 10 rupees (FR-SAL-16). 0 = no rounding.
  ADD COLUMN cash_rounding_paisa integer NOT NULL DEFAULT 0 CHECK (cash_rounding_paisa IN (0, 100, 500, 1000)),
  ADD COLUMN allow_negative_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_print_receipt boolean NOT NULL DEFAULT true;

-- The largest discount, in basis points of what it is taken from, a role may give without a manager (FR-SAL-04).
ALTER TABLE roles
  ADD COLUMN max_discount_bps integer NOT NULL DEFAULT 0 CHECK (max_discount_bps BETWEEN 0 AND 10000);
UPDATE roles SET max_discount_bps = 10000 WHERE is_system AND name IN ('Owner', 'Manager');
UPDATE roles SET max_discount_bps = 500 WHERE is_system AND name = 'Cashier';

-- Where a terminal's sales take stock from. Empty means the first "store" location of its branch.
ALTER TABLE terminals
  ADD COLUMN sales_location_id uuid,
  ADD CONSTRAINT terminals_sales_location_fk FOREIGN KEY (sales_location_id, business_id) REFERENCES locations(id, business_id);

-- ---------------------------------------------------------------- payment methods

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,40}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('cash', 'card', 'bank', 'wallet')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  fbr_payment_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, code)
);

CREATE FUNCTION seed_sales_defaults(p_business_id uuid, p_actor uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO payment_methods (business_id, code, name, kind, sort_order, created_by, updated_by) VALUES
    (p_business_id, 'cash', 'Cash', 'cash', 1, p_actor, p_actor),
    (p_business_id, 'card', 'Card', 'card', 2, p_actor, p_actor),
    (p_business_id, 'bank_transfer', 'Bank transfer', 'bank', 3, p_actor, p_actor),
    (p_business_id, 'jazzcash', 'JazzCash', 'wallet', 4, p_actor, p_actor),
    (p_business_id, 'easypaisa', 'Easypaisa', 'wallet', 5, p_actor, p_actor)
  ON CONFLICT DO NOTHING;
$$;

-- ---------------------------------------------------------------- shifts and cash

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by uuid NOT NULL REFERENCES auth.users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float_paisa bigint NOT NULL CHECK (opening_float_paisa >= 0),
  closed_by uuid REFERENCES auth.users(id),
  closed_at timestamptz,
  -- Filled in when the shift is closed: the blind count, what the system expected, and the difference.
  counted_paisa bigint CHECK (counted_paisa >= 0),
  counted_breakdown jsonb,
  expected_paisa bigint,
  variance_paisa bigint,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (terminal_id, business_id) REFERENCES terminals(id, business_id),
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND counted_paisa IS NOT NULL
    AND expected_paisa IS NOT NULL AND variance_paisa = counted_paisa - expected_paisa))
);
-- One open shift per terminal (FR-CSH-01).
CREATE UNIQUE INDEX shifts_one_open_per_terminal_uidx ON shifts (terminal_id) WHERE status = 'open';
CREATE INDEX shifts_business_opened_idx ON shifts (business_id, opened_at DESC);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cash_in', 'cash_out')),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id)
);
CREATE INDEX cash_movements_shift_idx ON cash_movements (shift_id);

-- A closed shift is a record of what was counted: it cannot be reopened or edited.
CREATE FUNCTION protect_closed_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed shift cannot be changed or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shifts_protect BEFORE UPDATE OR DELETE ON shifts FOR EACH ROW EXECUTE FUNCTION protect_closed_shift();

CREATE FUNCTION guard_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'cash_movements is append-only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.shift_id AND status = 'open') THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_movements_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION guard_cash_movement();

-- ---------------------------------------------------------------- sales documents

CREATE TABLE sales_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- Walk-in sales have no customer. Customers arrive in v0.4, which adds the foreign key.
  customer_id uuid,
  cashier_id uuid NOT NULL REFERENCES auth.users(id),
  tax_mode text NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  gross_paisa bigint NOT NULL CHECK (gross_paisa >= 0),
  line_discount_paisa bigint NOT NULL CHECK (line_discount_paisa >= 0),
  invoice_discount_paisa bigint NOT NULL CHECK (invoice_discount_paisa >= 0),
  taxable_paisa bigint NOT NULL CHECK (taxable_paisa >= 0),
  tax_paisa bigint NOT NULL CHECK (tax_paisa >= 0),
  rounding_paisa bigint NOT NULL,
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  paid_paisa bigint NOT NULL CHECK (paid_paisa >= 0),
  change_paisa bigint NOT NULL CHECK (change_paisa >= 0),
  balance_paisa bigint NOT NULL CHECK (balance_paisa >= 0),
  -- Who approved a discount or price above the cashier's limit, and for what.
  approved_by uuid REFERENCES auth.users(id),
  approval_note text,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (terminal_id, business_id) REFERENCES terminals(id, business_id),
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  -- The bill adds up, whatever wrote it.
  CHECK (total_paisa = gross_paisa - line_discount_paisa - invoice_discount_paisa
    + CASE WHEN tax_mode = 'exclusive' THEN tax_paisa ELSE 0 END + rounding_paisa),
  CHECK (balance_paisa = total_paisa - paid_paisa),
  CHECK (customer_id IS NOT NULL OR balance_paisa = 0)
);
CREATE INDEX sales_invoices_posted_idx ON sales_invoices (business_id, posted_at DESC);
CREATE INDEX sales_invoices_shift_idx ON sales_invoices (shift_id);

CREATE TABLE sales_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  -- Names as they were on the day, so a printed copy never changes when the catalogue does.
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  hs_code text,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  unit_price_paisa bigint NOT NULL CHECK (unit_price_paisa >= 0),
  gross_paisa bigint NOT NULL CHECK (gross_paisa >= 0),
  line_discount_paisa bigint NOT NULL CHECK (line_discount_paisa >= 0),
  invoice_discount_share_paisa bigint NOT NULL CHECK (invoice_discount_share_paisa >= 0),
  net_paisa bigint NOT NULL CHECK (net_paisa >= 0),
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_included boolean NOT NULL,
  taxable_paisa bigint NOT NULL CHECK (taxable_paisa >= 0),
  tax_paisa bigint NOT NULL CHECK (tax_paisa >= 0),
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  -- Average cost per base unit when it was sold, for profit reports (technical-plan 3.2).
  cost_paisa bigint NOT NULL CHECK (cost_paisa >= 0),
  -- The only column allowed to change after posting: returns record how much has come back.
  returned_qty_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (returned_qty_base >= 0 AND returned_qty_base <= qty_base),
  FOREIGN KEY (invoice_id, business_id) REFERENCES sales_invoices(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  UNIQUE (invoice_id, line_no),
  CHECK (qty_base = qty_entered * factor_to_base),
  CHECK (net_paisa = gross_paisa - line_discount_paisa - invoice_discount_share_paisa),
  CHECK (total_paisa = net_paisa + CASE WHEN tax_included THEN 0 ELSE tax_paisa END),
  CHECK (taxable_paisa = net_paisa - CASE WHEN tax_included THEN tax_paisa ELSE 0 END)
);
CREATE INDEX sales_invoice_lines_variant_idx ON sales_invoice_lines (business_id, variant_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  method_id uuid NOT NULL,
  -- Copied so the record stays readable if the method is renamed.
  method_code text NOT NULL,
  method_name text NOT NULL,
  tender_kind text NOT NULL CHECK (tender_kind IN ('cash', 'other')),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  tendered_paisa bigint NOT NULL,
  change_paisa bigint NOT NULL CHECK (change_paisa >= 0),
  -- A wallet or bank transaction reference.
  reference text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (invoice_id, business_id) REFERENCES sales_invoices(id, business_id),
  FOREIGN KEY (method_id, business_id) REFERENCES payment_methods(id, business_id),
  CHECK (tendered_paisa = amount_paisa + change_paisa),
  CHECK (tender_kind = 'cash' OR change_paisa = 0)
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

-- Posted documents are history: corrections are new documents (returns, v0.4).
CREATE FUNCTION protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'sales_invoice_lines' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'returned_qty_base') = (to_jsonb(OLD) - 'returned_qty_base') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;
CREATE TRIGGER sales_invoices_protect BEFORE UPDATE OR DELETE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER sales_invoice_lines_protect BEFORE UPDATE OR DELETE ON sales_invoice_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER payments_protect BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION protect_posted_document();

CREATE TABLE held_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  terminal_id uuid NOT NULL,
  held_by uuid NOT NULL REFERENCES auth.users(id),
  name text NOT NULL DEFAULT '',
  cart jsonb NOT NULL,
  total_paisa bigint NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (terminal_id, business_id) REFERENCES terminals(id, business_id) ON DELETE CASCADE
);
CREATE INDEX held_sales_terminal_idx ON held_sales (terminal_id, created_at);

-- ---------------------------------------------------------------- gap-free numbering

-- Takes the next number of a series. The UPDATE locks the series row until the caller's transaction ends, so two sales
-- never get the same number, and a sale that rolls back gives its number back: posted numbers have no gaps.
CREATE FUNCTION take_next_document_number(p_business uuid, p_branch uuid, p_doc_type text)
RETURNS TABLE (document_number text, sequence_no integer) LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
  v_taken integer;
BEGIN
  UPDATE document_series SET next_number = next_number + 1, updated_at = now()
  WHERE business_id = p_business AND branch_id = p_branch AND doc_type = p_doc_type
  RETURNING prefix, next_number - 1 INTO v_prefix, v_taken;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_SERIES_MISSING'; END IF;
  document_number := v_prefix || '-' || repeat('0', greatest(6 - length(v_taken::text), 0)) || v_taken::text;
  sequence_no := v_taken;
  RETURN NEXT;
END;
$$;

-- Every branch needs an invoice series. v0.1 did not create one when a branch was added.
INSERT INTO document_series (business_id, branch_id, doc_type, prefix)
SELECT b.business_id, b.id, 'invoice', 'INV-' || upper(b.code)
FROM branches b
WHERE NOT EXISTS (SELECT 1 FROM document_series s WHERE s.branch_id = b.id AND s.doc_type = 'invoice');

-- ---------------------------------------------------------------- posting a sale

CREATE TYPE sales_line_input AS (
  line_no integer, variant_id uuid, unit_id uuid, product_name text, variant_name text, sku text, unit_name text, hs_code text,
  qty_entered numeric, factor_to_base numeric, qty_base numeric, unit_price_paisa bigint, gross_paisa bigint,
  line_discount_paisa bigint, invoice_discount_share_paisa bigint, net_paisa bigint, tax_rate_bps integer, tax_included boolean,
  taxable_paisa bigint, tax_paisa bigint, total_paisa bigint
);
CREATE TYPE sales_payment_input AS (method_id uuid, amount_paisa bigint, tendered_paisa bigint, change_paisa bigint, reference text);

-- Posts a sale in the caller's transaction (technical-plan 5.1). The amounts arrive already worked out by the shared pricing
-- code; this function does not trust them blindly: it checks they add up, locks the stock rows, refuses to sell what is not
-- there (unless the business allows negative stock), takes the next invoice number last, and writes the invoice, lines,
-- payments and stock ledger together or not at all.
CREATE FUNCTION post_sales_invoice(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_terminal uuid := (p->>'terminal_id')::uuid;
  v_shift uuid := (p->>'shift_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_customer uuid := nullif(p->>'customer_id', '')::uuid;
  v_allow_negative boolean := coalesce((p->>'allow_negative_stock')::boolean, false);
  v_total bigint := (p->>'total_paisa')::bigint;
  v_rounding bigint := (p->>'rounding_paisa')::bigint;
  v_invoice uuid := gen_random_uuid();
  v_status text;
  v_line_count integer;
  v_matched integer;
  v_paid bigint;
  v_change bigint;
  v_number text;
  v_sequence integer;
  need record;
  on_hand_now numeric(14,3);
  sums record;
BEGIN
  -- The shift must be open on this terminal. FOR SHARE lets sales run side by side but makes closing the shift wait.
  SELECT status INTO v_status FROM shifts
  WHERE id = v_shift AND business_id = v_business AND terminal_id = v_terminal FOR SHARE;
  IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN'; END IF;

  SELECT count(*) INTO v_line_count FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines');
  IF v_line_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: a sale needs at least one line'; END IF;

  -- Every line is an active SKU sold in a unit it really has, with the factor it had when the price was worked out.
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.active
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business AND pu.factor_to_base = l.factor_to_base;
  IF v_matched <> v_line_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active product sold in that unit'; END IF;

  SELECT sum(total_paisa) AS total, sum(gross_paisa) AS gross, sum(line_discount_paisa) AS line_discount,
         sum(invoice_discount_share_paisa) AS invoice_discount, sum(tax_paisa) AS tax, sum(taxable_paisa) AS taxable
  INTO sums FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines');
  IF sums.total + v_rounding <> v_total
     OR sums.gross <> (p->>'gross_paisa')::bigint
     OR sums.line_discount <> (p->>'line_discount_paisa')::bigint
     OR sums.invoice_discount <> (p->>'invoice_discount_paisa')::bigint
     OR sums.tax <> (p->>'tax_paisa')::bigint
     OR sums.taxable <> (p->>'taxable_paisa')::bigint THEN
    RAISE EXCEPTION 'INVOICE_TOTAL_MISMATCH: the lines do not add up to the invoice';
  END IF;

  SELECT coalesce(sum(amount_paisa), 0), coalesce(sum(change_paisa), 0) INTO v_paid, v_change
  FROM jsonb_populate_recordset(NULL::sales_payment_input, p->'payments');
  IF v_customer IS NULL AND v_paid <> v_total THEN RAISE EXCEPTION 'PAYMENT_MISMATCH: a walk-in sale must be paid in full'; END IF;
  IF v_paid > v_total THEN RAISE EXCEPTION 'PAYMENT_MISMATCH: payments are more than the bill'; END IF;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::sales_payment_input, p->'payments') pay
  JOIN payment_methods m ON m.id = pay.method_id AND m.business_id = v_business AND m.active;
  IF v_matched <> (SELECT count(*) FROM jsonb_populate_recordset(NULL::sales_payment_input, p->'payments')) THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH: a payment method is not available';
  END IF;

  -- Lock the stock of every stocked SKU in a fixed order, so two sales can never deadlock, then check there is enough.
  FOR need IN
    SELECT l.variant_id, sum(l.qty_base) AS qty
    FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') l
    JOIN product_variants v ON v.id = l.variant_id
    JOIN products pr ON pr.id = v.product_id
    WHERE pr.product_type = 'stocked'
    GROUP BY l.variant_id ORDER BY l.variant_id
  LOOP
    INSERT INTO stock_balances (business_id, variant_id, location_id) VALUES (v_business, need.variant_id, v_location)
    ON CONFLICT (variant_id, location_id) DO NOTHING;
    SELECT on_hand INTO on_hand_now FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location FOR UPDATE;
    IF NOT v_allow_negative AND on_hand_now - need.qty < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % on hand, needs %', need.variant_id, on_hand_now, need.qty;
    END IF;
  END LOOP;

  -- The number is taken last so the series row is locked for as short a time as possible.
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'invoice');

  INSERT INTO sales_invoices (
    id, business_id, branch_id, terminal_id, shift_id, location_id, number, sequence_no, customer_id, cashier_id, tax_mode,
    gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa,
    paid_paisa, change_paisa, balance_paisa, approved_by, approval_note, created_by, updated_by
  ) VALUES (
    v_invoice, v_business, v_branch, v_terminal, v_shift, v_location, v_number, v_sequence, v_customer, p_actor, p->>'tax_mode',
    sums.gross, sums.line_discount, sums.invoice_discount, sums.taxable, sums.tax, v_rounding, v_total,
    v_paid, v_change, v_total - v_paid, nullif(p->>'approved_by', '')::uuid, nullif(p->>'approval_note', ''), p_actor, p_actor
  );

  INSERT INTO sales_invoice_lines (
    business_id, invoice_id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
    taxable_paisa, tax_paisa, total_paisa, cost_paisa
  )
  SELECT v_business, v_invoice, l.line_no, l.variant_id, l.unit_id, l.product_name, l.variant_name, l.sku, l.unit_name, l.hs_code, l.qty_entered,
         l.factor_to_base, l.qty_base, l.unit_price_paisa, l.gross_paisa, l.line_discount_paisa, l.invoice_discount_share_paisa, l.net_paisa,
         l.tax_rate_bps, l.tax_included, l.taxable_paisa, l.tax_paisa, l.total_paisa,
         CASE WHEN pr.product_type = 'stocked' THEN coalesce(b.avg_cost_paisa, v.cost_paisa) ELSE v.cost_paisa END
  FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id
  JOIN products pr ON pr.id = v.product_id
  LEFT JOIN stock_balances b ON b.variant_id = l.variant_id AND b.location_id = v_location
  ORDER BY l.line_no;

  -- Stock leaves at the average cost; the ledger trigger keeps the balances in step.
  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT v_business, l.variant_id, v_location, -l.qty_base, coalesce(b.avg_cost_paisa, v.cost_paisa), 'sales_invoice', v_invoice, p_actor
  FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id
  JOIN products pr ON pr.id = v.product_id AND pr.product_type = 'stocked'
  LEFT JOIN stock_balances b ON b.variant_id = l.variant_id AND b.location_id = v_location
  ORDER BY l.line_no;

  INSERT INTO payments (business_id, invoice_id, method_id, method_code, method_name, tender_kind, amount_paisa, tendered_paisa, change_paisa, reference, created_by)
  SELECT v_business, v_invoice, m.id, m.code, m.name, CASE WHEN m.kind = 'cash' THEN 'cash' ELSE 'other' END,
         pay.amount_paisa, pay.tendered_paisa, pay.change_paisa, coalesce(pay.reference, ''), p_actor
  FROM jsonb_populate_recordset(NULL::sales_payment_input, p->'payments') pay
  JOIN payment_methods m ON m.id = pay.method_id;

  RETURN v_invoice;
END;
$$;

-- ---------------------------------------------------------------- change counters for the POS cache (technical-plan 5.7)

CREATE TABLE data_versions (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  dataset text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, dataset)
);

-- The next version of a dataset. Everything changed in one transaction shares one version, which the transaction caches in a
-- local setting. The UPDATE locks the counter until commit, so versions become visible in the order they were taken: a
-- terminal that has seen version N has seen every change up to N.
CREATE FUNCTION next_data_version(p_business uuid, p_dataset text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  -- A setting name must be plain identifiers, so the business id's hyphens become underscores.
  v_key text := 'pos.dv_' || p_dataset || '_' || replace(p_business::text, '-', '_');
  v_cached text := current_setting(v_key, true);
  v_version bigint;
BEGIN
  IF v_cached IS NOT NULL AND v_cached <> '' THEN RETURN v_cached::bigint; END IF;
  INSERT INTO data_versions (business_id, dataset, version) VALUES (p_business, p_dataset, 1)
  ON CONFLICT (business_id, dataset) DO UPDATE SET version = data_versions.version + 1, updated_at = now()
  RETURNING version INTO v_version;
  PERFORM set_config(v_key, v_version::text, true);
  RETURN v_version;
END;
$$;

-- Marks a dataset as changed. TG_ARGV[0] is the dataset; TG_ARGV[1] names the business column when it is not business_id.
CREATE FUNCTION bump_dataset_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_column text := coalesce(TG_ARGV[1], 'business_id');
  v_business uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_business := (to_jsonb(OLD) ->> v_column)::uuid; ELSE v_business := (to_jsonb(NEW) ->> v_column)::uuid; END IF;
  PERFORM next_data_version(v_business, TG_ARGV[0]);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- role_permissions has no business column; its role does.
CREATE FUNCTION bump_access_version_for_role_permission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT business_id INTO v_business FROM roles WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  IF v_business IS NOT NULL THEN PERFORM next_data_version(v_business, 'access'); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Each product carries the version it last changed at, including changes to its SKUs and units, so a terminal asks only
-- for "products changed since version N". Archived products stay in the list as inactive so a terminal can drop them.
ALTER TABLE products ADD COLUMN catalog_version bigint NOT NULL DEFAULT 0;
CREATE INDEX products_catalog_version_idx ON products (business_id, catalog_version);

CREATE FUNCTION stamp_product_catalog_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.catalog_version := next_data_version(NEW.business_id, 'catalogue');
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_stamp_version BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION stamp_product_catalog_version();

CREATE FUNCTION touch_product_for_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_product uuid;
  v_version bigint;
BEGIN
  IF TG_TABLE_NAME = 'product_variants' THEN
    v_product := v_row.product_id;
  ELSE
    SELECT product_id INTO v_product FROM product_variants WHERE id = v_row.variant_id;
  END IF;
  IF v_product IS NOT NULL THEN
    v_version := next_data_version(v_row.business_id, 'catalogue');
    UPDATE products SET catalog_version = v_version WHERE id = v_product AND catalog_version IS DISTINCT FROM v_version;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_variants_touch_product AFTER INSERT OR UPDATE OR DELETE ON product_variants FOR EACH ROW EXECUTE FUNCTION touch_product_for_child();
CREATE TRIGGER product_units_touch_product AFTER INSERT OR UPDATE OR DELETE ON product_units FOR EACH ROW EXECUTE FUNCTION touch_product_for_child();

-- Reference data a terminal keeps locally.
CREATE TRIGGER categories_version AFTER INSERT OR UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER brands_version AFTER INSERT OR UPDATE OR DELETE ON brands FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER tax_categories_version AFTER INSERT OR UPDATE OR DELETE ON tax_categories FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER units_version AFTER INSERT OR UPDATE OR DELETE ON units FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER price_lists_version AFTER INSERT OR UPDATE OR DELETE ON price_lists FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER price_list_items_version AFTER INSERT OR UPDATE OR DELETE ON price_list_items FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER payment_methods_version AFTER INSERT OR UPDATE OR DELETE ON payment_methods FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
-- Business, branch, terminal and settings.
CREATE TRIGGER businesses_version AFTER INSERT OR UPDATE OR DELETE ON businesses FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('settings', 'id');
CREATE TRIGGER business_settings_version AFTER INSERT OR UPDATE OR DELETE ON business_settings FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('settings');
CREATE TRIGGER branches_version AFTER INSERT OR UPDATE OR DELETE ON branches FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('settings');
CREATE TRIGGER locations_version AFTER INSERT OR UPDATE OR DELETE ON locations FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('settings');
CREATE TRIGGER terminals_version AFTER INSERT OR UPDATE OR DELETE ON terminals FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('settings');
-- Who may do what.
CREATE TRIGGER roles_version AFTER INSERT OR UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('access');
CREATE TRIGGER users_version AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('access');
CREATE TRIGGER role_permissions_version AFTER INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION bump_access_version_for_role_permission();

-- ---------------------------------------------------------------- backfill existing businesses

SELECT seed_sales_defaults(b.id, (SELECT u.id FROM users u WHERE u.business_id = b.id ORDER BY u.created_at LIMIT 1)) FROM businesses b;

-- Stamp the products that already exist, so a terminal's first sync sees them.
UPDATE products SET name = name;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('sales.create', 'Ring up and post sales'),
  ('sales.discount', 'Give line and bill discounts up to the role''s limit'),
  ('sales.discount.above_limit', 'Approve a discount above another user''s limit (manager PIN)'),
  ('sales.price_override', 'Change a price at the till'),
  ('sales.reprint', 'Reprint a sales document (marked DUPLICATE and logged)'),
  ('sales.void', 'Void a sale in progress'),
  ('shifts.open', 'Open a cash register shift'),
  ('shifts.close', 'Close a cash register shift with a cash count'),
  ('shifts.view_all', 'See and report on other users'' shifts'),
  ('cash.movement', 'Record cash in and cash out during a shift'),
  ('reports.sales.view', 'View sales reports')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('sales.create'), ('sales.discount'), ('sales.discount.above_limit'), ('sales.price_override'), ('sales.reprint'), ('sales.void'),
  ('shifts.open'), ('shifts.close'), ('shifts.view_all'), ('cash.movement'), ('reports.sales.view')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('sales.create'), ('sales.discount'), ('sales.reprint'), ('sales.void'), ('shifts.open'), ('shifts.close'), ('cash.movement')) AS k(key)
WHERE r.is_system AND r.name = 'Cashier'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- row-level security (second line of defence)

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE held_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_versions ENABLE ROW LEVEL SECURITY;
