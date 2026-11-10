-- v0.9 slice 1: stock transfers between locations, with an in-transit stage (FR-INV-04, FR-INV-11). API-only like the rest.
--
-- A transfer is REQUESTED (nothing moves), then DISPATCHED (the stock leaves the source through the ledger at the source's average cost;
-- it is now "in transit", on no shelf at all), then RECEIVED (the stock enters the destination at that same cost, so the value that left
-- is the value that arrives). The person receiving can record less than was sent: the shortage is kept on the line and the transfer's
-- history, nothing is posted for goods that never arrived. A requested transfer can be cancelled; a dispatched one cannot, it is received.
-- Moving goods into a location of type 'damaged' is how defective or returned goods are quarantined (FR-INV-11): stock there is counted
-- and valued, but no register sells from it.

CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The source location's branch; the number comes from its series.
  branch_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'dispatched', 'received', 'cancelled')),
  note text NOT NULL DEFAULT '',
  receive_note text NOT NULL DEFAULT '',
  dispatched_at timestamptz,
  dispatched_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at timestamptz,
  received_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  CHECK (from_location_id <> to_location_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (from_location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (to_location_id, business_id) REFERENCES locations(id, business_id)
);
CREATE INDEX stock_transfers_status_idx ON stock_transfers (business_id, status, created_at DESC);
CREATE INDEX stock_transfers_to_idx ON stock_transfers (business_id, to_location_id, status);

CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  unit_name text NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered > 0),
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  qty_base numeric(14,3) NOT NULL CHECK (qty_base > 0),
  -- The source's average cost per base unit at dispatch; the destination takes the goods in at it.
  cost_paisa bigint NOT NULL DEFAULT 0 CHECK (cost_paisa >= 0),
  -- Set when received (in the base unit); null until then. Never more than was sent.
  received_base numeric(14,3) CHECK (received_base IS NULL OR received_base >= 0),
  UNIQUE (id, business_id),
  UNIQUE (transfer_id, line_no),
  UNIQUE (transfer_id, variant_id),
  FOREIGN KEY (transfer_id, business_id) REFERENCES stock_transfers(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  CHECK (qty_base = qty_entered * factor_to_base),
  CHECK (received_base IS NULL OR received_base <= qty_base)
);

