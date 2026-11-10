-- v0.6 slice 3: sales orders with stock reservation (FR-SO-01), and converting a quotation into one (FR-QUO-04). API-only like the rest.
--
-- An order promises goods to a named customer at the prices agreed. It moves no stock: stock leaves when the goods are dispatched
-- on a delivery challan (slice 4), and it is billed by invoices (slice 5), in parts if need be. What it does do is RESERVE the
-- stock: stock_balances.reserved holds, for each SKU and location, what open orders still have to deliver, so "available" (on hand
-- less reserved) drops when the order is taken and on hand does not. The reservation is recomputed from the order lines by
-- triggers, so it cannot drift; nothing else writes it.

CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  -- Where the goods are reserved and will be dispatched from.
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  customer_id uuid NOT NULL,
  -- The quotation this order came from (in whole or in part), if any.
  quotation_id uuid,
  -- The customer's own order number, to match their paperwork.
  customer_po text NOT NULL DEFAULT '',
  order_date date NOT NULL DEFAULT current_date,
  delivery_date date,
  delivery_address text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partly_delivered', 'delivered', 'closed', 'cancelled')),
  tax_mode text NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  gross_paisa bigint NOT NULL CHECK (gross_paisa >= 0),
  line_discount_paisa bigint NOT NULL CHECK (line_discount_paisa >= 0),
  invoice_discount_paisa bigint NOT NULL CHECK (invoice_discount_paisa >= 0),
  taxable_paisa bigint NOT NULL CHECK (taxable_paisa >= 0),
  tax_paisa bigint NOT NULL CHECK (tax_paisa >= 0),
  rounding_paisa bigint NOT NULL,
  total_paisa bigint NOT NULL CHECK (total_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  FOREIGN KEY (quotation_id, business_id) REFERENCES quotations(id, business_id),
  CHECK (total_paisa = gross_paisa - line_discount_paisa - invoice_discount_paisa
    + CASE WHEN tax_mode = 'exclusive' THEN tax_paisa ELSE 0 END + rounding_paisa)
);
CREATE INDEX sales_orders_status_idx ON sales_orders (business_id, status, order_date DESC);
CREATE INDEX sales_orders_customer_idx ON sales_orders (business_id, customer_id, order_date DESC);
CREATE INDEX sales_orders_quotation_idx ON sales_orders (quotation_id) WHERE quotation_id IS NOT NULL;

CREATE TABLE sales_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  quotation_line_id uuid,
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
  -- How much has been dispatched (slice 4) and billed (slice 5), in base units. The only columns that change after the order is taken.
  delivered_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (delivered_base >= 0 AND delivered_base <= qty_base),
  invoiced_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (invoiced_base >= 0 AND invoiced_base <= qty_base),
  UNIQUE (id, business_id),
  UNIQUE (order_id, line_no),
  FOREIGN KEY (order_id, business_id) REFERENCES sales_orders(id, business_id),
  FOREIGN KEY (quotation_line_id, business_id) REFERENCES quotation_lines(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  CHECK (qty_base = qty_entered * factor_to_base),
  CHECK (net_paisa = gross_paisa - line_discount_paisa - invoice_discount_share_paisa),
  CHECK (total_paisa = net_paisa + CASE WHEN tax_included THEN 0 ELSE tax_paisa END),
  CHECK (taxable_paisa = net_paisa - CASE WHEN tax_included THEN tax_paisa ELSE 0 END)
);
CREATE INDEX sales_order_lines_variant_idx ON sales_order_lines (business_id, variant_id);

-- What was agreed is fixed: once taken, an order's prices, quantities and customer never change. Only its status moves, and its
-- lines gain delivered and invoiced quantity. A correction is a cancelled order and a new one.
CREATE FUNCTION protect_sales_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a sales order cannot be deleted; cancel it instead'; END IF;
  IF TG_TABLE_NAME = 'sales_orders' THEN
    IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by') THEN RETURN NEW; END IF;
  ELSIF (to_jsonb(NEW) - 'delivered_base' - 'invoiced_base') = (to_jsonb(OLD) - 'delivered_base' - 'invoiced_base') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a sales order cannot be changed once taken; cancel it and take a new one';
END;
$$;
CREATE TRIGGER sales_orders_protect BEFORE UPDATE OR DELETE ON sales_orders FOR EACH ROW EXECUTE FUNCTION protect_sales_order();
CREATE TRIGGER sales_order_lines_protect BEFORE UPDATE OR DELETE ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION protect_sales_order();

-- ---------------------------------------------------------------- reservation

