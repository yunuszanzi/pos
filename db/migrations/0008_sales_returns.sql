-- v0.4 slice 3: sales returns and credit notes (technical-plan 3.1, 5.1; FR-RET-01..07).
-- A return is a new document that points at the invoice; the invoice is never edited. API-only like the rest (see 0001).

ALTER TABLE business_settings
  -- A return after this many days, or with no receipt, needs a manager (FR-RET-03).
  ADD COLUMN return_window_days integer NOT NULL DEFAULT 14 CHECK (return_window_days BETWEEN 0 AND 365);

-- ---------------------------------------------------------------- the documents

CREATE TABLE sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- Null for a return without a receipt.
  original_invoice_id uuid,
  customer_id uuid,
  reason text NOT NULL DEFAULT '',
  tax_mode text NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  gross_paisa bigint NOT NULL CHECK (gross_paisa >= 0),
  line_discount_paisa bigint NOT NULL CHECK (line_discount_paisa >= 0),
  invoice_discount_paisa bigint NOT NULL CHECK (invoice_discount_paisa >= 0),
  taxable_paisa bigint NOT NULL CHECK (taxable_paisa >= 0),
  tax_paisa bigint NOT NULL CHECK (tax_paisa >= 0),
  rounding_paisa bigint NOT NULL,
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  -- Money handed back now (cash, wallet, bank) and what went onto the customer's account instead.
  refund_method_id uuid,
  refund_method_code text,
  refund_method_name text,
  refund_tender_kind text CHECK (refund_tender_kind IN ('cash', 'other')),
  refund_paisa bigint NOT NULL DEFAULT 0 CHECK (refund_paisa >= 0),
  refund_reference text NOT NULL DEFAULT '',
  account_credit_paisa bigint NOT NULL DEFAULT 0 CHECK (account_credit_paisa >= 0),
  approved_by uuid REFERENCES auth.users(id),
  approval_note text,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (terminal_id, business_id) REFERENCES terminals(id, business_id),
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (original_invoice_id, business_id) REFERENCES sales_invoices(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  FOREIGN KEY (refund_method_id, business_id) REFERENCES payment_methods(id, business_id),
  CHECK (total_paisa = gross_paisa - line_discount_paisa - invoice_discount_paisa
    + CASE WHEN tax_mode = 'exclusive' THEN tax_paisa ELSE 0 END + rounding_paisa),
  CHECK (refund_paisa + account_credit_paisa = total_paisa),
  CHECK (account_credit_paisa = 0 OR customer_id IS NOT NULL),
  CHECK ((refund_method_id IS NULL) = (refund_tender_kind IS NULL)),
  CHECK (refund_paisa = 0 OR refund_method_id IS NOT NULL)
);
CREATE INDEX sales_returns_posted_idx ON sales_returns (business_id, posted_at DESC);
CREATE INDEX sales_returns_invoice_idx ON sales_returns (original_invoice_id) WHERE original_invoice_id IS NOT NULL;
CREATE INDEX sales_returns_shift_idx ON sales_returns (shift_id);
CREATE INDEX sales_returns_customer_idx ON sales_returns (business_id, customer_id, posted_at DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE sales_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  return_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  original_line_id uuid REFERENCES sales_invoice_lines(id),
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
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
  -- What the goods cost the shop, so the stock that comes back keeps the average honest.
  cost_paisa bigint NOT NULL CHECK (cost_paisa >= 0),
  -- Where the goods went: back on the shelf, into the damaged location, or thrown away (no stock movement).
  restock_to text NOT NULL CHECK (restock_to IN ('sellable', 'damaged', 'write_off')),
  reason text NOT NULL DEFAULT '',
  FOREIGN KEY (return_id, business_id) REFERENCES sales_returns(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  UNIQUE (return_id, line_no),
  CHECK (qty_base = qty_entered * factor_to_base),
  CHECK (net_paisa = gross_paisa - line_discount_paisa - invoice_discount_share_paisa),
  CHECK (total_paisa = net_paisa + CASE WHEN tax_included THEN 0 ELSE tax_paisa END),
  CHECK (taxable_paisa = net_paisa - CASE WHEN tax_included THEN tax_paisa ELSE 0 END)
);
CREATE INDEX sales_return_lines_original_idx ON sales_return_lines (original_line_id) WHERE original_line_id IS NOT NULL;

CREATE TRIGGER sales_returns_protect BEFORE UPDATE OR DELETE ON sales_returns FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER sales_return_lines_protect BEFORE UPDATE OR DELETE ON sales_return_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_document();

-- ---------------------------------------------------------------- posting a return

CREATE TYPE sales_return_line_input AS (
  line_no integer, original_line_id uuid, variant_id uuid, unit_id uuid, product_name text, variant_name text, sku text, unit_name text, hs_code text,
  qty_entered numeric, factor_to_base numeric, qty_base numeric, expected_returned_base numeric, unit_price_paisa bigint, gross_paisa bigint,
  line_discount_paisa bigint, invoice_discount_share_paisa bigint, net_paisa bigint, tax_rate_bps integer, tax_included boolean,
  taxable_paisa bigint, tax_paisa bigint, total_paisa bigint, restock_to text, reason text
);

-- Posts a return in the caller's transaction. Credit notes are numbered in the branch's 'return' series (made at setup as <invoice prefix>-R). The amounts arrive worked out by shared/returns.ts; this function checks they add
-- up, locks the customer and then the invoice lines it returns against, refuses more than was sold (and a return worked out from
-- stale figures), puts the goods back as asked, and records the money. What the customer still owes on the original invoice is
-- taken off first: it is never paid out in cash. The rest goes where the cashier chose - cash or a payment method now, or onto
-- the customer's account, where more than they owe becomes store credit (a negative balance).
CREATE FUNCTION post_sales_return(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_terminal uuid := (p->>'terminal_id')::uuid;
  v_shift uuid := (p->>'shift_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_original uuid := nullif(p->>'original_invoice_id', '')::uuid;
  v_customer uuid := nullif(p->>'customer_id', '')::uuid;
  v_tax_mode text := p->>'tax_mode';
  v_rounding bigint := coalesce((p->>'rounding_paisa')::bigint, 0);
  v_total bigint := (p->>'total_paisa')::bigint;
  v_id uuid := gen_random_uuid();
  v_status text;
  v_line_count integer;
  v_matched integer;
  v_outstanding bigint := 0;
  v_forced bigint := 0;
  v_refund bigint := 0;
  v_credit bigint;
  v_damaged uuid;
  v_number text;
  v_sequence integer;
  invoice record;
  v_method_id uuid;
  v_method_code text;
  v_method_name text;
  v_method_kind text;
  need record;
  sums record;
BEGIN
  SELECT status INTO v_status FROM shifts
  WHERE id = v_shift AND business_id = v_business AND terminal_id = v_terminal FOR SHARE;
  IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN'; END IF;

  SELECT count(*) INTO v_line_count FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines');
  IF v_line_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: a return needs at least one line'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') WHERE restock_to NOT IN ('sellable', 'damaged', 'write_off') OR restock_to IS NULL) THEN
    RAISE EXCEPTION 'INVALID_LINE: choose where each returned item goes';
  END IF;

  IF v_original IS NOT NULL THEN
    SELECT customer_id, tax_mode INTO invoice FROM sales_invoices WHERE id = v_original AND business_id = v_business;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RETURN: that invoice does not exist'; END IF;
    v_customer := invoice.customer_id;
    v_tax_mode := invoice.tax_mode;
  END IF;

  -- The customer first, like a sale or a payment, so the three queue up instead of deadlocking.
  IF v_customer IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_customer AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;
  END IF;

  IF v_original IS NOT NULL THEN
    -- Each line is a distinct line of that invoice, in the unit it was sold in, and still has that much left to return.
    IF (SELECT count(DISTINCT original_line_id) FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines')) <> v_line_count THEN
      RAISE EXCEPTION 'INVALID_LINE: a line can be returned only once in one return';
    END IF;
    v_matched := 0;
    FOR need IN
      SELECT l.id, l.qty_base, l.returned_qty_base, r.qty_base AS want, r.expected_returned_base
      FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') r
      JOIN sales_invoice_lines l ON l.id = r.original_line_id AND l.invoice_id = v_original AND l.business_id = v_business
        AND l.variant_id = r.variant_id AND l.unit_id = r.unit_id AND l.factor_to_base = r.factor_to_base
      ORDER BY l.id FOR UPDATE OF l
    LOOP
      v_matched := v_matched + 1;
      IF need.returned_qty_base <> need.expected_returned_base THEN RAISE EXCEPTION 'RETURN_CHANGED: this invoice was returned against since it was loaded'; END IF;
      IF need.returned_qty_base + need.want > need.qty_base THEN RAISE EXCEPTION 'RETURN_EXCEEDS_SOLD: more is being returned than was sold'; END IF;
      UPDATE sales_invoice_lines SET returned_qty_base = returned_qty_base + need.want WHERE id = need.id;
    END LOOP;
    IF v_matched <> v_line_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on that invoice'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') WHERE original_line_id IS NOT NULL) THEN
      RAISE EXCEPTION 'INVALID_LINE: a line points at an invoice that was not given';
    END IF;
    SELECT count(*) INTO v_matched
    FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') l
    JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
    JOIN products pr ON pr.id = v.product_id AND pr.active
    JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business AND pu.factor_to_base = l.factor_to_base;
    IF v_matched <> v_line_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active product sold in that unit'; END IF;
  END IF;

  SELECT sum(total_paisa) AS total, sum(gross_paisa) AS gross, sum(line_discount_paisa) AS line_discount,
         sum(invoice_discount_share_paisa) AS invoice_discount, sum(tax_paisa) AS tax, sum(taxable_paisa) AS taxable
  INTO sums FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines');
  IF sums.total + v_rounding <> v_total
     OR sums.gross <> (p->>'gross_paisa')::bigint
     OR sums.line_discount <> (p->>'line_discount_paisa')::bigint
     OR sums.invoice_discount <> (p->>'invoice_discount_paisa')::bigint
     OR sums.tax <> (p->>'tax_paisa')::bigint
     OR sums.taxable <> (p->>'taxable_paisa')::bigint THEN
    RAISE EXCEPTION 'RETURN_TOTAL_MISMATCH: the lines do not add up to the return';
  END IF;

  -- Money: what the customer still owes on that invoice is settled by the return first. Only the rest can be paid out.
  IF v_original IS NOT NULL AND v_customer IS NOT NULL THEN
    SELECT coalesce(max(outstanding_paisa), 0) INTO v_outstanding FROM customer_open_invoices(v_business, v_customer) WHERE invoice_id = v_original;
    v_forced := least(v_total, v_outstanding);
  END IF;
  IF nullif(p->>'refund_method_id', '') IS NOT NULL THEN
    SELECT id, code, name, kind INTO v_method_id, v_method_code, v_method_name, v_method_kind FROM payment_methods WHERE id = (p->>'refund_method_id')::uuid AND business_id = v_business AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_REFUND: that payment method is not available'; END IF;
    v_refund := v_total - v_forced;
  END IF;
  v_credit := v_total - v_refund;
  IF v_credit > 0 AND v_customer IS NULL THEN
    RAISE EXCEPTION 'INVALID_REFUND: a sale to a walk-in is refunded in cash or by a payment method, not onto an account';
  END IF;

  -- Damaged goods go to the branch's damaged location; it is made the first time one is needed.
  IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') WHERE restock_to = 'damaged') THEN
    SELECT id INTO v_damaged FROM locations WHERE business_id = v_business AND branch_id = v_branch AND type = 'damaged' AND active ORDER BY created_at LIMIT 1;
    IF v_damaged IS NULL THEN
      INSERT INTO locations (business_id, branch_id, name, type) VALUES (v_business, v_branch, 'Damaged returns', 'damaged') RETURNING id INTO v_damaged;
    END IF;
  END IF;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'return', coalesce((SELECT prefix FROM document_series WHERE branch_id = b.id AND doc_type = 'invoice'), 'INV-' || upper(b.code)) || '-R', p_actor, p_actor
  FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'return');

  INSERT INTO sales_returns (
    id, business_id, branch_id, terminal_id, shift_id, location_id, number, sequence_no, original_invoice_id, customer_id, reason, tax_mode,
    gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa,
    refund_method_id, refund_method_code, refund_method_name, refund_tender_kind, refund_paisa, refund_reference, account_credit_paisa,
    approved_by, approval_note, created_by
  ) VALUES (
    v_id, v_business, v_branch, v_terminal, v_shift, v_location, v_number, v_sequence, v_original, v_customer, coalesce(p->>'reason', ''), v_tax_mode,
    sums.gross, sums.line_discount, sums.invoice_discount, sums.taxable, sums.tax, v_rounding, v_total,
    v_method_id, v_method_code, v_method_name, CASE WHEN v_method_id IS NULL THEN NULL WHEN v_method_kind = 'cash' THEN 'cash' ELSE 'other' END,
    v_refund, coalesce(p->>'refund_reference', ''), v_credit,
    nullif(p->>'approved_by', '')::uuid, nullif(p->>'approval_note', ''), p_actor
  );

  INSERT INTO sales_return_lines (
    business_id, return_id, line_no, original_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered,
    factor_to_base, qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps,
    tax_included, taxable_paisa, tax_paisa, total_paisa, cost_paisa, restock_to, reason
  )
  SELECT v_business, v_id, l.line_no, l.original_line_id, l.variant_id, l.unit_id, l.product_name, l.variant_name, l.sku, l.unit_name, l.hs_code,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_price_paisa, l.gross_paisa, l.line_discount_paisa, l.invoice_discount_share_paisa,
         l.net_paisa, l.tax_rate_bps, l.tax_included, l.taxable_paisa, l.tax_paisa, l.total_paisa,
         coalesce(ol.cost_paisa, CASE WHEN pr.product_type = 'stocked' THEN coalesce(b.avg_cost_paisa, v.cost_paisa) ELSE v.cost_paisa END),
         l.restock_to, coalesce(l.reason, '')
  FROM jsonb_populate_recordset(NULL::sales_return_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id
  JOIN products pr ON pr.id = v.product_id
  LEFT JOIN sales_invoice_lines ol ON ol.id = l.original_line_id
  LEFT JOIN stock_balances b ON b.variant_id = l.variant_id AND b.location_id = v_location
  ORDER BY l.line_no;

  -- Stock comes back at the cost it left at. A write-off moves nothing: the goods were never in stock again.
  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT v_business, rl.variant_id, CASE rl.restock_to WHEN 'damaged' THEN v_damaged ELSE v_location END, rl.qty_base, rl.cost_paisa, 'sales_return', v_id, p_actor
  FROM sales_return_lines rl
  JOIN product_variants v ON v.id = rl.variant_id
  JOIN products pr ON pr.id = v.product_id AND pr.product_type = 'stocked'
  WHERE rl.return_id = v_id AND rl.restock_to <> 'write_off'
  ORDER BY rl.variant_id, rl.line_no;

  -- The customer's account: the whole return as a credit, then what was paid out as a debit, so a statement reads
  -- invoices - returns - payments.
  IF v_customer IS NOT NULL AND v_total > 0 THEN
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, credit_paisa, created_by)
    VALUES (v_business, 'customer', v_customer, 'sales_return', v_id, v_number, 'Return', v_total, p_actor);
    IF v_refund > 0 THEN
      INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
      VALUES (v_business, 'customer', v_customer, 'sales_return', v_id, v_number, 'Refunded', v_refund, p_actor);
    END IF;
  END IF;
  IF v_credit > 0 AND v_outstanding > 0 THEN
    INSERT INTO payment_allocations (business_id, source_type, source_id, invoice_id, amount_paisa)
    VALUES (v_business, 'sales_return', v_id, v_original, least(v_credit, v_outstanding));
  END IF;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('sales.return', 'Take back goods against an invoice and give a refund or credit note'),
  ('sales.return_override', 'Approve a return without a receipt or after the return window (manager PIN)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('sales.return'), ('sales.return_override')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'sales.return' FROM roles r
WHERE r.is_system AND r.name = 'Cashier'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_lines ENABLE ROW LEVEL SECURITY;