-- What is on a transfer never changes (the cost and the received quantity are filled in on the way); the header changes only through
-- its status and the notes and times that go with it.
CREATE FUNCTION protect_stock_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stock transfer cannot be deleted; cancel it instead'; END IF;
  IF TG_TABLE_NAME = 'stock_transfer_lines' THEN
    IF (to_jsonb(NEW) - 'cost_paisa' - 'received_base') = (to_jsonb(OLD) - 'cost_paisa' - 'received_base') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'the lines of a stock transfer cannot be changed; cancel it and write another';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'receive_note' - 'dispatched_at' - 'dispatched_by' - 'received_at' - 'received_by' - 'cancelled_at' - 'updated_at' - 'updated_by')
     = (to_jsonb(OLD) - 'status' - 'receive_note' - 'dispatched_at' - 'dispatched_by' - 'received_at' - 'received_by' - 'cancelled_at' - 'updated_at' - 'updated_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a stock transfer cannot be changed except for its status';
END;
$$;
CREATE TRIGGER stock_transfers_protect BEFORE UPDATE OR DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION protect_stock_transfer();
CREATE TRIGGER stock_transfer_lines_protect BEFORE UPDATE OR DELETE ON stock_transfer_lines FOR EACH ROW EXECUTE FUNCTION protect_stock_transfer();

-- ---------------------------------------------------------------- writing a transfer

CREATE TYPE transfer_line_input AS (variant_id uuid, unit_id uuid, qty_entered numeric);

-- Writes a requested transfer: two different active locations of the business and at least one stocked item. Nothing moves.
CREATE FUNCTION create_stock_transfer(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_from uuid := (p->>'from_location_id')::uuid;
  v_to uuid := (p->>'to_location_id')::uuid;
  v_branch uuid;
  v_active boolean;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_count integer;
  v_matched integer;
BEGIN
  IF v_from = v_to THEN RAISE EXCEPTION 'SAME_LOCATION: choose two different locations'; END IF;
  SELECT branch_id, active INTO v_branch, v_active FROM locations WHERE id = v_from AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such source location'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'LOCATION_INACTIVE: the source location is not in use'; END IF;
  SELECT active INTO v_active FROM locations WHERE id = v_to AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such destination location'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'LOCATION_INACTIVE: the destination location is not in use'; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::transfer_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one item'; END IF;
  IF (SELECT count(DISTINCT variant_id) FROM jsonb_populate_recordset(NULL::transfer_line_input, p->'lines')) <> v_count THEN
    RAISE EXCEPTION 'INVALID_LINE: an item is listed twice; add its quantities together';
  END IF;
  SELECT count(*) INTO v_matched FROM jsonb_populate_recordset(NULL::transfer_line_input, p->'lines') l
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.business_id = v_business AND pr.product_type = 'stocked' AND pr.active
  WHERE l.qty_entered > 0;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not a stocked item in that unit'; END IF;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'stock_transfer', 'ST-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'stock_transfer');

  INSERT INTO stock_transfers (id, business_id, branch_id, number, sequence_no, from_location_id, to_location_id, note, created_by, updated_by)
  VALUES (v_id, v_business, v_branch, v_number, v_sequence, v_from, v_to, coalesce(p->>'note', ''), p_actor, p_actor);

  INSERT INTO stock_transfer_lines (business_id, transfer_id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, qty_entered, factor_to_base, qty_base)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), v.id, u.id, pr.name, v.variant_name, v.sku, u.name, l.qty_entered, pu.factor_to_base, l.qty_entered * pu.factor_to_base
  FROM jsonb_populate_recordset(NULL::transfer_line_input, p->'lines') WITH ORDINALITY AS l(variant_id, unit_id, qty_entered, ord)
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business
  JOIN product_variants v ON v.id = l.variant_id
  JOIN products pr ON pr.id = v.product_id
  JOIN units u ON u.id = l.unit_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- dispatching

