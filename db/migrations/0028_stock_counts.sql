-- v0.9 slice 2: physical stock counts (FR-INV-05). API-only like the rest.
--
-- A count is STARTED for one location, full or partial (cycle count): the stock the books expect for each item is frozen into the
-- count's lines at that moment. People then COUNT: scanning or typing what is on the shelf (an item not counted yet stays "not counted";
-- it is never taken to be zero). When the counter is done the count is SUBMITTED for review, which shows the variance (counted less
-- expected) and what the stock has done since the freeze; the reviewer APPROVES it, or sends it back to be counted again, or cancels it.
-- Approving posts one stock adjustment for the variances through the same function as every other adjustment (so the ledger, the
-- balances and the audit trail are the usual ones). The variance is counted against the frozen figure, so a sale made while counting
-- is not taken out of stock twice.

CREATE TABLE stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  scope text NOT NULL CHECK (scope IN ('full', 'partial')),
  status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'submitted', 'approved', 'cancelled')),
  note text NOT NULL DEFAULT '',
  review_note text NOT NULL DEFAULT '',
  -- The adjustment posted on approval; null when the count found no differences.
  adjustment_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id),
  FOREIGN KEY (adjustment_id, business_id) REFERENCES stock_adjustments(id, business_id)
);
CREATE INDEX stock_counts_status_idx ON stock_counts (business_id, status, created_at DESC);
-- One open count per location, so two people are not counting the same shelf against different freezes.
CREATE UNIQUE INDEX stock_counts_one_open_uidx ON stock_counts (location_id) WHERE status IN ('counting', 'submitted');

CREATE TABLE stock_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  count_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL DEFAULT '',
  sku text NOT NULL,
  -- In the base unit. What the books held when the line joined the count.
  expected_base numeric(14,3) NOT NULL,
  -- What was counted, in the base unit; null until someone counts it.
  counted_base numeric(14,3) CHECK (counted_base IS NULL OR counted_base >= 0),
  -- The location's average cost per base unit when frozen, for valuing the variance.
  cost_paisa bigint NOT NULL DEFAULT 0 CHECK (cost_paisa >= 0),
  counted_at timestamptz,
  counted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (count_id, variant_id),
  FOREIGN KEY (count_id, business_id) REFERENCES stock_counts(id, business_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id)
);

-- Counting is only possible while a count is being counted; once it is submitted its lines are fixed until it is sent back.
CREATE FUNCTION protect_stock_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'stock_counts' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stock count cannot be deleted; cancel it instead'; END IF;
    IF OLD.status IN ('approved', 'cancelled') THEN RAISE EXCEPTION 'a % stock count cannot be changed', OLD.status; END IF;
    IF (to_jsonb(NEW) - 'status' - 'note' - 'review_note' - 'adjustment_id' - 'submitted_at' - 'submitted_by' - 'approved_at' - 'approved_by' - 'cancelled_at' - 'updated_at' - 'updated_by')
       = (to_jsonb(OLD) - 'status' - 'note' - 'review_note' - 'adjustment_id' - 'submitted_at' - 'submitted_by' - 'approved_at' - 'approved_by' - 'cancelled_at' - 'updated_at' - 'updated_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a stock count cannot be changed except for its status and notes';
  END IF;

  SELECT status INTO v_status FROM stock_counts WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.count_id ELSE NEW.count_id END;
  IF v_status <> 'counting' THEN RAISE EXCEPTION 'COUNT_NOT_OPEN: the count is %, so its lines cannot be changed', v_status; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a counted line cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'counted_base' - 'counted_at' - 'counted_by') <> (to_jsonb(OLD) - 'counted_base' - 'counted_at' - 'counted_by') THEN
    RAISE EXCEPTION 'only the counted quantity of a line can change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_counts_protect BEFORE UPDATE OR DELETE ON stock_counts FOR EACH ROW EXECUTE FUNCTION protect_stock_count();
CREATE TRIGGER stock_count_lines_protect BEFORE INSERT OR UPDATE OR DELETE ON stock_count_lines FOR EACH ROW EXECUTE FUNCTION protect_stock_count();

