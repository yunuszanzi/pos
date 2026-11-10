-- v0.6 slice 5: back-office sales invoices with payment terms, due dates and the buyer's NTN/STRN (FR-SO-03, FR-SO-04), and invoicing
-- a sales order or a quotation, in whole or in part, at the agreed prices (FR-SO-01, FR-QUO-04). API-only like the rest.
--
-- A till sale is rung up on a terminal in an open shift and paid on the spot. A back-office invoice is written at a desk for a named
-- customer on credit: it has no terminal or shift, carries terms (0 = due on receipt, 7, 15, 30 days...) and a due date, and the
-- customer pays it later through the khata (payments received settle the oldest invoices first). It is posted like any invoice:
-- immutable, numbered from the same gap-free series, with a debit on the customer's ledger.
--
-- Three ways to write one:
--   * from a sales order: bills goods that have been DELIVERED (a challan was dispatched) and not billed yet; no stock moves because
--     it already left, and the cost is the cost the challan took it out at;
--   * from a quotation or straight from lines: the goods leave with the invoice, like a till sale (reserved stock is respected).

ALTER TABLE sales_invoices ALTER COLUMN terminal_id DROP NOT NULL;
ALTER TABLE sales_invoices ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE sales_invoices
  ADD COLUMN channel text NOT NULL DEFAULT 'pos' CHECK (channel IN ('pos', 'back_office')),
  ADD COLUMN order_id uuid,
  ADD COLUMN quotation_id uuid,
  ADD COLUMN terms_days integer CHECK (terms_days IS NULL OR terms_days BETWEEN 0 AND 365),
  ADD COLUMN due_date date,
  ADD COLUMN customer_po text NOT NULL DEFAULT '',
  ADD COLUMN note text NOT NULL DEFAULT '',
  -- The buyer as they were on the day, so a printed tax invoice never changes when the customer record does.
  ADD COLUMN buyer_name text NOT NULL DEFAULT '',
  ADD COLUMN buyer_ntn text,
  ADD COLUMN buyer_strn text,
  ADD COLUMN buyer_address text NOT NULL DEFAULT '';
ALTER TABLE sales_invoices
  ADD CONSTRAINT sales_invoices_till_sale_needs_shift_check CHECK (channel = 'back_office' OR (terminal_id IS NOT NULL AND shift_id IS NOT NULL)),
  ADD CONSTRAINT sales_invoices_back_office_check CHECK (channel = 'pos' OR (customer_id IS NOT NULL AND due_date IS NOT NULL AND terms_days IS NOT NULL)),
  ADD FOREIGN KEY (order_id, business_id) REFERENCES sales_orders(id, business_id),
  ADD FOREIGN KEY (quotation_id, business_id) REFERENCES quotations(id, business_id);