-- Sends a requested transfer out: the stock leaves the source through the ledger at its average cost (refused if there is not enough,
-- unless the business allows negative stock). From now until it is received the goods are in transit.
CREATE FUNCTION dispatch_stock_transfer(p_business uuid, p_transfer uuid, p_allow_negative boolean, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t stock_transfers%ROWTYPE;
  need record;
  v_on_hand numeric(14,3);
BEGIN
  SELECT * INTO t FROM stock_transfers WHERE id = p_transfer AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock transfer'; END IF;
  IF t.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % transfer cannot be dispatched', t.status; END IF;

  FOR need IN SELECT variant_id, qty_base AS qty FROM stock_transfer_lines WHERE transfer_id = p_transfer ORDER BY variant_id LOOP
    INSERT INTO stock_balances (business_id, variant_id, location_id) VALUES (p_business, need.variant_id, t.from_location_id) ON CONFLICT (variant_id, location_id) DO NOTHING;
    SELECT on_hand INTO v_on_hand FROM stock_balances WHERE variant_id = need.variant_id AND location_id = t.from_location_id FOR UPDATE;
    IF NOT p_allow_negative AND v_on_hand - need.qty < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % on hand, needs %', need.variant_id, v_on_hand, need.qty;
    END IF;
  END LOOP;

  UPDATE stock_transfer_lines tl SET cost_paisa = coalesce(b.avg_cost_paisa, v.cost_paisa)
  FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = t.from_location_id
  WHERE tl.transfer_id = p_transfer AND v.id = tl.variant_id;

  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT p_business, tl.variant_id, t.from_location_id, -tl.qty_base, tl.cost_paisa, 'stock_transfer_out', p_transfer, p_actor
  FROM stock_transfer_lines tl WHERE tl.transfer_id = p_transfer ORDER BY tl.variant_id;

  UPDATE stock_transfers SET status = 'dispatched', dispatched_at = now(), dispatched_by = p_actor, updated_by = p_actor, updated_at = now() WHERE id = p_transfer;
END;
$$;

-- ---------------------------------------------------------------- receiving

CREATE TYPE transfer_receipt_input AS (line_id uuid, qty_received numeric);

-- Takes a dispatched transfer into the destination. `p` may list, per line, how many of the line's unit actually arrived (a line not
-- listed arrived in full). More than was sent is refused. What arrives is taken in at the cost it left at.
CREATE FUNCTION receive_stock_transfer(p_business uuid, p_transfer uuid, p jsonb, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t stock_transfers%ROWTYPE;
  v_count integer;
  v_matched integer;
  l record;
BEGIN
  SELECT * INTO t FROM stock_transfers WHERE id = p_transfer AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock transfer'; END IF;
  IF t.status <> 'dispatched' THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % transfer cannot be received', t.status; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::transfer_receipt_input, coalesce(p->'lines', '[]'::jsonb));
  SELECT count(*) INTO v_matched FROM jsonb_populate_recordset(NULL::transfer_receipt_input, coalesce(p->'lines', '[]'::jsonb)) r
  JOIN stock_transfer_lines tl ON tl.id = r.line_id AND tl.transfer_id = p_transfer;
  IF v_matched <> v_count OR (SELECT count(DISTINCT line_id) FROM jsonb_populate_recordset(NULL::transfer_receipt_input, coalesce(p->'lines', '[]'::jsonb))) <> v_count THEN
    RAISE EXCEPTION 'INVALID_LINE: a line is not on this transfer, or is listed twice';
  END IF;

  FOR l IN
    SELECT tl.id, tl.sku, tl.qty_base, tl.factor_to_base, tl.qty_entered,
           CASE WHEN r.line_id IS NULL THEN tl.qty_base ELSE r.qty_received * tl.factor_to_base END AS arrived
    FROM stock_transfer_lines tl
    LEFT JOIN jsonb_populate_recordset(NULL::transfer_receipt_input, coalesce(p->'lines', '[]'::jsonb)) r ON r.line_id = tl.id
    WHERE tl.transfer_id = p_transfer
  LOOP
    IF l.arrived < 0 THEN RAISE EXCEPTION 'INVALID_LINE: % cannot arrive in a negative quantity', l.sku; END IF;
    IF l.arrived > l.qty_base THEN
      RAISE EXCEPTION 'RECEIVED_MORE_THAN_SENT: % was sent as %, %  cannot arrive (counted in the base unit)', l.sku, l.qty_base, l.arrived;
    END IF;
    UPDATE stock_transfer_lines SET received_base = l.arrived WHERE id = l.id;
  END LOOP;

  INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
  SELECT p_business, tl.variant_id, t.to_location_id, tl.received_base, tl.cost_paisa, 'stock_transfer_in', p_transfer, p_actor
  FROM stock_transfer_lines tl WHERE tl.transfer_id = p_transfer AND tl.received_base > 0 ORDER BY tl.variant_id;

  UPDATE stock_transfers SET status = 'received', received_at = now(), received_by = p_actor, receive_note = coalesce(p->>'note', ''), updated_by = p_actor, updated_at = now()
  WHERE id = p_transfer;
END;
$$;

CREATE FUNCTION cancel_stock_transfer(p_business uuid, p_transfer uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM stock_transfers WHERE id = p_transfer AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock transfer'; END IF;
  IF v_status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % transfer cannot be cancelled; goods that have left are received', v_status; END IF;
  UPDATE stock_transfers SET status = 'cancelled', cancelled_at = now(), updated_by = p_actor, updated_at = now() WHERE id = p_transfer;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('transfers.view', 'View stock transfers and what is in transit'),
  ('transfers.manage', 'Request, dispatch, receive and cancel stock transfers (stock leaves on dispatch and arrives on receipt)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('transfers.view'), ('transfers.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