-- ---------------------------------------------------------------- starting a count

-- Starts a count of one location and freezes what the books expect. A full count takes every active stocked item; a partial one takes
-- the listed items (p->'variant_ids'). Refused if the location already has an open count.
CREATE FUNCTION start_stock_count(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_scope text := p->>'scope';
  v_branch uuid;
  v_active boolean;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_ids uuid[];
  v_found integer;
BEGIN
  IF v_scope NOT IN ('full', 'partial') THEN RAISE EXCEPTION 'INVALID_LINE: a count is full or partial'; END IF;
  SELECT branch_id, active INTO v_branch, v_active FROM locations WHERE id = v_location AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such location'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'LOCATION_INACTIVE: the location is not in use'; END IF;
  IF EXISTS (SELECT 1 FROM stock_counts WHERE location_id = v_location AND status IN ('counting', 'submitted')) THEN
    RAISE EXCEPTION 'COUNT_ALREADY_OPEN: this location already has a count that is not finished';
  END IF;

  IF v_scope = 'partial' THEN
    SELECT coalesce(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO v_ids FROM jsonb_array_elements_text(coalesce(p->'variant_ids', '[]'::jsonb)) x;
    IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'INVALID_LINE: choose at least one item to count'; END IF;
    SELECT count(*) INTO v_found FROM product_variants v JOIN products pr ON pr.id = v.product_id
    WHERE v.business_id = v_business AND v.id = ANY (v_ids) AND v.active AND pr.product_type = 'stocked';
    IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'INVALID_LINE: an item is not a stocked item of this business'; END IF;
  END IF;

  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT v_business, b.id, 'stock_count', 'SC-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
  ON CONFLICT DO NOTHING;
  SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'stock_count');

  INSERT INTO stock_counts (id, business_id, branch_id, location_id, number, sequence_no, scope, note, created_by, updated_by)
  VALUES (v_id, v_business, v_branch, v_location, v_number, v_sequence, v_scope, coalesce(p->>'note', ''), p_actor, p_actor);

  INSERT INTO stock_count_lines (business_id, count_id, variant_id, product_name, variant_name, sku, expected_base, cost_paisa)
  SELECT v_business, v_id, v.id, pr.name, v.variant_name, v.sku, coalesce(b.on_hand, 0), coalesce(b.avg_cost_paisa, v.cost_paisa)
  FROM product_variants v JOIN products pr ON pr.id = v.product_id
  LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = v_location
  WHERE v.business_id = v_business AND v.active AND pr.active AND pr.product_type = 'stocked'
    AND (v_scope = 'full' OR v.id = ANY (v_ids));
  RETURN v_id;
END;
$$;

-- Adds items to a count that is being counted (a partial count growing, or something found on the shelf that was not expected).
-- The books' figure for it is frozen now.
CREATE FUNCTION add_stock_count_items(p_business uuid, p_count uuid, p_variants uuid[]) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  c stock_counts%ROWTYPE;
  v_found integer;
  v_added integer;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock count'; END IF;
  IF c.status <> 'counting' THEN RAISE EXCEPTION 'COUNT_NOT_OPEN: the count is %, so items cannot be added', c.status; END IF;
  SELECT count(*) INTO v_found FROM product_variants v JOIN products pr ON pr.id = v.product_id
  WHERE v.business_id = p_business AND v.id = ANY (p_variants) AND v.active AND pr.product_type = 'stocked';
  IF v_found <> cardinality(p_variants) THEN RAISE EXCEPTION 'INVALID_LINE: an item is not a stocked item of this business'; END IF;
  INSERT INTO stock_count_lines (business_id, count_id, variant_id, product_name, variant_name, sku, expected_base, cost_paisa)
  SELECT p_business, p_count, v.id, pr.name, v.variant_name, v.sku, coalesce(b.on_hand, 0), coalesce(b.avg_cost_paisa, v.cost_paisa)
  FROM product_variants v JOIN products pr ON pr.id = v.product_id
  LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = c.location_id
  WHERE v.business_id = p_business AND v.id = ANY (p_variants)
  ON CONFLICT (count_id, variant_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END;
$$;

-- ---------------------------------------------------------------- moving a count on

-- counting -> submitted; submitted -> counting (recount); counting or submitted -> cancelled.
CREATE FUNCTION set_stock_count_status(p_business uuid, p_count uuid, p_status text, p_note text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c stock_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock count'; END IF;
  IF NOT ((c.status = 'counting' AND p_status = 'submitted') OR (c.status = 'submitted' AND p_status = 'counting')
       OR (c.status IN ('counting', 'submitted') AND p_status = 'cancelled')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % count cannot become %', c.status, p_status;
  END IF;
  IF p_status = 'submitted' AND NOT EXISTS (SELECT 1 FROM stock_count_lines WHERE count_id = p_count AND counted_base IS NOT NULL) THEN
    RAISE EXCEPTION 'NOTHING_COUNTED: nothing has been counted yet';
  END IF;
  UPDATE stock_counts SET status = p_status, updated_by = p_actor, updated_at = now(),
    submitted_at = CASE WHEN p_status = 'submitted' THEN now() ELSE submitted_at END,
    submitted_by = CASE WHEN p_status = 'submitted' THEN p_actor ELSE submitted_by END,
    cancelled_at = CASE WHEN p_status = 'cancelled' THEN now() ELSE cancelled_at END,
    review_note = CASE WHEN p_status IN ('counting', 'cancelled') AND coalesce(p_note, '') <> '' THEN p_note ELSE review_note END
  WHERE id = p_count;
END;
$$;

-- Approves a submitted count: one adjustment for every counted item whose count differs from the frozen figure, posted through
-- post_stock_adjustment (refused if a variance would take stock below zero, for example after a sale made while counting). Items
-- not counted are left alone. A count that found no differences is approved without an adjustment.
CREATE FUNCTION approve_stock_count(p_business uuid, p_count uuid, p_note text, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  c stock_counts%ROWTYPE;
  v_adjustment uuid;
  v_value numeric;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock count'; END IF;
  IF c.status <> 'submitted' THEN RAISE EXCEPTION 'INVALID_TRANSITION: a % count cannot be approved', c.status; END IF;

  SELECT coalesce(sum(abs(counted_base - expected_base) * cost_paisa), 0) INTO v_value
  FROM stock_count_lines WHERE count_id = p_count AND counted_base IS NOT NULL AND counted_base <> expected_base;

  IF v_value > 0 OR EXISTS (SELECT 1 FROM stock_count_lines WHERE count_id = p_count AND counted_base IS NOT NULL AND counted_base <> expected_base) THEN
    v_adjustment := gen_random_uuid();
    INSERT INTO stock_adjustments (id, business_id, location_id, reason, note, status, total_value_paisa, created_by, updated_by)
    VALUES (v_adjustment, p_business, c.location_id, 'correction', 'Stock count ' || c.number, 'pending', round(v_value), p_actor, p_actor);
    INSERT INTO stock_adjustment_lines (business_id, adjustment_id, variant_id, unit_id, qty_entered, qty_base_delta, unit_cost_paisa)
    SELECT p_business, v_adjustment, l.variant_id, pr.base_unit_id, l.counted_base - l.expected_base, l.counted_base - l.expected_base, l.cost_paisa
    FROM stock_count_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products pr ON pr.id = v.product_id
    WHERE l.count_id = p_count AND l.counted_base IS NOT NULL AND l.counted_base <> l.expected_base;
    PERFORM post_stock_adjustment(v_adjustment, p_actor);
  END IF;

  UPDATE stock_counts SET status = 'approved', approved_at = now(), approved_by = p_actor, adjustment_id = v_adjustment,
    review_note = coalesce(p_note, ''), updated_by = p_actor, updated_at = now()
  WHERE id = p_count;
  RETURN v_adjustment;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('inventory.count', 'Start, count, submit and cancel physical stock counts (approving the variance needs inventory.approve)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'inventory.count' FROM roles r WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
