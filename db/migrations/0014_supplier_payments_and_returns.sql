-- v0.5 slice 4: paying suppliers, and returning goods to them (technical-plan 3.1; FR-PUR-05, FR-PUR-06). API-only like the rest.

-- ---------------------------------------------------------------- payments to suppliers

CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- Cash comes out of a shift's drawer, so a cash payment always belongs to an open shift.
  shift_id uuid,
  method_id uuid NOT NULL,
  method_code text NOT NULL,
  method_name text NOT NULL,
  tender_kind text NOT NULL CHECK (tender_kind IN ('cash', 'other')),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id),
  FOREIGN KEY (method_id, business_id) REFERENCES payment_methods(id, business_id),
  CHECK (tender_kind <> 'cash' OR shift_id IS NOT NULL)
);
CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (business_id, supplier_id, posted_at DESC);
CREATE INDEX supplier_payments_shift_idx ON supplier_payments (shift_id) WHERE shift_id IS NOT NULL;

-- Which bill a payment (or a debit note from a purchase return) settled. Whatever is not allocated stays on the supplier's account.
CREATE TABLE supplier_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('supplier_payment', 'purchase_return')),
  source_id uuid NOT NULL,
  bill_id uuid NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bill_id, business_id) REFERENCES purchase_bills(id, business_id)
);
CREATE INDEX supplier_payment_allocations_bill_idx ON supplier_payment_allocations (bill_id);
CREATE INDEX supplier_payment_allocations_source_idx ON supplier_payment_allocations (source_id);

CREATE TRIGGER supplier_payments_protect BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();
CREATE TRIGGER supplier_payment_allocations_protect BEFORE UPDATE OR DELETE ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();

-- A supplier's bills that still have something owing, oldest first: the total less everything allocated to the bill.
CREATE FUNCTION supplier_open_bills(p_business uuid, p_supplier uuid)
RETURNS TABLE (bill_id uuid, number text, supplier_invoice_no text, bill_date date, due_date date, total_paisa bigint, outstanding_paisa bigint)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.number, b.supplier_invoice_no, b.bill_date, b.due_date, b.total_paisa, b.total_paisa - coalesce(a.allocated, 0)
  FROM purchase_bills b
  LEFT JOIN LATERAL (SELECT sum(x.amount_paisa) AS allocated FROM supplier_payment_allocations x WHERE x.bill_id = b.id) a ON true
  WHERE b.business_id = p_business AND b.supplier_id = p_supplier AND b.total_paisa - coalesce(a.allocated, 0) > 0
  ORDER BY b.bill_date, b.number;
$$;

CREATE TYPE supplier_allocation_input AS (bill_id uuid, amount_paisa bigint);

