-- v0.5 slice 3: supplier bills with landed cost and input tax (technical-plan 3.1; FR-PUR-04, FR-PUR-09). API-only like the rest.
--
-- A bill is the supplier's invoice for goods already received. It creates the payable (a credit in the supplier's ledger) and
-- carries what the receipt could not know: the price the supplier actually charged, freight and other charges, and input tax.
-- Freight and price differences become part of what the goods cost, so the stock ledger gets a cost adjustment.

-- ---------------------------------------------------------------- cost adjustments in the stock ledger

-- A cost adjustment moves the average cost without moving stock: quantity zero, with the value to spread over what is on hand.
ALTER TABLE stock_ledger ADD COLUMN value_delta_paisa bigint NOT NULL DEFAULT 0;
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_qty_base_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_qty_base_check
  CHECK (qty_base <> 0 OR (doc_type = 'cost_adjustment' AND value_delta_paisa <> 0));
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_value_delta_check
  CHECK (value_delta_paisa = 0 OR (qty_base = 0 AND doc_type = 'cost_adjustment'));

-- As in 0002, plus the adjustment: new_avg = (on_hand x avg + value) / on_hand, to the whole paisa and never below zero. With no
-- stock on hand there is nothing to carry the value, so the average stays.
CREATE OR REPLACE FUNCTION apply_stock_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous stock_balances%ROWTYPE;
  new_average bigint;
BEGIN
  INSERT INTO stock_balances (business_id, variant_id, location_id)
  VALUES (NEW.business_id, NEW.variant_id, NEW.location_id)
  ON CONFLICT (variant_id, location_id) DO NOTHING;

  SELECT * INTO previous FROM stock_balances
  WHERE variant_id = NEW.variant_id AND location_id = NEW.location_id FOR UPDATE;

  new_average := previous.avg_cost_paisa;
  IF NEW.qty_base = 0 THEN
    IF previous.on_hand > 0 THEN
      new_average := greatest(round((previous.on_hand * previous.avg_cost_paisa + NEW.value_delta_paisa) / previous.on_hand), 0);
    END IF;
  ELSIF NEW.qty_base > 0 AND previous.on_hand + NEW.qty_base > 0 THEN
    new_average := round(
      (greatest(previous.on_hand, 0) * previous.avg_cost_paisa + NEW.qty_base * NEW.unit_cost_paisa)
      / (greatest(previous.on_hand, 0) + NEW.qty_base)
    );
  END IF;

  UPDATE stock_balances
  SET on_hand = previous.on_hand + NEW.qty_base, avg_cost_paisa = new_average, updated_at = now()
  WHERE variant_id = NEW.variant_id AND location_id = NEW.location_id;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- bills

CREATE TABLE purchase_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- The supplier's own invoice number. The same supplier cannot bill the same number twice.
  supplier_invoice_no text NOT NULL CHECK (length(btrim(supplier_invoice_no)) > 0),
  bill_date date NOT NULL,
  -- The bill date plus the supplier's payment terms.
  due_date date NOT NULL,
  note text NOT NULL DEFAULT '',
  subtotal_paisa bigint NOT NULL CHECK (subtotal_paisa >= 0),
  charges_paisa bigint NOT NULL DEFAULT 0 CHECK (charges_paisa >= 0),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  CHECK (total_paisa = subtotal_paisa + charges_paisa + tax_paisa)
);
CREATE UNIQUE INDEX purchase_bills_supplier_invoice_idx ON purchase_bills (business_id, supplier_id, lower(btrim(supplier_invoice_no)));
CREATE INDEX purchase_bills_supplier_idx ON purchase_bills (business_id, supplier_id, bill_date DESC);

CREATE TABLE purchase_bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bill_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  receipt_line_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  -- The price per bought unit on the supplier's invoice.
  unit_cost_paisa bigint NOT NULL CHECK (unit_cost_paisa >= 0),
  line_value_paisa bigint NOT NULL CHECK (line_value_paisa >= 0),
  -- Input tax on the line: recoverable, so it is not part of what the goods cost.
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  -- This line's share of the bill's freight and other charges, by value. It is part of what the goods cost.
  charge_share_paisa bigint NOT NULL DEFAULT 0 CHECK (charge_share_paisa >= 0),
  -- What the receipt put the stock in at, per base unit, and the value this bill added to (or took from) the stock still on hand.
  receipt_cost_per_base_paisa bigint NOT NULL CHECK (receipt_cost_per_base_paisa >= 0),
  absorbed_paisa bigint NOT NULL DEFAULT 0,
  UNIQUE (bill_id, line_no),
  FOREIGN KEY (bill_id, business_id) REFERENCES purchase_bills(id, business_id),
  FOREIGN KEY (receipt_line_id, business_id) REFERENCES goods_receipt_lines(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id)
);
CREATE INDEX purchase_bill_lines_receipt_idx ON purchase_bill_lines (receipt_line_id);

