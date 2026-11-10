-- v0.5 slice 2: purchase orders and goods receipts (technical-plan 3.1; FR-PUR-02, FR-PUR-03). API-only like the rest.
--
-- An order is a working document: it can be edited while it is a draft. A goods receipt is a posted document: immutable, it
-- adds stock through the stock ledger (which keeps the weighted average cost) and moves the order on. The payable arises
-- later, with the supplier's bill (slice 3), so a receipt can be posted before the bill arrives.

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  -- Where the goods are to be received.
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partly_received', 'received', 'closed', 'cancelled')),
  order_date date NOT NULL DEFAULT current_date,
  expected_date date,
  note text NOT NULL DEFAULT '',
  total_paisa bigint NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (business_id, supplier_id, order_date DESC);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (business_id, status, order_date DESC);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  -- What the line said when it was written, so the order reads the same if the product is renamed.
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  -- The price of one unit as bought (one carton), in paisa.
  unit_cost_paisa bigint NOT NULL CHECK (unit_cost_paisa >= 0),
  line_total_paisa bigint NOT NULL CHECK (line_total_paisa >= 0),
  received_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_base >= 0 AND received_base <= qty_base),
  UNIQUE (id, business_id),
  UNIQUE (order_id, line_no),
  FOREIGN KEY (order_id, business_id) REFERENCES purchase_orders(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id)
);

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  -- Null for goods that came with no order.
  order_id uuid,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- The supplier's delivery challan or invoice number, for matching their paperwork.
  supplier_ref text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  total_paisa bigint NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  FOREIGN KEY (order_id, business_id) REFERENCES purchase_orders(id, business_id)
);
CREATE INDEX goods_receipts_supplier_idx ON goods_receipts (business_id, supplier_id, received_at DESC);
CREATE INDEX goods_receipts_order_idx ON goods_receipts (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  order_line_id uuid,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  -- The price of one unit as bought, and of one base unit (what the stock ledger records), in whole paisa.
  unit_cost_paisa bigint NOT NULL CHECK (unit_cost_paisa >= 0),
  cost_per_base_paisa bigint NOT NULL CHECK (cost_per_base_paisa >= 0),
  line_value_paisa bigint NOT NULL CHECK (line_value_paisa >= 0),
  -- How much of this line a supplier's bill has taken up (slice 3). The only column that changes after posting.
  billed_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (billed_base >= 0 AND billed_base <= qty_base),
  UNIQUE (id, business_id),
  UNIQUE (receipt_id, line_no),
  FOREIGN KEY (receipt_id, business_id) REFERENCES goods_receipts(id, business_id),
  FOREIGN KEY (order_line_id, business_id) REFERENCES purchase_order_lines(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id)
);

-- Posted receipts never change. The one exception is billed_base on a line, which a bill moves.
CREATE FUNCTION protect_goods_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'goods_receipt_lines' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'billed_base') = (to_jsonb(OLD) - 'billed_base') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a purchase return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;
CREATE TRIGGER goods_receipts_protect BEFORE UPDATE OR DELETE ON goods_receipts FOR EACH ROW EXECUTE FUNCTION protect_goods_receipt();
CREATE TRIGGER goods_receipt_lines_protect BEFORE UPDATE OR DELETE ON goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION protect_goods_receipt();

-- ---------------------------------------------------------------- orders

CREATE TYPE purchase_line_input AS (
  line_id uuid, order_line_id uuid, variant_id uuid, unit_id uuid, product_name text, variant_name text, sku text, unit_name text,
  qty_entered numeric, factor_to_base numeric, qty_base numeric, unit_cost_paisa bigint
);

-- Checks a purchase line against the catalogue: an active, stocked SKU, bought in a unit it really has with the factor it has now.
CREATE FUNCTION check_purchase_lines(p_business uuid, p_lines jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
  v_matched integer;
BEGIN
  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::purchase_line_input, p_lines);
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one item'; END IF;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::purchase_line_input, p_lines) l
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = p_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.active AND pr.product_type = 'stocked'
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = p_business AND pu.factor_to_base = l.factor_to_base
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * l.factor_to_base AND l.unit_cost_paisa >= 0;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active stocked product bought in a unit it has'; END IF;
END;
$$;

