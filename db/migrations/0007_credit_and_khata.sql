-- v0.4 slice 2: credit sales, the customer ledger (khata) and payments received (technical-plan 3.1, 5.1; FR-SAL-08, FR-CUS-02..06).
-- API-only like the rest: no grants to anon/authenticated (see 0001).

-- ---------------------------------------------------------------- the ledger

-- Money owed between the business and a party. A customer's balance is the sum of debit minus credit: positive means the
-- customer owes us (khata), negative means we hold store credit for them. Append-only; a correction is a new entry.
CREATE TABLE party_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Posting order. entry_at is the transaction start time and ties within one transaction.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_type text NOT NULL CHECK (party_type IN ('customer', 'supplier')),
  party_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('sales_invoice', 'customer_payment', 'sales_return', 'opening_balance', 'adjustment')),
  doc_id uuid NOT NULL,
  doc_number text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  debit_paisa bigint NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  entry_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- An entry moves money one way.
  CHECK ((debit_paisa > 0) <> (credit_paisa > 0))
);
CREATE INDEX party_ledger_party_idx ON party_ledger (business_id, party_type, party_id, seq);
CREATE INDEX party_ledger_doc_idx ON party_ledger (doc_id);

CREATE FUNCTION guard_party_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'party_ledger is append-only; record a correcting entry instead';
END;
$$;
CREATE TRIGGER party_ledger_append_only BEFORE UPDATE OR DELETE ON party_ledger FOR EACH ROW EXECUTE FUNCTION guard_party_ledger();

-- The cached balance. It is only ever written by the ledger trigger below, and can be rebuilt from the ledger at any time.
ALTER TABLE customers ADD COLUMN balance_paisa bigint NOT NULL DEFAULT 0;

CREATE FUNCTION apply_party_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_type = 'customer' THEN
    PERFORM set_config('pos.ledger_write', 'on', true);
    UPDATE customers SET balance_paisa = balance_paisa + NEW.debit_paisa - NEW.credit_paisa
    WHERE id = NEW.party_id AND business_id = NEW.business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: customer % does not exist in this business', NEW.party_id; END IF;
    PERFORM set_config('pos.ledger_write', 'off', true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER party_ledger_apply AFTER INSERT ON party_ledger FOR EACH ROW EXECUTE FUNCTION apply_party_ledger_entry();

CREATE FUNCTION guard_customer_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_paisa <> OLD.balance_paisa AND coalesce(current_setting('pos.ledger_write', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'a customer balance is changed only by the ledger';
  END IF;
  RETURN NEW;
END;
$$;
-- "aa_" sorts before the version stamp, so a refused change never takes a version number.
CREATE TRIGGER aa_customers_guard_balance BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION guard_customer_balance();

-- ---------------------------------------------------------------- payments received

CREATE TABLE customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- Cash goes into a shift's drawer, so a cash receipt always belongs to an open shift.
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
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id),
  FOREIGN KEY (method_id, business_id) REFERENCES payment_methods(id, business_id),
  CHECK (tender_kind <> 'cash' OR shift_id IS NOT NULL)
);
CREATE INDEX customer_payments_customer_idx ON customer_payments (business_id, customer_id, posted_at DESC);
CREATE INDEX customer_payments_shift_idx ON customer_payments (shift_id) WHERE shift_id IS NOT NULL;

-- Which invoice a payment (or, from slice 3, a credit note) settled. Whatever is not allocated stays on the customer's account.
CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('customer_payment', 'sales_return')),
  source_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, business_id) REFERENCES sales_invoices(id, business_id)
);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (invoice_id);
CREATE INDEX payment_allocations_source_idx ON payment_allocations (source_id);

CREATE TRIGGER customer_payments_protect BEFORE UPDATE OR DELETE ON customer_payments FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER payment_allocations_protect BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION protect_posted_document();

-- A customer's invoices that still have something owing, oldest first. What is owing is what was left unpaid at the till
-- minus everything allocated to the invoice since.
CREATE FUNCTION customer_open_invoices(p_business uuid, p_customer uuid)
RETURNS TABLE (invoice_id uuid, number text, posted_at timestamptz, total_paisa bigint, outstanding_paisa bigint)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.number, i.posted_at, i.total_paisa, i.balance_paisa - coalesce(a.allocated, 0)
  FROM sales_invoices i
  LEFT JOIN LATERAL (SELECT sum(x.amount_paisa) AS allocated FROM payment_allocations x WHERE x.invoice_id = i.id) a ON true
  WHERE i.business_id = p_business AND i.customer_id = p_customer AND i.balance_paisa - coalesce(a.allocated, 0) > 0
  ORDER BY i.posted_at, i.id;