-- Pays a supplier in the caller's transaction. The supplier is locked first, so two payments, or a payment and a bill, queue up.
-- `allocate` is 'oldest' (settle the oldest bills first) or 'manual' (the listed allocations); money not allocated stays on the
-- account, where it is an advance (a credit with the supplier). Cash needs an open shift and comes out of its drawer.
CREATE FUNCTION post_supplier_payment(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_shift uuid := nullif(p->>'shift_id', '')::uuid;
  v_terminal uuid := nullif(p->>'terminal_id', '')::uuid;
  v_amount bigint := (p->>'amount_paisa')::bigint;
  v_manual boolean := coalesce(p->>'allocate', 'oldest') = 'manual';
  v_id uuid := gen_random_uuid();
  v_status text;
  v_number text;
  v_sequence integer;
  v_left bigint;
  v_take bigint;
  method record;
  open_bill record;
  wanted record;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'INVALID_PAYMENT: the amount must be more than zero'; END IF;

  PERFORM 1 FROM suppliers WHERE id = v_supplier AND business_id = v_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: this supplier is not available'; END IF;

  SELECT id, code, name, kind INTO method FROM payment_methods WHERE id = (p->>'method_id')::uuid AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT: that payment method is not available'; END IF;

  IF method.kind = 'cash' AND v_shift IS NULL THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN: open a shift on this terminal to pay cash'; END IF;
  IF v_shift IS NOT NULL THEN
    SELECT status INTO v_status FROM shifts
    WHERE id = v_shift AND business_id = v_business AND (v_terminal IS NULL OR terminal_id = v_terminal) FOR SHARE;
    IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN'; END IF;
  END IF;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'supplier_payment', 'SPY-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'supplier_payment');

  INSERT INTO supplier_payments (id, business_id, branch_id, supplier_id, number, sequence_no, shift_id, method_id, method_code, method_name,
                                 tender_kind, amount_paisa, reference, note, created_by)
  VALUES (v_id, v_business, v_branch, v_supplier, v_number, v_sequence, v_shift, method.id, method.code, method.name,
          CASE WHEN method.kind = 'cash' THEN 'cash' ELSE 'other' END, v_amount, coalesce(p->>'reference', ''), coalesce(p->>'note', ''), p_actor);

  v_left := v_amount;
  IF v_manual THEN
    FOR wanted IN SELECT bill_id, sum(amount_paisa) AS amount FROM jsonb_populate_recordset(NULL::supplier_allocation_input, p->'allocations') GROUP BY bill_id ORDER BY bill_id LOOP
      IF wanted.amount <= 0 THEN RAISE EXCEPTION 'INVALID_ALLOCATION: each allocation must be more than zero'; END IF;
      SELECT * INTO open_bill FROM supplier_open_bills(v_business, v_supplier) o WHERE o.bill_id = wanted.bill_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ALLOCATION: a bill is not open for this supplier'; END IF;
      IF wanted.amount > open_bill.outstanding_paisa THEN
        RAISE EXCEPTION 'INVALID_ALLOCATION: % has only % owing', open_bill.number, open_bill.outstanding_paisa;
      END IF;
      v_left := v_left - wanted.amount;
      IF v_left < 0 THEN RAISE EXCEPTION 'INVALID_ALLOCATION: the allocations are more than the payment'; END IF;
      INSERT INTO supplier_payment_allocations (business_id, source_type, source_id, bill_id, amount_paisa) VALUES (v_business, 'supplier_payment', v_id, wanted.bill_id, wanted.amount);
    END LOOP;
  ELSE
    FOR open_bill IN SELECT * FROM supplier_open_bills(v_business, v_supplier) LOOP
      EXIT WHEN v_left = 0;
      v_take := least(v_left, open_bill.outstanding_paisa);
      v_left := v_left - v_take;
      INSERT INTO supplier_payment_allocations (business_id, source_type, source_id, bill_id, amount_paisa) VALUES (v_business, 'supplier_payment', v_id, open_bill.bill_id, v_take);
    END LOOP;
  END IF;

  INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
  VALUES (v_business, 'supplier', v_supplier, 'supplier_payment', v_id, v_number, method.name, v_amount, p_actor);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- returning goods to a supplier

ALTER TABLE goods_receipt_lines ADD COLUMN returned_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (returned_base >= 0 AND returned_base <= qty_base);

-- A posted receipt never changes, except what later documents take up of a line: billed_base (bills) and returned_base (returns).
CREATE OR REPLACE FUNCTION protect_goods_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'goods_receipt_lines' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'billed_base' - 'returned_base') = (to_jsonb(OLD) - 'billed_base' - 'returned_base') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a purchase return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  reason text NOT NULL DEFAULT '',
  subtotal_paisa bigint NOT NULL CHECK (subtotal_paisa >= 0),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  FOREIGN KEY (receipt_id, business_id) REFERENCES goods_receipts(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  CHECK (total_paisa = subtotal_paisa + tax_paisa)
);
CREATE INDEX purchase_returns_supplier_idx ON purchase_returns (business_id, supplier_id, posted_at DESC);
CREATE INDEX purchase_returns_receipt_idx ON purchase_returns (receipt_id);

CREATE TABLE purchase_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  return_id uuid NOT NULL,
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
  -- What the supplier credits for one bought unit: the billed price when the goods were billed, else the receipt's.
  unit_cost_paisa bigint NOT NULL CHECK (unit_cost_paisa >= 0),
  line_value_paisa bigint NOT NULL CHECK (line_value_paisa >= 0),
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  UNIQUE (return_id, line_no),
  FOREIGN KEY (return_id, business_id) REFERENCES purchase_returns(id, business_id),
  FOREIGN KEY (receipt_line_id, business_id) REFERENCES goods_receipt_lines(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id)
);

CREATE TRIGGER purchase_returns_protect BEFORE UPDATE OR DELETE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();
CREATE TRIGGER purchase_return_lines_protect BEFORE UPDATE OR DELETE ON purchase_return_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_purchase_document();

CREATE TYPE return_to_supplier_line_input AS (
  receipt_line_id uuid, qty_entered numeric, qty_base numeric, unit_cost_paisa bigint, line_value_paisa bigint, tax_rate_bps integer, tax_paisa bigint
);