-- Creates a draft order, or replaces the lines and details of an existing draft (p->>'id'). The number is taken when it is created.
CREATE FUNCTION save_purchase_order(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_branch uuid;
  v_status text;
  v_number text;
  v_sequence integer;
  v_total bigint;
BEGIN
  PERFORM 1 FROM suppliers WHERE id = v_supplier AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: this supplier is not available'; END IF;
  SELECT branch_id INTO v_branch FROM locations WHERE id = v_location AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_LOCATION: this location is not available'; END IF;
  PERFORM check_purchase_lines(v_business, p->'lines');

  IF v_id IS NULL THEN
    INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
    SELECT v_business, b.id, 'purchase_order', 'PO-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
    ON CONFLICT DO NOTHING;
    SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'purchase_order');
    v_id := gen_random_uuid();
    INSERT INTO purchase_orders (id, business_id, branch_id, supplier_id, location_id, number, sequence_no, order_date, expected_date, note, created_by, updated_by)
    VALUES (v_id, v_business, v_branch, v_supplier, v_location, v_number, v_sequence, coalesce(nullif(p->>'order_date', '')::date, current_date),
            nullif(p->>'expected_date', '')::date, coalesce(p->>'note', ''), p_actor, p_actor);
  ELSE
    SELECT status INTO v_status FROM purchase_orders WHERE id = v_id AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'ORDER_NOT_EDITABLE: only a draft order can be changed'; END IF;
    DELETE FROM purchase_order_lines WHERE order_id = v_id;
    UPDATE purchase_orders SET supplier_id = v_supplier, location_id = v_location, branch_id = v_branch, order_date = coalesce(nullif(p->>'order_date', '')::date, order_date),
      expected_date = nullif(p->>'expected_date', '')::date, note = coalesce(p->>'note', ''), updated_by = p_actor, updated_at = now()
    WHERE id = v_id;
  END IF;

  INSERT INTO purchase_order_lines (business_id, order_id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name,
                                    qty_entered, factor_to_base, qty_base, unit_cost_paisa, line_total_paisa)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), l.variant_id, l.unit_id, l.product_name, coalesce(l.variant_name, ''), l.sku, l.unit_name,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_cost_paisa, round(l.qty_entered * l.unit_cost_paisa)::bigint
  FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines') WITH ORDINALITY AS l(line_id, order_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, qty_entered, factor_to_base, qty_base, unit_cost_paisa, ord);

  SELECT coalesce(sum(line_total_paisa), 0) INTO v_total FROM purchase_order_lines WHERE order_id = v_id;
  UPDATE purchase_orders SET total_paisa = v_total WHERE id = v_id;
  RETURN v_id;
END;
$$;

