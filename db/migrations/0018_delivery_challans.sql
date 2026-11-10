-- v0.6 slice 4: delivery challans / dispatch notes (FR-SO-02, FR-SO-06). API-only like the rest.
--
-- A challan is how the goods of a sales order leave: it lists what goes out on one trip, with the driver, vehicle and route.
-- It is written PENDING (nothing happens to stock), DISPATCHED posts the stock out through the stock ledger at the average cost,
-- moves the order on (partly delivered, then delivered) and releases the reservation for what went; DELIVERED is the customer
-- having received it; RETURNED puts the goods back (stock in at the cost they left at, the order's delivered quantity down again).
-- A pending challan can be cancelled. It carries no prices: it is a packing and handing-over document. The order's lines carry the
-- prices, and the invoice (slice 5) bills what was delivered.

CREATE TABLE delivery_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'delivered', 'returned', 'cancelled')),
  driver_name text NOT NULL DEFAULT '',
  vehicle_no text NOT NULL DEFAULT '',
  route text NOT NULL DEFAULT '',
  delivery_address text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  return_reason text NOT NULL DEFAULT '',
  dispatched_at timestamptz,
  delivered_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (order_id, business_id) REFERENCES sales_orders(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id)
);
CREATE INDEX delivery_challans_order_idx ON delivery_challans (order_id);
CREATE INDEX delivery_challans_status_idx ON delivery_challans (business_id, status, created_at DESC);

CREATE TABLE delivery_challan_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  challan_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  order_line_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  -- The average cost per base unit the goods left at, set when the challan is dispatched (profit reports, and the cost a return puts them back at).
  cost_paisa bigint NOT NULL DEFAULT 0 CHECK (cost_paisa >= 0),
  UNIQUE (id, business_id),
  UNIQUE (challan_id, line_no),
  FOREIGN KEY (challan_id, business_id) REFERENCES delivery_challans(id, business_id),
  FOREIGN KEY (order_line_id, business_id) REFERENCES sales_order_lines(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  CHECK (qty_base = qty_entered * factor_to_base)
);
CREATE INDEX delivery_challan_lines_order_line_idx ON delivery_challan_lines (order_line_id);