$$;

CREATE TYPE customer_allocation_input AS (invoice_id uuid, amount_paisa bigint);

-- Receives money from a customer in the caller's transaction. The customer row is locked first, so two payments or a payment
-- and a credit sale for the same customer queue up instead of both reading the same balance. `allocate` is 'oldest' (settle
-- the oldest invoices first) or 'manual' (the listed allocations); money not allocated stays on the account as credit.
CREATE FUNCTION post_customer_payment(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_customer uuid := (p->>'customer_id')::uuid;
  v_shift uuid := nullif(p->>'shift_id', '')::uuid;
  v_terminal uuid := nullif(p->>'terminal_id', '')::uuid;
  v_amount bigint := (p->>'amount_paisa')::bigint;
  v_manual boolean := coalesce(p->>'allocate', 'oldest') = 'manual';
  v_id uuid := gen_random_uuid();
  v_active boolean;
  v_status text;
  v_number text;
  v_sequence integer;
  v_left bigint;
  v_take bigint;
  method record;
  open_invoice record;
  wanted record;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'INVALID_PAYMENT: the amount must be more than zero'; END IF;

  SELECT active INTO v_active FROM customers WHERE id = v_customer AND business_id = v_business FOR UPDATE;
  IF NOT FOUND OR NOT v_active THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;

  SELECT id, code, name, kind INTO method FROM payment_methods WHERE id = (p->>'method_id')::uuid AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT: that payment method is not available'; END IF;

  IF method.kind = 'cash' AND v_shift IS NULL THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN: open a shift on this terminal to take cash'; END IF;
  IF v_shift IS NOT NULL THEN
    SELECT status INTO v_status FROM shifts
    WHERE id = v_shift AND business_id = v_business AND (v_terminal IS NULL OR terminal_id = v_terminal) FOR SHARE;
    IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN'; END IF;
  END IF;

  -- Receipt numbers are gap-free like invoices. A branch made after the first receipt gets its series here.
  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'receipt', 'RCT-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'receipt');

  INSERT INTO customer_payments (id, business_id, branch_id, customer_id, number, sequence_no, shift_id, method_id, method_code, method_name,
                                 tender_kind, amount_paisa, reference, note, created_by)
  VALUES (v_id, v_business, v_branch, v_customer, v_number, v_sequence, v_shift, method.id, method.code, method.name,
          CASE WHEN method.kind = 'cash' THEN 'cash' ELSE 'other' END, v_amount, coalesce(p->>'reference', ''), coalesce(p->>'note', ''), p_actor);

  v_left := v_amount;
  IF v_manual THEN
    FOR wanted IN SELECT invoice_id, sum(amount_paisa) AS amount FROM jsonb_populate_recordset(NULL::customer_allocation_input, p->'allocations') GROUP BY invoice_id ORDER BY invoice_id LOOP
      IF wanted.amount <= 0 THEN RAISE EXCEPTION 'INVALID_ALLOCATION: each allocation must be more than zero'; END IF;
      SELECT * INTO open_invoice FROM customer_open_invoices(v_business, v_customer) o WHERE o.invoice_id = wanted.invoice_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ALLOCATION: an invoice is not open for this customer'; END IF;
      IF wanted.amount > open_invoice.outstanding_paisa THEN
        RAISE EXCEPTION 'INVALID_ALLOCATION: % has only % owing', open_invoice.number, open_invoice.outstanding_paisa;
      END IF;
      v_left := v_left - wanted.amount;
      IF v_left < 0 THEN RAISE EXCEPTION 'INVALID_ALLOCATION: the allocations are more than the payment'; END IF;
      INSERT INTO payment_allocations (business_id, source_type, source_id, invoice_id, amount_paisa)
      VALUES (v_business, 'customer_payment', v_id, wanted.invoice_id, wanted.amount);
    END LOOP;
  ELSE
    FOR open_invoice IN SELECT * FROM customer_open_invoices(v_business, v_customer) LOOP
      EXIT WHEN v_left = 0;
      v_take := least(v_left, open_invoice.outstanding_paisa);
      v_left := v_left - v_take;
      INSERT INTO payment_allocations (business_id, source_type, source_id, invoice_id, amount_paisa)
      VALUES (v_business, 'customer_payment', v_id, open_invoice.invoice_id, v_take);
    END LOOP;
  END IF;

  INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, credit_paisa, created_by)
  VALUES (v_business, 'customer', v_customer, 'customer_payment', v_id, v_number, method.name, v_amount, p_actor);

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- posting a sale, now with credit

