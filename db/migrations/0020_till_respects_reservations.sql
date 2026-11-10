-- v0.6 slice 6: the till respects stock reserved for sales orders (FR-SO-01: an order "reserves stock").
--
-- Until now an open order lowered "available" but a cashier could still sell the same pieces. This is post_sales_invoice exactly as
-- migration 0007 left it, with one change: the stock check counts on hand LESS reserved. A business that allows negative stock is
-- not stopped, as before. The error names the numbers when stock is held for orders.

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
  reserved_now numeric(14,3);
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
    SELECT on_hand, reserved INTO on_hand_now, reserved_now FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location FOR UPDATE;
    -- What open sales orders hold is not for sale at the till: a sale may take only on hand less reserved.
    IF NOT v_allow_negative AND on_hand_now - reserved_now - need.qty < 0 THEN
      IF reserved_now > 0 THEN
        RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % available (% on hand, % reserved), needs %', need.variant_id, on_hand_now - reserved_now, on_hand_now, reserved_now, need.qty;
      END IF;
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