-- draft -> sent; draft or sent (nothing received) -> cancelled; partly received or received -> closed.
CREATE FUNCTION set_purchase_order_status(p_business uuid, p_order uuid, p_status text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM purchase_orders WHERE id = p_order AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
  IF NOT ((v_status = 'draft' AND p_status IN ('sent', 'cancelled'))
       OR (v_status = 'sent' AND p_status = 'cancelled')
       OR (v_status IN ('partly_received', 'received') AND p_status = 'closed')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % order cannot become %', v_status, p_status;
  END IF;
  UPDATE purchase_orders SET status = p_status, updated_by = p_actor, updated_at = now() WHERE id = p_order;
END;
$$;

-- ---------------------------------------------------------------- receiving goods

-- Posts a goods receipt in the caller's transaction. Against an order (sent or partly received) every line names an order line and
-- may not take more than is still to come (RECEIPT_EXCEEDS_ORDER); without an order the lines stand alone. Stock comes in at the
-- cost of one base unit through the stock ledger, whose trigger keeps the weighted average cost. The order moves to partly
-- received, or to received when every line is complete. The number is taken last so the series row is held briefly.
CREATE FUNCTION post_goods_receipt(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_order uuid := nullif(p->>'order_id', '')::uuid;
  v_branch uuid;
  v_status text;
  v_order_supplier uuid;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_matched integer;
  v_count integer;
  v_total bigint;
  taken record;
BEGIN
  PERFORM 1 FROM suppliers WHERE id = v_supplier AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: this supplier is not available'; END IF;
  SELECT branch_id INTO v_branch FROM locations WHERE id = v_location AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_LOCATION: this location is not available'; END IF;
  PERFORM check_purchase_lines(v_business, p->'lines');

  IF v_order IS NOT NULL THEN
    SELECT status, supplier_id INTO v_status, v_order_supplier FROM purchase_orders WHERE id = v_order AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
    IF v_status NOT IN ('sent', 'partly_received') THEN RAISE EXCEPTION 'ORDER_NOT_RECEIVABLE: a % order cannot take a receipt; send it first', v_status; END IF;
    IF v_order_supplier <> v_supplier THEN RAISE EXCEPTION 'INVALID_SUPPLIER: the order is with a different supplier'; END IF;
    SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines');
    -- Every line is an order line of this order, for the same SKU. The order lines are locked in a fixed order.
    PERFORM 1 FROM purchase_order_lines WHERE order_id = v_order ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_matched
    FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines') l
    JOIN purchase_order_lines ol ON ol.id = l.order_line_id AND ol.order_id = v_order AND ol.variant_id = l.variant_id;
    IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this order'; END IF;
    FOR taken IN
      SELECT ol.id, ol.qty_base AS ordered, ol.received_base AS received, sum(l.qty_base) AS now_base
      FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines') l JOIN purchase_order_lines ol ON ol.id = l.order_line_id
      GROUP BY ol.id, ol.qty_base, ol.received_base
    LOOP
      IF taken.received + taken.now_base > taken.ordered THEN
        RAISE EXCEPTION 'RECEIPT_EXCEEDS_ORDER: % was ordered, % already received, % more would be too many', taken.ordered, taken.received, taken.now_base;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines') WHERE order_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_LINE: a line names an order line but there is no order';
  END IF;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'goods_receipt', 'GRN-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'goods_receipt');

  SELECT coalesce(sum(round(qty_entered * unit_cost_paisa)), 0)::bigint INTO v_total FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines');
  INSERT INTO goods_receipts (id, business_id, branch_id, location_id, supplier_id, order_id, number, sequence_no, supplier_ref, note, total_paisa, created_by)
  VALUES (v_id, v_business, v_branch, v_location, v_supplier, v_order, v_number, v_sequence, coalesce(p->>'supplier_ref', ''), coalesce(p->>'note', ''), v_total, p_actor);

  INSERT INTO goods_receipt_lines (business_id, receipt_id, line_no, order_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name,
                                   qty_entered, factor_to_base, qty_base, unit_cost_paisa, cost_per_base_paisa, line_value_paisa)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), l.order_line_id, l.variant_id, l.unit_id, l.product_name, coalesce(l.variant_name, ''), l.sku, l.unit_name,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_cost_paisa, round(l.unit_cost_paisa / l.factor_to_base)::bigint, round(l.qty_entered * l.unit_cost_paisa)::bigint
  FROM jsonb_populate_recordset(NULL::purchase_line_input, p->'lines') WITH ORDINALITY AS l(line_id, order_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, qty_entered, factor_to_base, qty_base, unit_cost_paisa, ord);

  -- Stock comes in, in a fixed order so two receipts can never deadlock. The ledger trigger recalculates the average cost.
  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT v_business, variant_id, v_location, qty_base, cost_per_base_paisa, 'goods_receipt', v_id, p_actor
  FROM goods_receipt_lines WHERE receipt_id = v_id ORDER BY variant_id, line_no;

  IF v_order IS NOT NULL THEN
    UPDATE purchase_order_lines ol SET received_base = ol.received_base + t.now_base
    FROM (SELECT order_line_id, sum(qty_base) AS now_base FROM goods_receipt_lines WHERE receipt_id = v_id GROUP BY order_line_id) t
    WHERE ol.id = t.order_line_id;
    UPDATE purchase_orders SET updated_by = p_actor, updated_at = now(),
      status = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE order_id = v_order AND received_base < qty_base) THEN 'received' ELSE 'partly_received' END
    WHERE id = v_order;
  END IF;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('purchasing.view', 'View purchase orders and goods receipts'),
  ('purchasing.order', 'Write, send, cancel and close purchase orders (prices need the cost permission)'),
  ('purchasing.receive', 'Receive goods against an order or without one')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('purchasing.view'), ('purchasing.order'), ('purchasing.receive')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