-- Posts a purchase return (a debit note) in the caller's transaction: goods go back to the supplier from the receipt's location, and
-- what the shop owes falls by their value plus tax. Each line returns some of a receipt line, never more than was received and not
-- yet returned (RETURN_EXCEEDS_RECEIVED), and never more than is on hand (STOCK_INSUFFICIENT: goods already sold cannot go back).
-- The credit settles the supplier's oldest open bills first; anything left over stays on the account as a credit with them.
CREATE FUNCTION post_purchase_return(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_receipt uuid := (p->>'receipt_id')::uuid;
  v_id uuid := gen_random_uuid();
  v_supplier uuid;
  v_location uuid;
  v_branch uuid;
  v_count integer;
  v_matched integer;
  v_number text;
  v_sequence integer;
  v_left bigint;
  v_take bigint;
  sums record;
  need record;
  open_bill record;
BEGIN
  SELECT supplier_id, location_id, branch_id INTO v_supplier, v_location, v_branch FROM goods_receipts WHERE id = v_receipt AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such goods receipt'; END IF;
  PERFORM 1 FROM suppliers WHERE id = v_supplier AND business_id = v_business FOR UPDATE;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: choose what is going back'; END IF;
  IF (SELECT count(DISTINCT receipt_line_id) FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines')) <> v_count THEN
    RAISE EXCEPTION 'INVALID_LINE: a receipt line can be returned only once in one return';
  END IF;

  SELECT coalesce(sum(line_value_paisa), 0) AS value, coalesce(sum(tax_paisa), 0) AS tax INTO sums FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines');
  IF sums.value <> (p->>'subtotal_paisa')::bigint OR sums.tax <> (p->>'tax_paisa')::bigint OR sums.value + sums.tax <> (p->>'total_paisa')::bigint
     OR EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines') l WHERE l.line_value_paisa <> round(l.qty_entered * l.unit_cost_paisa)) THEN
    RAISE EXCEPTION 'RETURN_TOTAL_MISMATCH: the lines and tax do not add up to the return';
  END IF;

  -- The lines are this receipt's, in the unit they were received in.
  PERFORM 1 FROM goods_receipt_lines WHERE receipt_id = v_receipt AND business_id = v_business ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines') l
  JOIN goods_receipt_lines rl ON rl.id = l.receipt_line_id AND rl.receipt_id = v_receipt AND rl.business_id = v_business
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * rl.factor_to_base;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this receipt'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines') l JOIN goods_receipt_lines rl ON rl.id = l.receipt_line_id
    WHERE l.qty_base > rl.qty_base - rl.returned_base
  ) THEN RAISE EXCEPTION 'RETURN_EXCEEDS_RECEIVED: more is going back than was received and not yet returned'; END IF;

  -- Goods can only go back if they are still here. The stock rows are locked in a fixed order.
  FOR need IN
    SELECT rl.variant_id, sum(l.qty_base) AS qty
    FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines') l JOIN goods_receipt_lines rl ON rl.id = l.receipt_line_id
    GROUP BY rl.variant_id ORDER BY rl.variant_id
  LOOP
    PERFORM 1 FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location FOR UPDATE;
    IF NOT FOUND OR (SELECT on_hand FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location) < need.qty THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has less on hand than the % being returned', need.variant_id, need.qty;
    END IF;
  END LOOP;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'purchase_return', 'PRT-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'purchase_return');

  INSERT INTO purchase_returns (id, business_id, branch_id, supplier_id, receipt_id, location_id, number, sequence_no, reason, subtotal_paisa, tax_paisa, total_paisa, created_by)
  VALUES (v_id, v_business, v_branch, v_supplier, v_receipt, v_location, v_number, v_sequence, coalesce(p->>'reason', ''), sums.value, sums.tax, sums.value + sums.tax, p_actor);

  INSERT INTO purchase_return_lines (business_id, return_id, line_no, receipt_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name,
                                     qty_entered, qty_base, unit_cost_paisa, line_value_paisa, tax_rate_bps, tax_paisa)
  SELECT v_business, v_id, o.ord, o.receipt_line_id, rl.variant_id, rl.unit_id, rl.product_name, rl.variant_name, rl.sku, rl.unit_name,
         o.qty_entered, o.qty_base, o.unit_cost_paisa, o.line_value_paisa, o.tax_rate_bps, o.tax_paisa
  FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines')
       WITH ORDINALITY AS o(receipt_line_id, qty_entered, qty_base, unit_cost_paisa, line_value_paisa, tax_rate_bps, tax_paisa, ord)
  JOIN goods_receipt_lines rl ON rl.id = o.receipt_line_id;

  -- The goods leave stock, at the cost they came in at, so the average cost is not disturbed.
  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT v_business, rl.variant_id, v_location, -o.qty_base, rl.cost_per_base_paisa, 'purchase_return', v_id, p_actor
  FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines')
       WITH ORDINALITY AS o(receipt_line_id, qty_entered, qty_base, unit_cost_paisa, line_value_paisa, tax_rate_bps, tax_paisa, ord)
  JOIN goods_receipt_lines rl ON rl.id = o.receipt_line_id
  ORDER BY rl.variant_id, o.ord;

  UPDATE goods_receipt_lines rl SET returned_base = rl.returned_base + l.qty_base
  FROM jsonb_populate_recordset(NULL::return_to_supplier_line_input, p->'lines') l WHERE rl.id = l.receipt_line_id;

  -- What the shop owes falls, and the credit settles the oldest open bills.
  INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
  VALUES (v_business, 'supplier', v_supplier, 'purchase_return', v_id, v_number, 'Return', sums.value + sums.tax, p_actor);
  v_left := sums.value + sums.tax;
  FOR open_bill IN SELECT * FROM supplier_open_bills(v_business, v_supplier) LOOP
    EXIT WHEN v_left = 0;
    v_take := least(v_left, open_bill.outstanding_paisa);
    v_left := v_left - v_take;
    INSERT INTO supplier_payment_allocations (business_id, source_type, source_id, bill_id, amount_paisa) VALUES (v_business, 'purchase_return', v_id, open_bill.bill_id, v_take);
  END LOOP;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('suppliers.pay', 'Pay a supplier (cash comes out of the open shift)'),
  ('purchasing.return', 'Return goods to a supplier (needs the cost permission)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r CROSS JOIN (VALUES ('suppliers.pay'), ('purchasing.return')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_lines ENABLE ROW LEVEL SECURITY;