-- What goes on a challan never changes (only the cost is filled in at dispatch). The header may take a new driver, vehicle, route or
-- note until the goods are back or the challan is cancelled; its status moves only through the functions below.
CREATE FUNCTION protect_delivery_challan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a delivery challan cannot be deleted; cancel it instead'; END IF;
  IF TG_TABLE_NAME = 'delivery_challan_lines' THEN
    IF (to_jsonb(NEW) - 'cost_paisa') = (to_jsonb(OLD) - 'cost_paisa') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'the lines of a delivery challan cannot be changed; cancel it and write another';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'driver_name' - 'vehicle_no' - 'route' - 'note' - 'return_reason' - 'dispatched_at' - 'delivered_at' - 'returned_at' - 'updated_at' - 'updated_by')
     = (to_jsonb(OLD) - 'status' - 'driver_name' - 'vehicle_no' - 'route' - 'note' - 'return_reason' - 'dispatched_at' - 'delivered_at' - 'returned_at' - 'updated_at' - 'updated_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a delivery challan cannot be changed except for its status, driver, vehicle, route and note';
END;
$$;
CREATE TRIGGER delivery_challans_protect BEFORE UPDATE OR DELETE ON delivery_challans FOR EACH ROW EXECUTE FUNCTION protect_delivery_challan();
CREATE TRIGGER delivery_challan_lines_protect BEFORE UPDATE OR DELETE ON delivery_challan_lines FOR EACH ROW EXECUTE FUNCTION protect_delivery_challan();

-- ---------------------------------------------------------------- writing a challan

CREATE TYPE challan_line_input AS (order_line_id uuid, qty_entered numeric);

-- Writes a pending challan for an order that is open or partly delivered. Each line names an order line and how many of its unit go
-- out on this trip; it may not take more than is still to be delivered less what other pending challans already carry. Nothing moves.
CREATE FUNCTION create_delivery_challan(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_order uuid := (p->>'order_id')::uuid;
  o sales_orders%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_count integer;
  v_matched integer;
  taken record;
BEGIN
  SELECT * INTO o FROM sales_orders WHERE id = v_order AND business_id = v_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
  IF o.status NOT IN ('open', 'partly_delivered') THEN RAISE EXCEPTION 'ORDER_NOT_DELIVERABLE: a % order has nothing to deliver', o.status; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::challan_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one item'; END IF;
  PERFORM 1 FROM sales_order_lines WHERE order_id = v_order ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_matched FROM jsonb_populate_recordset(NULL::challan_line_input, p->'lines') l
  JOIN sales_order_lines ol ON ol.id = l.order_line_id AND ol.order_id = v_order WHERE l.qty_entered > 0;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not on this order'; END IF;

  FOR taken IN
    SELECT ol.id, ol.sku, ol.qty_base AS ordered, ol.delivered_base AS delivered, sum(l.qty_entered * ol.factor_to_base) AS now_base,
           coalesce((SELECT sum(cl.qty_base) FROM delivery_challan_lines cl JOIN delivery_challans c ON c.id = cl.challan_id
                     WHERE cl.order_line_id = ol.id AND c.status = 'pending'), 0) AS pending
    FROM jsonb_populate_recordset(NULL::challan_line_input, p->'lines') l JOIN sales_order_lines ol ON ol.id = l.order_line_id
    GROUP BY ol.id, ol.sku, ol.qty_base, ol.delivered_base
  LOOP
    IF taken.delivered + taken.pending + taken.now_base > taken.ordered THEN
      RAISE EXCEPTION 'DELIVERY_EXCEEDS_ORDER: % ordered %, already delivered or on other pending challans %, % more would be too many (counted in the base unit)',
        taken.sku, taken.ordered, taken.delivered + taken.pending, taken.now_base;
    END IF;
  END LOOP;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'delivery_challan', 'DC-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = o.branch_id AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, o.branch_id, 'delivery_challan');

  INSERT INTO delivery_challans (id, business_id, branch_id, location_id, order_id, customer_id, number, sequence_no, driver_name, vehicle_no, route, delivery_address, note, created_by, updated_by)
  VALUES (v_id, v_business, o.branch_id, o.location_id, v_order, o.customer_id, v_number, v_sequence, coalesce(p->>'driver_name', ''), coalesce(p->>'vehicle_no', ''),
          coalesce(p->>'route', ''), coalesce(nullif(p->>'delivery_address', ''), o.delivery_address), coalesce(p->>'note', ''), p_actor, p_actor);

  INSERT INTO delivery_challan_lines (business_id, challan_id, line_no, order_line_id, variant_id, unit_id, product_name, variant_name, sku, unit_name, qty_entered, factor_to_base, qty_base)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), ol.id, ol.variant_id, ol.unit_id, ol.product_name, ol.variant_name, ol.sku, ol.unit_name,
         l.qty_entered, ol.factor_to_base, l.qty_entered * ol.factor_to_base
  FROM jsonb_populate_recordset(NULL::challan_line_input, p->'lines') WITH ORDINALITY AS l(order_line_id, qty_entered, ord)
  JOIN sales_order_lines ol ON ol.id = l.order_line_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- dispatching

-- Sends a pending challan out: stock leaves through the ledger at the average cost (refused if there is not enough, unless the business
-- allows negative stock), the order's delivered quantities go up, the order becomes partly delivered or delivered, and the reservation
-- for what went is released. Driver, vehicle and route can be given or corrected here.
CREATE FUNCTION dispatch_delivery_challan(p_business uuid, p_challan uuid, p jsonb, p_allow_negative boolean, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c delivery_challans%ROWTYPE;
  v_status text;
  need record;
  l record;
  v_on_hand numeric(14,3);
BEGIN
  SELECT * INTO c FROM delivery_challans WHERE id = p_challan AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such delivery challan'; END IF;
  IF c.status <> 'pending' THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % challan cannot be dispatched', c.status; END IF;
  SELECT status INTO v_status FROM sales_orders WHERE id = c.order_id FOR UPDATE;
  IF v_status NOT IN ('open', 'partly_delivered') THEN RAISE EXCEPTION 'ORDER_NOT_DELIVERABLE: the order is %', v_status; END IF;
  PERFORM 1 FROM sales_order_lines WHERE order_id = c.order_id ORDER BY id FOR UPDATE;

  FOR l IN
    SELECT cl.sku, cl.qty_base, ol.qty_base AS ordered, ol.delivered_base AS delivered
    FROM delivery_challan_lines cl JOIN sales_order_lines ol ON ol.id = cl.order_line_id WHERE cl.challan_id = p_challan
  LOOP
    IF l.delivered + l.qty_base > l.ordered THEN
      RAISE EXCEPTION 'DELIVERY_EXCEEDS_ORDER: % ordered %, % already delivered, % more would be too many', l.sku, l.ordered, l.delivered, l.qty_base;
    END IF;
  END LOOP;

  -- Lock the stock of every stocked SKU in a fixed order and check there is enough on the shelf.
  FOR need IN
    SELECT cl.variant_id, sum(cl.qty_base) AS qty
    FROM delivery_challan_lines cl JOIN product_variants v ON v.id = cl.variant_id JOIN products pr ON pr.id = v.product_id
    WHERE cl.challan_id = p_challan AND pr.product_type = 'stocked' GROUP BY cl.variant_id ORDER BY cl.variant_id
  LOOP
    INSERT INTO stock_balances (business_id, variant_id, location_id) VALUES (p_business, need.variant_id, c.location_id) ON CONFLICT (variant_id, location_id) DO NOTHING;
    SELECT on_hand INTO v_on_hand FROM stock_balances WHERE variant_id = need.variant_id AND location_id = c.location_id FOR UPDATE;
    IF NOT p_allow_negative AND v_on_hand - need.qty < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % on hand, needs %', need.variant_id, v_on_hand, need.qty;
    END IF;
  END LOOP;

  -- The cost the goods leave at, kept on the line.
  UPDATE delivery_challan_lines cl SET cost_paisa = CASE WHEN pr.product_type = 'stocked' THEN coalesce(b.avg_cost_paisa, v.cost_paisa) ELSE v.cost_paisa END
  FROM product_variants v JOIN products pr ON pr.id = v.product_id
  LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = c.location_id
  WHERE cl.challan_id = p_challan AND v.id = cl.variant_id;

  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT p_business, cl.variant_id, c.location_id, -cl.qty_base, cl.cost_paisa, 'delivery_challan', p_challan, p_actor
  FROM delivery_challan_lines cl JOIN product_variants v ON v.id = cl.variant_id JOIN products pr ON pr.id = v.product_id
  WHERE cl.challan_id = p_challan AND pr.product_type = 'stocked' ORDER BY cl.variant_id, cl.line_no;

  UPDATE sales_order_lines ol SET delivered_base = ol.delivered_base + t.qty
  FROM (SELECT order_line_id, sum(qty_base) AS qty FROM delivery_challan_lines WHERE challan_id = p_challan GROUP BY order_line_id) t
  WHERE ol.id = t.order_line_id;
  UPDATE sales_orders SET updated_by = p_actor, updated_at = now(),
    status = CASE WHEN NOT EXISTS (SELECT 1 FROM sales_order_lines WHERE order_id = c.order_id AND delivered_base < qty_base) THEN 'delivered' ELSE 'partly_delivered' END
  WHERE id = c.order_id;

  UPDATE delivery_challans SET status = 'dispatched', dispatched_at = now(), updated_by = p_actor, updated_at = now(),
    driver_name = coalesce(nullif(p->>'driver_name', ''), driver_name), vehicle_no = coalesce(nullif(p->>'vehicle_no', ''), vehicle_no), route = coalesce(nullif(p->>'route', ''), route)
  WHERE id = p_challan;
END;
$$;

-- pending -> cancelled; dispatched -> delivered; dispatched or delivered -> returned (the goods come back).
CREATE FUNCTION set_delivery_challan_status(p_business uuid, p_challan uuid, p_status text, p_reason text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c delivery_challans%ROWTYPE;
  v_order_status text;
  l record;
BEGIN
  SELECT * INTO c FROM delivery_challans WHERE id = p_challan AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such delivery challan'; END IF;
  IF NOT ((c.status = 'pending' AND p_status = 'cancelled') OR (c.status = 'dispatched' AND p_status = 'delivered')
       OR (c.status IN ('dispatched', 'delivered') AND p_status = 'returned')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % challan cannot become %', c.status, p_status;
  END IF;

  IF p_status = 'returned' THEN
    SELECT status INTO v_order_status FROM sales_orders WHERE id = c.order_id FOR UPDATE;
    PERFORM 1 FROM sales_order_lines WHERE order_id = c.order_id ORDER BY id FOR UPDATE;
    -- Goods that have been billed cannot simply come back: that is a sales return.
    FOR l IN
      SELECT cl.sku, cl.qty_base, ol.delivered_base AS delivered, ol.invoiced_base AS invoiced
      FROM delivery_challan_lines cl JOIN sales_order_lines ol ON ol.id = cl.order_line_id WHERE cl.challan_id = p_challan
    LOOP
      IF l.delivered - l.qty_base < l.invoiced THEN
        RAISE EXCEPTION 'DELIVERY_BILLED: % has been billed (% billed, % delivered); record a sales return instead', l.sku, l.invoiced, l.delivered;
      END IF;
    END LOOP;
    INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
    SELECT p_business, cl.variant_id, c.location_id, cl.qty_base, cl.cost_paisa, 'delivery_return', p_challan, p_actor
    FROM delivery_challan_lines cl JOIN product_variants v ON v.id = cl.variant_id JOIN products pr ON pr.id = v.product_id
    WHERE cl.challan_id = p_challan AND pr.product_type = 'stocked' ORDER BY cl.variant_id, cl.line_no;
    UPDATE sales_order_lines ol SET delivered_base = ol.delivered_base - t.qty
    FROM (SELECT order_line_id, sum(qty_base) AS qty FROM delivery_challan_lines WHERE challan_id = p_challan GROUP BY order_line_id) t
    WHERE ol.id = t.order_line_id;
    -- An order still being worked goes back to open or partly delivered, and holds the stock again; a closed or cancelled one stays as it is.
    IF v_order_status IN ('partly_delivered', 'delivered') THEN
      UPDATE sales_orders SET updated_by = p_actor, updated_at = now(),
        status = CASE WHEN NOT EXISTS (SELECT 1 FROM sales_order_lines WHERE order_id = c.order_id AND delivered_base > 0) THEN 'open'
                      WHEN EXISTS (SELECT 1 FROM sales_order_lines WHERE order_id = c.order_id AND delivered_base < qty_base) THEN 'partly_delivered' ELSE 'delivered' END
      WHERE id = c.order_id;
    END IF;
  END IF;

  UPDATE delivery_challans SET status = p_status, updated_by = p_actor, updated_at = now(),
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END,
    returned_at = CASE WHEN p_status = 'returned' THEN now() ELSE returned_at END,
    return_reason = CASE WHEN p_status = 'returned' THEN coalesce(p_reason, '') ELSE return_reason END
  WHERE id = p_challan;
END;
$$;

-- An order that is cancelled or closed takes its pending challans with it.
CREATE OR REPLACE FUNCTION set_sales_order_status(p_business uuid, p_order uuid, p_status text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM sales_orders WHERE id = p_order AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such order'; END IF;
  IF NOT ((v_status = 'open' AND p_status = 'cancelled') OR (v_status IN ('partly_delivered', 'delivered') AND p_status = 'closed')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % order cannot become %', v_status, p_status;
  END IF;
  UPDATE sales_orders SET status = p_status, updated_by = p_actor, updated_at = now() WHERE id = p_order;
  UPDATE delivery_challans SET status = 'cancelled', updated_by = p_actor, updated_at = now() WHERE order_id = p_order AND status = 'pending';
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('delivery.view', 'View delivery challans'),
  ('delivery.manage', 'Write, dispatch, deliver, return and cancel delivery challans (stock leaves on dispatch)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('delivery.view'), ('delivery.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE delivery_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_lines ENABLE ROW LEVEL SECURITY;