CREATE TABLE purchase_bill_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bill_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  UNIQUE (bill_id, line_no),
  FOREIGN KEY (bill_id, business_id) REFERENCES purchase_bills(id, business_id)
);

CREATE FUNCTION protect_posted_purchase_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a purchase return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;
CREATE TRIGGER purchase_bills_protect BEFORE UPDATE OR DELETE ON purchase_bills FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();
CREATE TRIGGER purchase_bill_lines_protect BEFORE UPDATE OR DELETE ON purchase_bill_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();
CREATE TRIGGER purchase_bill_charges_protect BEFORE UPDATE OR DELETE ON purchase_bill_charges FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();

CREATE TYPE bill_line_input AS (
  receipt_line_id uuid, qty_entered numeric, qty_base numeric, unit_cost_paisa bigint, line_value_paisa bigint,
  tax_rate_bps integer, tax_paisa bigint, charge_share_paisa bigint
);
CREATE TYPE bill_charge_input AS (description text, amount_paisa bigint);

-- Posts a supplier bill in the caller's transaction. The supplier is locked first, so two bills or a bill and a payment for the same
-- supplier queue up. Each line bills some of a receipt line (never more than was received and not yet billed: BILL_EXCEEDS_RECEIPT)
-- at the price on the invoice. The bill's total must be exactly lines + charges + tax (BILL_TOTAL_MISMATCH).
--
-- What the goods cost: the line's value plus its share of the charges. Where that differs from what the receipt put the stock in at,
-- the difference is spread over the stock still on hand (at most the quantity this line billed) through a cost adjustment in the stock
-- ledger. Stock already sold keeps the cost it was sold at, so only the part still held is corrected; the line records what was absorbed.
CREATE FUNCTION post_purchase_bill(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_id uuid := gen_random_uuid();
  v_terms integer;
  v_branch uuid;
  v_number text;
  v_sequence integer;
  v_date date := (p->>'bill_date')::date;
  v_count integer;
  v_matched integer;
  v_charges bigint;
  v_on_hand numeric(14,3);
  v_delta bigint;
  v_absorbed bigint;
  sums record;
  line record;
BEGIN
  SELECT terms_days INTO v_terms FROM suppliers WHERE id = v_supplier AND business_id = v_business AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: this supplier is not available'; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one received item to bill'; END IF;
  IF (SELECT count(DISTINCT receipt_line_id) FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines')) <> v_count THEN
    RAISE EXCEPTION 'INVALID_LINE: a receipt line can be on a bill only once';
  END IF;

  -- The figures add up: the same sums the API did.
  SELECT coalesce(sum(line_value_paisa), 0) AS value, coalesce(sum(tax_paisa), 0) AS tax, coalesce(sum(charge_share_paisa), 0) AS share INTO sums
  FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines');
  SELECT coalesce(sum(amount_paisa), 0) INTO v_charges FROM jsonb_populate_recordset(NULL::bill_charge_input, coalesce(p->'charges', '[]'::jsonb));
  IF sums.value <> (p->>'subtotal_paisa')::bigint OR sums.tax <> (p->>'tax_paisa')::bigint OR sums.share <> v_charges
     OR v_charges <> (p->>'charges_paisa')::bigint OR sums.value + v_charges + sums.tax <> (p->>'total_paisa')::bigint
     OR EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines') l WHERE l.line_value_paisa <> round(l.qty_entered * l.unit_cost_paisa)) THEN
    RAISE EXCEPTION 'BILL_TOTAL_MISMATCH: the lines, charges and tax do not add up to the bill';
  END IF;

  -- Lock the receipt lines in a fixed order. Each is this supplier's, in the unit it was received in.
  PERFORM 1 FROM goods_receipt_lines WHERE business_id = v_business
    AND id IN (SELECT receipt_line_id FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines')) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines') l
  JOIN goods_receipt_lines rl ON rl.id = l.receipt_line_id AND rl.business_id = v_business
  JOIN goods_receipts r ON r.id = rl.receipt_id AND r.supplier_id = v_supplier
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * rl.factor_to_base;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not a received item of this supplier'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines') l JOIN goods_receipt_lines rl ON rl.id = l.receipt_line_id
    WHERE l.qty_base > rl.qty_base - rl.billed_base
  ) THEN RAISE EXCEPTION 'BILL_EXCEEDS_RECEIPT: more is being billed than was received and not yet billed'; END IF;

  SELECT r.branch_id INTO v_branch FROM goods_receipt_lines rl JOIN goods_receipts r ON r.id = rl.receipt_id
  WHERE rl.id = (SELECT receipt_line_id FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines') LIMIT 1);
  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'purchase_bill', 'BILL-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'purchase_bill');

  INSERT INTO purchase_bills (id, business_id, branch_id, supplier_id, number, sequence_no, supplier_invoice_no, bill_date, due_date, note,
                              subtotal_paisa, charges_paisa, tax_paisa, total_paisa, created_by)
  VALUES (v_id, v_business, v_branch, v_supplier, v_number, v_sequence, btrim(p->>'supplier_invoice_no'), v_date, v_date + v_terms, coalesce(p->>'note', ''),
          sums.value, v_charges, sums.tax, sums.value + v_charges + sums.tax, p_actor);

  FOR line IN
    SELECT o.receipt_line_id, o.qty_entered, o.qty_base, o.unit_cost_paisa, o.line_value_paisa, o.tax_rate_bps, o.tax_paisa, o.charge_share_paisa, o.ord,
           rl.variant_id, rl.unit_id, rl.product_name, rl.variant_name, rl.sku, rl.unit_name, rl.cost_per_base_paisa, r.location_id
    FROM jsonb_populate_recordset(NULL::bill_line_input, p->'lines')
         WITH ORDINALITY AS o(receipt_line_id, qty_entered, qty_base, unit_cost_paisa, line_value_paisa, tax_rate_bps, tax_paisa, charge_share_paisa, ord)
    JOIN goods_receipt_lines rl ON rl.id = o.receipt_line_id
    JOIN goods_receipts r ON r.id = rl.receipt_id
    ORDER BY rl.variant_id, o.ord
  LOOP
    v_delta := line.line_value_paisa + line.charge_share_paisa - round(line.qty_base * line.cost_per_base_paisa)::bigint;
    SELECT on_hand INTO v_on_hand FROM stock_balances WHERE variant_id = line.variant_id AND location_id = line.location_id FOR UPDATE;
    v_absorbed := 0;
    IF v_delta <> 0 AND coalesce(v_on_hand, 0) > 0 THEN
      v_absorbed := round(v_delta * least(v_on_hand, line.qty_base) / line.qty_base)::bigint;
    END IF;

    INSERT INTO purchase_bill_lines (business_id, bill_id, line_no, receipt_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name,
                                     qty_entered, qty_base, unit_cost_paisa, line_value_paisa, tax_rate_bps, tax_paisa, charge_share_paisa,
                                     receipt_cost_per_base_paisa, absorbed_paisa)
    VALUES (v_business, v_id, line.ord, line.receipt_line_id, line.variant_id, line.unit_id, line.product_name, line.variant_name, line.sku, line.unit_name,
            line.qty_entered, line.qty_base, line.unit_cost_paisa, line.line_value_paisa, line.tax_rate_bps, line.tax_paisa, line.charge_share_paisa,
            line.cost_per_base_paisa, v_absorbed);
    IF v_absorbed <> 0 THEN
      INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, value_delta_paisa, doc_type, doc_id, created_by)
      VALUES (v_business, line.variant_id, line.location_id, 0, 0, v_absorbed, 'cost_adjustment', v_id, p_actor);
    END IF;
    UPDATE goods_receipt_lines SET billed_base = billed_base + line.qty_base WHERE id = line.receipt_line_id;
  END LOOP;

  INSERT INTO purchase_bill_charges (business_id, bill_id, line_no, description, amount_paisa)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), c.description, c.amount_paisa
  FROM jsonb_populate_recordset(NULL::bill_charge_input, coalesce(p->'charges', '[]'::jsonb)) WITH ORDINALITY AS c(description, amount_paisa, ord);

  -- What the shop now owes the supplier.
  INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, credit_paisa, created_by)
  VALUES (v_business, 'supplier', v_supplier, 'purchase_bill', v_id, v_number, 'Bill ' || btrim(p->>'supplier_invoice_no'), sums.value + v_charges + sums.tax, p_actor);

  RETURN v_id;
END;
$$;

INSERT INTO permissions (key, description) VALUES
  ('purchasing.bill', 'Enter supplier bills (prices, freight and input tax; needs the cost permission)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'purchasing.bill' FROM roles r WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE purchase_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bill_charges ENABLE ROW LEVEL SECURITY;