-- Sets stock_balances.reserved for one SKU at one location to what open orders still have to deliver (stocked SKUs only).
CREATE FUNCTION refresh_reserved_stock(p_business uuid, p_variant uuid, p_location uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_reserved numeric(14,3);
BEGIN
  SELECT coalesce(sum(l.qty_base - l.delivered_base), 0) INTO v_reserved
  FROM sales_order_lines l
  JOIN sales_orders o ON o.id = l.order_id AND o.business_id = l.business_id
  WHERE o.business_id = p_business AND o.location_id = p_location AND l.variant_id = p_variant AND o.status IN ('open', 'partly_delivered');
  INSERT INTO stock_balances (business_id, variant_id, location_id, reserved) VALUES (p_business, p_variant, p_location, v_reserved)
  ON CONFLICT (variant_id, location_id) DO UPDATE SET reserved = EXCLUDED.reserved, updated_at = now();
END;
$$;

CREATE FUNCTION sales_order_lines_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_order sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM sales_orders WHERE id = NEW.order_id;
  IF EXISTS (SELECT 1 FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = NEW.variant_id AND p.product_type = 'stocked') THEN
    PERFORM refresh_reserved_stock(v_order.business_id, NEW.variant_id, v_order.location_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_order_lines_reserve AFTER INSERT OR UPDATE ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION sales_order_lines_reserve();

-- An order leaving the open states (cancelled, closed, delivered) lets its reservation go.
CREATE FUNCTION sales_orders_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    FOR l IN
      SELECT DISTINCT sl.variant_id FROM sales_order_lines sl JOIN product_variants v ON v.id = sl.variant_id JOIN products p ON p.id = v.product_id
      WHERE sl.order_id = NEW.id AND p.product_type = 'stocked' ORDER BY sl.variant_id
    LOOP
      PERFORM refresh_reserved_stock(NEW.business_id, l.variant_id, NEW.location_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_orders_release AFTER UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION sales_orders_release();

-- ---------------------------------------------------------------- taking an order

-- Takes an order in the caller's transaction, from lines the API has priced (the shared pricing code; this function checks the sums).
-- If p->>'quotation_id' is set the order is a conversion: every line names its quotation line, takes at most what is still unconverted
-- of it, the quotation moves to converted once nothing is left, and it must be sent or accepted and not expired. Stock is reserved
-- unless the business allows negative stock; an order for more than is available is refused (STOCK_INSUFFICIENT) and nothing is saved.
CREATE TYPE sales_order_line_input AS (
  line_no integer, quotation_line_id uuid, variant_id uuid, unit_id uuid, product_name text, variant_name text, sku text, unit_name text, hs_code text,
  qty_entered numeric, factor_to_base numeric, qty_base numeric, unit_price_paisa bigint, gross_paisa bigint,
  line_discount_paisa bigint, invoice_discount_share_paisa bigint, net_paisa bigint, tax_rate_bps integer, tax_included boolean,
  taxable_paisa bigint, tax_paisa bigint, total_paisa bigint
);

CREATE FUNCTION take_sales_order(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_customer uuid := (p->>'customer_id')::uuid;
  v_quotation uuid := nullif(p->>'quotation_id', '')::uuid;
  v_allow_negative boolean := coalesce((p->>'allow_negative_stock')::boolean, false);
  v_branch uuid;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_count integer;
  v_matched integer;
  v_q quotations%ROWTYPE;
  need record;
  taken record;
  v_on_hand numeric(14,3);
  v_reserved numeric(14,3);
  sums record;
BEGIN
  SELECT branch_id INTO v_branch FROM locations WHERE id = v_location AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_LOCATION: this location is not available'; END IF;
  PERFORM 1 FROM customers WHERE id = v_customer AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one item'; END IF;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.active
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business AND pu.factor_to_base = l.factor_to_base
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * l.factor_to_base;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active product sold in that unit'; END IF;

  SELECT sum(total_paisa) AS total, sum(gross_paisa) AS gross, sum(line_discount_paisa) AS line_discount,
         sum(invoice_discount_share_paisa) AS invoice_discount, sum(tax_paisa) AS tax, sum(taxable_paisa) AS taxable
  INTO sums FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines');
  IF sums.total + (p->>'rounding_paisa')::bigint <> (p->>'total_paisa')::bigint
     OR sums.gross <> (p->>'gross_paisa')::bigint
     OR sums.line_discount <> (p->>'line_discount_paisa')::bigint
     OR sums.invoice_discount <> (p->>'invoice_discount_paisa')::bigint
     OR sums.tax <> (p->>'tax_paisa')::bigint
     OR sums.taxable <> (p->>'taxable_paisa')::bigint THEN
    RAISE EXCEPTION 'ORDER_TOTAL_MISMATCH: the lines do not add up to the order';
  END IF;

  IF v_quotation IS NOT NULL THEN
    SELECT * INTO v_q FROM quotations WHERE id = v_quotation AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such quotation'; END IF;
    IF v_q.status NOT IN ('sent', 'accepted') THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % quotation cannot become an order', v_q.status; END IF;
    IF v_q.valid_until < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
      RAISE EXCEPTION 'QUOTATION_EXPIRED: this quotation was valid until %; revise it with a new date', v_q.valid_until;
    END IF;
    PERFORM 1 FROM quotation_lines WHERE quotation_id = v_quotation ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_matched
    FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') l
    JOIN quotation_lines ql ON ql.id = l.quotation_line_id AND ql.quotation_id = v_quotation AND ql.variant_id = l.variant_id AND ql.unit_id = l.unit_id;
    IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this quotation'; END IF;
    FOR taken IN
      SELECT ql.qty_base AS quoted, ql.converted_base AS converted, sum(l.qty_base) AS now_base
      FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') l JOIN quotation_lines ql ON ql.id = l.quotation_line_id
      GROUP BY ql.id, ql.qty_base, ql.converted_base
    LOOP
      IF taken.converted + taken.now_base > taken.quoted THEN
        RAISE EXCEPTION 'CONVERSION_EXCEEDS_QUOTATION: % was quoted, % already ordered, % more would be too many', taken.quoted, taken.converted, taken.now_base;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') WHERE quotation_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_LINE: a line names a quotation line but there is no quotation';
  END IF;

  -- Reserve: lock the stock row of every stocked SKU in a fixed order (so two orders can never deadlock) and check what is free.
  FOR need IN
    SELECT l.variant_id, sum(l.qty_base) AS qty
    FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') l
    JOIN product_variants v ON v.id = l.variant_id JOIN products pr ON pr.id = v.product_id
    WHERE pr.product_type = 'stocked' GROUP BY l.variant_id ORDER BY l.variant_id
  LOOP
    INSERT INTO stock_balances (business_id, variant_id, location_id) VALUES (v_business, need.variant_id, v_location) ON CONFLICT (variant_id, location_id) DO NOTHING;
    SELECT on_hand, reserved INTO v_on_hand, v_reserved FROM stock_balances WHERE variant_id = need.variant_id AND location_id = v_location FOR UPDATE;
    IF NOT v_allow_negative AND v_on_hand - v_reserved - need.qty < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % available (% on hand, % reserved), needs %', need.variant_id, v_on_hand - v_reserved, v_on_hand, v_reserved, need.qty;
    END IF;
  END LOOP;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'sales_order', 'SO-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'sales_order');

  INSERT INTO sales_orders (id, business_id, branch_id, location_id, number, sequence_no, customer_id, quotation_id, customer_po, order_date, delivery_date, delivery_address, note,
    tax_mode, gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa, created_by, updated_by)
  VALUES (v_id, v_business, v_branch, v_location, v_number, v_sequence, v_customer, v_quotation, coalesce(p->>'customer_po', ''), (now() AT TIME ZONE 'Asia/Karachi')::date,
    nullif(p->>'delivery_date', '')::date, coalesce(p->>'delivery_address', ''), coalesce(p->>'note', ''), p->>'tax_mode',
    sums.gross, sums.line_discount, sums.invoice_discount, sums.taxable, sums.tax, (p->>'rounding_paisa')::bigint, (p->>'total_paisa')::bigint, p_actor, p_actor);

  INSERT INTO sales_order_lines (business_id, order_id, line_no, quotation_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included, taxable_paisa, tax_paisa, total_paisa)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), l.quotation_line_id, l.variant_id, l.unit_id, l.product_name, coalesce(l.variant_name, ''), l.sku, l.unit_name, l.hs_code,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_price_paisa, l.gross_paisa, l.line_discount_paisa, l.invoice_discount_share_paisa, l.net_paisa,
         l.tax_rate_bps, l.tax_included, l.taxable_paisa, l.tax_paisa, l.total_paisa
  FROM jsonb_populate_recordset(NULL::sales_order_line_input, p->'lines') WITH ORDINALITY AS l(line_no, quotation_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code,
    qty_entered, factor_to_base, qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
    taxable_paisa, tax_paisa, total_paisa, ord);

  IF v_quotation IS NOT NULL THEN
    UPDATE quotation_lines ql SET converted_base = ql.converted_base + t.now_base
    FROM (SELECT quotation_line_id, sum(qty_base) AS now_base FROM sales_order_lines WHERE order_id = v_id GROUP BY quotation_line_id) t
    WHERE ql.id = t.quotation_line_id;
    IF NOT EXISTS (SELECT 1 FROM quotation_lines WHERE quotation_id = v_quotation AND converted_base < qty_base) THEN
      UPDATE quotations SET status = 'converted', updated_by = p_actor, updated_at = now() WHERE id = v_quotation;
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- open -> cancelled (nothing dispatched yet); partly delivered or delivered -> closed (what is left is released).
CREATE FUNCTION set_sales_order_status(p_business uuid, p_order uuid, p_status text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM sales_orders WHERE id = p_order AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
  IF NOT ((v_status = 'open' AND p_status = 'cancelled') OR (v_status IN ('partly_delivered', 'delivered') AND p_status = 'closed')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % order cannot become %', v_status, p_status;
  END IF;
  UPDATE sales_orders SET status = p_status, updated_by = p_actor, updated_at = now() WHERE id = p_order;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('sales_orders.view', 'View sales orders'),
  ('sales_orders.manage', 'Take, cancel and close sales orders; convert a quotation into one')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('sales_orders.view'), ('sales_orders.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY;