CREATE INDEX sales_invoices_order_idx ON sales_invoices (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX sales_invoices_back_office_idx ON sales_invoices (business_id, posted_at DESC) WHERE channel = 'back_office';

ALTER TABLE sales_invoice_lines ADD COLUMN order_line_id uuid;
ALTER TABLE sales_invoice_lines ADD FOREIGN KEY (order_line_id, business_id) REFERENCES sales_order_lines(id, business_id);

CREATE TYPE back_office_line_input AS (
  line_no integer, order_line_id uuid, quotation_line_id uuid, variant_id uuid, unit_id uuid, product_name text, variant_name text, sku text, unit_name text, hs_code text,
  qty_entered numeric, factor_to_base numeric, qty_base numeric, unit_price_paisa bigint, gross_paisa bigint,
  line_discount_paisa bigint, invoice_discount_share_paisa bigint, net_paisa bigint, tax_rate_bps integer, tax_included boolean,
  taxable_paisa bigint, tax_paisa bigint, total_paisa bigint
);

-- Posts a back-office invoice in the caller's transaction. The amounts arrive worked out by the shared pricing code and are checked
-- here. p->>'order_id' set: every line names an order line and takes at most what was delivered and not yet billed. p->>'quotation_id'
-- set: every line names a quotation line (at most what is left unconverted), the quotation must be sent or accepted and not expired,
-- and it moves to converted once nothing is left. Otherwise the lines stand alone. Without an order the goods leave with the invoice.
CREATE FUNCTION post_back_office_invoice(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_customer uuid := (p->>'customer_id')::uuid;
  v_order uuid := nullif(p->>'order_id', '')::uuid;
  v_quotation uuid := nullif(p->>'quotation_id', '')::uuid;
  v_allow_negative boolean := coalesce((p->>'allow_negative_stock')::boolean, false);
  v_total bigint := (p->>'total_paisa')::bigint;
  v_rounding bigint := (p->>'rounding_paisa')::bigint;
  v_credit_approver uuid := nullif(p->>'credit_approved_by', '')::uuid;
  v_terms integer := (p->>'terms_days')::integer;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_due date;
  v_invoice uuid := gen_random_uuid();
  v_count integer;
  v_matched integer;
  v_problem text;
  v_approved_by uuid;
  v_approval_note text;
  v_number text;
  v_sequence integer;
  v_order_customer uuid;
  v_order_location uuid;
  v_order_status text;
  v_q quotations%ROWTYPE;
  cust customers%ROWTYPE;
  need record;
  taken record;
  on_hand_now numeric(14,3);
  reserved_now numeric(14,3);
  sums record;
BEGIN
  SELECT * INTO cust FROM customers WHERE id = v_customer AND business_id = v_business FOR UPDATE;
  IF NOT FOUND OR NOT cust.active THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;
  IF v_terms IS NULL OR v_terms < 0 OR v_terms > 365 THEN RAISE EXCEPTION 'INVALID_TERMS: payment terms are 0 to 365 days'; END IF;
  v_due := coalesce(nullif(p->>'due_date', '')::date, v_today + v_terms);
  IF v_due < v_today THEN RAISE EXCEPTION 'INVALID_TERMS: the due date cannot be in the past'; END IF;
  PERFORM 1 FROM branches WHERE id = v_branch AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_BRANCH: this branch is not available'; END IF;
  PERFORM 1 FROM locations WHERE id = v_location AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_LOCATION: this location is not available'; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: an invoice needs at least one line'; END IF;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.active
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business AND pu.factor_to_base = l.factor_to_base
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * l.factor_to_base;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active product sold in that unit'; END IF;

  SELECT sum(total_paisa) AS total, sum(gross_paisa) AS gross, sum(line_discount_paisa) AS line_discount,
         sum(invoice_discount_share_paisa) AS invoice_discount, sum(tax_paisa) AS tax, sum(taxable_paisa) AS taxable
  INTO sums FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines');
  IF sums.total + v_rounding <> v_total
     OR sums.gross <> (p->>'gross_paisa')::bigint
     OR sums.line_discount <> (p->>'line_discount_paisa')::bigint
     OR sums.invoice_discount <> (p->>'invoice_discount_paisa')::bigint
     OR sums.tax <> (p->>'tax_paisa')::bigint
     OR sums.taxable <> (p->>'taxable_paisa')::bigint THEN
    RAISE EXCEPTION 'INVOICE_TOTAL_MISMATCH: the lines do not add up to the invoice';
  END IF;

  IF v_order IS NOT NULL AND v_quotation IS NOT NULL THEN RAISE EXCEPTION 'INVALID_LINE: an invoice comes from an order or a quotation, not both'; END IF;

  IF v_order IS NOT NULL THEN
    SELECT customer_id, location_id, status INTO v_order_customer, v_order_location, v_order_status FROM sales_orders WHERE id = v_order AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
    IF v_order_customer <> v_customer THEN RAISE EXCEPTION 'INVALID_CUSTOMER: the order is for a different customer'; END IF;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'ORDER_NOT_BILLABLE: a cancelled order cannot be billed'; END IF;
    PERFORM 1 FROM sales_order_lines WHERE order_id = v_order ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_matched
    FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l
    JOIN sales_order_lines ol ON ol.id = l.order_line_id AND ol.order_id = v_order AND ol.variant_id = l.variant_id AND ol.unit_id = l.unit_id;
    IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this order'; END IF;
    FOR taken IN
      SELECT ol.sku, ol.delivered_base AS delivered, ol.invoiced_base AS billed, sum(l.qty_base) AS now_base
      FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l JOIN sales_order_lines ol ON ol.id = l.order_line_id
      GROUP BY ol.id, ol.sku, ol.delivered_base, ol.invoiced_base
    LOOP
      IF taken.billed + taken.now_base > taken.delivered THEN
        RAISE EXCEPTION 'BILLING_EXCEEDS_DELIVERY: % has % delivered and % already billed; % more cannot be billed until it is delivered (counted in the base unit)', taken.sku, taken.delivered, taken.billed, taken.now_base;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') WHERE order_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_LINE: a line names an order line but there is no order';
  END IF;

  IF v_quotation IS NOT NULL THEN
    SELECT * INTO v_q FROM quotations WHERE id = v_quotation AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such quotation'; END IF;
    IF v_q.status NOT IN ('sent', 'accepted') THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % quotation cannot become an invoice', v_q.status; END IF;
    IF v_q.valid_until < v_today THEN RAISE EXCEPTION 'QUOTATION_EXPIRED: this quotation was valid until %; revise it with a new date', v_q.valid_until; END IF;
    IF v_q.customer_id IS NOT NULL AND v_q.customer_id <> v_customer THEN RAISE EXCEPTION 'INVALID_CUSTOMER: the quotation was written for a different customer'; END IF;
    PERFORM 1 FROM quotation_lines WHERE quotation_id = v_quotation ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_matched
    FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l
    JOIN quotation_lines ql ON ql.id = l.quotation_line_id AND ql.quotation_id = v_quotation AND ql.variant_id = l.variant_id AND ql.unit_id = l.unit_id;
    IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this quotation'; END IF;
    FOR taken IN
      SELECT ql.qty_base AS quoted, ql.converted_base AS converted, sum(l.qty_base) AS now_base
      FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l JOIN quotation_lines ql ON ql.id = l.quotation_line_id
      GROUP BY ql.id, ql.qty_base, ql.converted_base
    LOOP
      IF taken.converted + taken.now_base > taken.quoted THEN
        RAISE EXCEPTION 'CONVERSION_EXCEEDS_QUOTATION: % was quoted, % already ordered or billed, % more would be too many', taken.quoted, taken.converted, taken.now_base;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') WHERE quotation_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_LINE: a line names a quotation line but there is no quotation';
  END IF;

  -- Credit: the customer row is locked above, so this sees the balance any other invoice or payment left. Over the limit, or with an
  -- invoice unpaid past their terms, needs someone allowed to approve credit (the API passes who).
  IF cust.balance_paisa + v_total > cust.credit_limit_paisa THEN
    v_problem := format('CREDIT_LIMIT_EXCEEDED: owes %s, this sale adds %s, limit %s', cust.balance_paisa, v_total, cust.credit_limit_paisa);
  ELSIF cust.terms_days > 0 AND EXISTS (
    SELECT 1 FROM customer_open_invoices(v_business, v_customer) o WHERE o.posted_at + make_interval(days => cust.terms_days) < now()
  ) THEN
    v_problem := format('CUSTOMER_OVERDUE: has an invoice unpaid for more than %s days', cust.terms_days);
  END IF;
  IF v_problem IS NOT NULL THEN
    IF v_credit_approver IS NULL THEN RAISE EXCEPTION '%', v_problem; END IF;
    v_approved_by := v_credit_approver;
    v_approval_note := CASE WHEN v_problem LIKE 'CREDIT_LIMIT%' THEN 'Credit limit exceeded' ELSE 'Customer overdue' END;
  END IF;

  -- Goods that leave with the invoice (no order): lock the stock in a fixed order and check what is free (on hand less reserved).
  IF v_order IS NULL THEN
    FOR need IN
      SELECT l.variant_id, sum(l.qty_base) AS qty
      FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') l
      JOIN product_variants v ON v.id = l.variant_id JOIN products pr ON pr.id = v.product_id
      WHERE pr.product_type = 'stocked' GROUP BY l.variant_id ORDER BY l.variant_id
    LOOP
      INSERT INTO stock_balances (business_id, variant_id, location_id) VALUES (v_business, need.variant_id, v_location) ON CONFLICT (variant_id, location_id) DO NOTHING;
      SELECT on_hand, reserved INTO on_hand_now, reserved_now FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location FOR UPDATE;
      IF NOT v_allow_negative AND on_hand_now - reserved_now - need.qty < 0 THEN
        RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % available (% on hand, % reserved), needs %', need.variant_id, on_hand_now - reserved_now, on_hand_now, reserved_now, need.qty;
      END IF;
    END LOOP;
  END IF;

  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'invoice');

  INSERT INTO sales_invoices (
    id, business_id, branch_id, terminal_id, shift_id, location_id, number, sequence_no, customer_id, cashier_id, tax_mode,
    gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa,
    paid_paisa, change_paisa, balance_paisa, approved_by, approval_note, created_by, updated_by,
    channel, order_id, quotation_id, terms_days, due_date, customer_po, note, buyer_name, buyer_ntn, buyer_strn, buyer_address
  ) VALUES (
    v_invoice, v_business, v_branch, NULL, NULL, v_location, v_number, v_sequence, v_customer, p_actor, p->>'tax_mode',
    sums.gross, sums.line_discount, sums.invoice_discount, sums.taxable, sums.tax, v_rounding, v_total,
    0, 0, v_total, v_approved_by, v_approval_note, p_actor, p_actor,
    'back_office', v_order, v_quotation, v_terms, v_due, coalesce(p->>'customer_po', ''), coalesce(p->>'note', ''),
    coalesce(nullif(cust.business_name, ''), cust.name), cust.ntn, cust.strn, cust.address
  );

  INSERT INTO sales_invoice_lines (
    business_id, invoice_id, line_no, order_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
    taxable_paisa, tax_paisa, total_paisa, cost_paisa
  )
  SELECT v_business, v_invoice, row_number() OVER (ORDER BY l.ord), l.order_line_id, l.variant_id, l.unit_id, l.product_name, coalesce(l.variant_name, ''), l.sku, l.unit_name, l.hs_code,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_price_paisa, l.gross_paisa, l.line_discount_paisa, l.invoice_discount_share_paisa, l.net_paisa,
         l.tax_rate_bps, l.tax_included, l.taxable_paisa, l.tax_paisa, l.total_paisa,
         CASE
           -- Goods already delivered were taken out at the cost their challans recorded.
           WHEN l.order_line_id IS NOT NULL THEN coalesce((
             SELECT round(sum(cl.qty_base * cl.cost_paisa) / nullif(sum(cl.qty_base), 0))::bigint FROM delivery_challan_lines cl JOIN delivery_challans c ON c.id = cl.challan_id
             WHERE cl.order_line_id = l.order_line_id AND c.status IN ('dispatched', 'delivered')), v.cost_paisa)
           WHEN pr.product_type = 'stocked' THEN coalesce(b.avg_cost_paisa, v.cost_paisa)
           ELSE v.cost_paisa
         END
  FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') WITH ORDINALITY AS l(line_no, order_line_id, quotation_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code,
    qty_entered, factor_to_base, qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
    taxable_paisa, tax_paisa, total_paisa, ord)
  JOIN product_variants v ON v.id = l.variant_id
  JOIN products pr ON pr.id = v.product_id
  LEFT JOIN stock_balances b ON b.variant_id = l.variant_id AND b.location_id = v_location
  ORDER BY l.ord;

  IF v_order IS NULL THEN
    INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
    SELECT v_business, l.variant_id, v_location, -l.qty_base, coalesce(b.avg_cost_paisa, v.cost_paisa), 'sales_invoice', v_invoice, p_actor
    FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') WITH ORDINALITY AS l(line_no, order_line_id, quotation_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code,
      qty_entered, factor_to_base, qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
      taxable_paisa, tax_paisa, total_paisa, ord)
    JOIN product_variants v ON v.id = l.variant_id
    JOIN products pr ON pr.id = v.product_id AND pr.product_type = 'stocked'
    LEFT JOIN stock_balances b ON b.variant_id = l.variant_id AND b.location_id = v_location
    ORDER BY l.variant_id, l.ord;
  ELSE
    UPDATE sales_order_lines ol SET invoiced_base = ol.invoiced_base + t.qty
    FROM (SELECT order_line_id, sum(qty_base) AS qty FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') GROUP BY order_line_id) t
    WHERE ol.id = t.order_line_id;
  END IF;

  IF v_quotation IS NOT NULL THEN
    UPDATE quotation_lines ql SET converted_base = ql.converted_base + t.qty
    FROM (SELECT quotation_line_id, sum(qty_base) AS qty FROM jsonb_populate_recordset(NULL::back_office_line_input, p->'lines') GROUP BY quotation_line_id) t
    WHERE ql.id = t.quotation_line_id;
    IF NOT EXISTS (SELECT 1 FROM quotation_lines WHERE quotation_id = v_quotation AND converted_base < qty_base) THEN
      UPDATE quotations SET status = 'converted', updated_by = p_actor, updated_at = now() WHERE id = v_quotation;
    END IF;
  END IF;

  -- The customer's account: the whole bill is owed (nothing is paid at a desk invoice); payments received settle it later.
  IF v_total > 0 THEN
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
    VALUES (v_business, 'customer', v_customer, 'sales_invoice', v_invoice, v_number, 'Invoice', v_total, p_actor);
  END IF;
  RETURN v_invoice;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('invoices.view', 'View back-office invoices'),
  ('invoices.create', 'Write back-office invoices on credit, from an order, a quotation or directly')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('invoices.view'), ('invoices.create')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