-- The same function as 0005 with three additions: a named customer may leave part of the bill unpaid (credit), the customer
-- row is locked and the credit limit and overdue invoices are checked against the balance it holds, and the ledger gets the
-- invoice and what was paid. A manager's approval (`credit_approved_by`, already verified by the API) lets a sale through
-- the limit or the overdue rule, and is recorded on the invoice.
CREATE OR REPLACE FUNCTION post_sales_invoice(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
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
  v_credit_approver uuid := nullif(p->>'credit_approved_by', '')::uuid;
  v_approved_by uuid := nullif(p->>'approved_by', '')::uuid;
  v_approval_note text := nullif(p->>'approval_note', '');
  v_invoice uuid := gen_random_uuid();
  v_status text;
  v_line_count integer;
  v_matched integer;
  v_paid bigint;
  v_change bigint;
  v_debt bigint;
  v_problem text;
  v_number text;
  v_sequence integer;
  need record;
  cust record;
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

  -- Credit: lock the customer before anything else that can wait, so two tills selling on credit to the same customer take
  -- turns and the second one sees the balance the first left.
  IF v_customer IS NOT NULL THEN
    SELECT active, balance_paisa, credit_limit_paisa, terms_days INTO cust FROM customers WHERE id = v_customer AND business_id = v_business FOR UPDATE;
    IF NOT FOUND OR NOT cust.active THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;
    v_debt := v_total - v_paid;
    IF v_debt > 0 THEN
      IF cust.balance_paisa + v_debt > cust.credit_limit_paisa THEN
        v_problem := format('CREDIT_LIMIT_EXCEEDED: owes %s, this sale adds %s, limit %s', cust.balance_paisa, v_debt, cust.credit_limit_paisa);
      ELSIF cust.terms_days > 0 AND EXISTS (
        SELECT 1 FROM customer_open_invoices(v_business, v_customer) o WHERE o.posted_at + make_interval(days => cust.terms_days) < now()
      ) THEN
        v_problem := format('CUSTOMER_OVERDUE: has an invoice unpaid for more than %s days', cust.terms_days);
      END IF;
      IF v_problem IS NOT NULL THEN
        IF v_credit_approver IS NULL THEN RAISE EXCEPTION '%', v_problem; END IF;
        v_approved_by := coalesce(v_approved_by, v_credit_approver);
        v_approval_note := concat_ws('; ', v_approval_note, CASE WHEN v_problem LIKE 'CREDIT_LIMIT%' THEN 'Credit limit exceeded' ELSE 'Customer overdue' END);
      END IF;
    END IF;
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
    v_paid, v_change, v_total - v_paid, v_approved_by, v_approval_note, p_actor, p_actor
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

  -- The customer's account: the whole bill, then what they paid at the counter. A statement reads invoices minus payments.
  IF v_customer IS NOT NULL AND v_total > 0 THEN
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
    VALUES (v_business, 'customer', v_customer, 'sales_invoice', v_invoice, v_number, 'Invoice', v_total, p_actor);
    IF v_paid > 0 THEN
      INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, credit_paisa, created_by)
      VALUES (v_business, 'customer', v_customer, 'sales_invoice', v_invoice, v_number, 'Paid at sale', v_paid, p_actor);
    END IF;
  END IF;

  RETURN v_invoice;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('customers.ledger', 'View a customer''s khata: balance, ledger and open invoices'),
  ('customers.receive_payment', 'Receive a payment from a customer'),
  ('sales.credit_override', 'Approve a credit sale above the limit or for an overdue customer (manager PIN)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('customers.ledger'), ('customers.receive_payment'), ('sales.credit_override')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('customers.ledger'), ('customers.receive_payment')) AS k(key)
WHERE r.is_system AND r.name = 'Cashier'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE party_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
