-- v0.2 Catalogue and stock (technical-plan 3.1, 3.2). Every table carries business_id, created_by/at
-- and updated_by/at, and is API-only: no grants to anon/authenticated (see 0001).

-- ---------------------------------------------------------------- settings and idempotency

-- Adjustments worth more than this need approval from someone with inventory.approve. PKR 10,000.
ALTER TABLE business_settings
  ADD COLUMN adjustment_approval_threshold_paisa bigint NOT NULL DEFAULT 1000000
    CHECK (adjustment_approval_threshold_paisa >= 0);

-- A retried or double-clicked posting request returns the stored response instead of posting twice.
CREATE TABLE idempotency_keys (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, key)
);

-- ---------------------------------------------------------------- catalogue

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (parent_id, business_id) REFERENCES categories(id, business_id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX categories_name_uidx ON categories (business_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX brands_name_uidx ON brands (business_id, lower(name));

-- Rates are settings, not code (NFR-CMP-01). rate_bps is basis points: 1800 = 18%.
CREATE TABLE tax_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('standard', 'reduced', 'zero_rated', 'exempt', 'third_schedule')),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  fbr_sale_type text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX tax_categories_name_uidx ON tax_categories (business_id, lower(name));

CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  short_name text NOT NULL CHECK (length(btrim(short_name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX units_name_uidx ON units (business_id, lower(name));

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text NOT NULL DEFAULT '',
  category_id uuid,
  brand_id uuid,
  tax_category_id uuid,
  hs_code text,
  image_url text,
  product_type text NOT NULL DEFAULT 'stocked' CHECK (product_type IN ('stocked', 'non_stock', 'service')),
  base_unit_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (category_id, business_id) REFERENCES categories(id, business_id),
  FOREIGN KEY (brand_id, business_id) REFERENCES brands(id, business_id),
  FOREIGN KEY (tax_category_id, business_id) REFERENCES tax_categories(id, business_id),
  FOREIGN KEY (base_unit_id, business_id) REFERENCES units(id, business_id)
);
CREATE INDEX products_business_name_idx ON products (business_id, lower(name));
CREATE INDEX products_category_idx ON products (business_id, category_id);

-- Every product has at least one variant; a plain product has a single default variant. The variant is
-- the SKU that is sold and stocked. Reorder levels are per variant for now (FR-PRD-08 per location comes with transfers).
CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  sku text NOT NULL CHECK (length(btrim(sku)) > 0),
  variant_name text NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_paisa bigint NOT NULL DEFAULT 0 CHECK (cost_paisa >= 0),
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (product_id, business_id) REFERENCES products(id, business_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX product_variants_sku_uidx ON product_variants (business_id, lower(sku));
CREATE INDEX product_variants_product_idx ON product_variants (business_id, product_id);

-- Units a variant is sold/bought in. Stock is kept in the base unit (factor 1); 1 carton = 200 pieces has factor 200.
CREATE TABLE product_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  factor_to_base numeric(14,3) NOT NULL CHECK (factor_to_base > 0),
  is_base boolean NOT NULL DEFAULT false,
  barcode text CHECK (barcode IS NULL OR length(btrim(barcode)) > 0),
  sale_price_paisa bigint NOT NULL DEFAULT 0 CHECK (sale_price_paisa >= 0),
  fbr_uom text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (variant_id, unit_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  CHECK (NOT is_base OR factor_to_base = 1)
);
CREATE UNIQUE INDEX product_units_one_base_uidx ON product_units (variant_id) WHERE is_base;
CREATE UNIQUE INDEX product_units_barcode_uidx ON product_units (business_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX price_lists_name_uidx ON price_lists (business_id, lower(name));

-- min_quantity is in the item's own unit: "10+ cartons costs less per carton".
CREATE TABLE price_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  min_quantity numeric(14,3) NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  price_paisa bigint NOT NULL CHECK (price_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (price_list_id, business_id) REFERENCES price_lists(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  UNIQUE (price_list_id, variant_id, unit_id, min_quantity)
);

-- ---------------------------------------------------------------- stock

-- Append-only record of every stock movement. qty_base is signed and in the variant's base unit.
CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  qty_base numeric(14,3) NOT NULL CHECK (qty_base <> 0),
  unit_cost_paisa bigint NOT NULL DEFAULT 0 CHECK (unit_cost_paisa >= 0),
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
);
CREATE INDEX stock_ledger_variant_idx ON stock_ledger (business_id, variant_id, location_id, created_at);
CREATE INDEX stock_ledger_doc_idx ON stock_ledger (business_id, doc_type, doc_id);

-- Cached balances. Only the ledger trigger below writes them, so they cannot drift from the ledger.
CREATE TABLE stock_balances (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  on_hand numeric(14,3) NOT NULL DEFAULT 0,
  reserved numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  avg_cost_paisa bigint NOT NULL DEFAULT 0 CHECK (avg_cost_paisa >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, location_id),
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
);
CREATE INDEX stock_balances_business_idx ON stock_balances (business_id, location_id);

CREATE FUNCTION deny_stock_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only; record a new adjustment instead';
END;
$$;
CREATE TRIGGER stock_ledger_immutable
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION deny_stock_ledger_mutation();

-- Keeps stock_balances equal to the ledger. A receipt (positive quantity) recalculates the weighted
-- average cost: new_avg = (on_hand x avg + qty x cost) / (on_hand + qty). Issues keep the average.
CREATE FUNCTION apply_stock_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.qty_base > 0 AND previous.on_hand + NEW.qty_base > 0 THEN
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
CREATE TRIGGER stock_ledger_apply_balance
  AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION apply_stock_ledger_entry();

CREATE TABLE stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('damage', 'theft', 'expiry', 'found', 'correction', 'opening')),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  total_value_paisa bigint NOT NULL DEFAULT 0 CHECK (total_value_paisa >= 0),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
);
CREATE INDEX stock_adjustments_status_idx ON stock_adjustments (business_id, status, created_at DESC);

-- qty_base_delta is signed, in the base unit. The unit and quantity as entered are kept for display.
CREATE TABLE stock_adjustment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  qty_entered numeric(14,3) NOT NULL CHECK (qty_entered <> 0),
  qty_base_delta numeric(14,3) NOT NULL CHECK (qty_base_delta <> 0),
  unit_cost_paisa bigint NOT NULL DEFAULT 0 CHECK (unit_cost_paisa >= 0),
  FOREIGN KEY (adjustment_id, business_id) REFERENCES stock_adjustments(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  UNIQUE (adjustment_id, variant_id)
);

-- Once approved or rejected, an adjustment and its lines are history.
CREATE FUNCTION protect_decided_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'stock_adjustments' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'a % stock adjustment cannot be changed or deleted', OLD.status;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM stock_adjustments WHERE id = NEW.adjustment_id AND status <> 'pending') THEN
      RAISE EXCEPTION 'lines cannot be added to a decided stock adjustment';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_adjustments WHERE id = OLD.adjustment_id AND status <> 'pending') THEN
    RAISE EXCEPTION 'lines of a decided stock adjustment cannot be changed or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_adjustments_protect
  BEFORE UPDATE OR DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION protect_decided_adjustment();
CREATE TRIGGER stock_adjustment_lines_protect
  BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION protect_decided_adjustment();

-- Posts a pending adjustment: locks the stock rows, refuses to take stock below zero, writes the
-- ledger (the trigger updates balances) and marks the adjustment approved, all in the caller's transaction.
CREATE FUNCTION post_stock_adjustment(p_adjustment_id uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  adjustment stock_adjustments%ROWTYPE;
  line record;
  on_hand_now numeric(14,3);
  average_now bigint;
BEGIN
  SELECT * INTO adjustment FROM stock_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND'; END IF;
  IF adjustment.status <> 'pending' THEN RAISE EXCEPTION 'ADJUSTMENT_NOT_PENDING'; END IF;

  FOR line IN
    SELECT * FROM stock_adjustment_lines WHERE adjustment_id = p_adjustment_id ORDER BY variant_id
  LOOP
    INSERT INTO stock_balances (business_id, variant_id, location_id)
    VALUES (adjustment.business_id, line.variant_id, adjustment.location_id)
    ON CONFLICT (variant_id, location_id) DO NOTHING;

    SELECT on_hand, avg_cost_paisa INTO on_hand_now, average_now FROM stock_balances
    WHERE variant_id = line.variant_id AND location_id = adjustment.location_id FOR UPDATE;

    IF on_hand_now + line.qty_base_delta < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT: variant % has % on hand', line.variant_id, on_hand_now;
    END IF;

    INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, unit_cost_paisa, doc_type, doc_id, created_by)
    VALUES (
      adjustment.business_id, line.variant_id, adjustment.location_id, line.qty_base_delta,
      CASE WHEN line.qty_base_delta > 0 THEN line.unit_cost_paisa ELSE average_now END,
      'stock_adjustment', adjustment.id, p_actor
    );
  END LOOP;

  UPDATE stock_adjustments
  SET status = 'approved', approved_by = p_actor, approved_at = now(), updated_by = p_actor, updated_at = now()
  WHERE id = p_adjustment_id;
END;
$$;

-- ---------------------------------------------------------------- defaults for every business

-- Standard tax categories and units. Rates and FBR sale types are editable and are synced from FBR in v0.8.
CREATE FUNCTION seed_catalogue_defaults(p_business_id uuid, p_actor uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO tax_categories (business_id, name, kind, rate_bps, fbr_sale_type, created_by, updated_by) VALUES
    (p_business_id, 'Standard rate 18%', 'standard', 1800, 'Goods at standard rate (default)', p_actor, p_actor),
    (p_business_id, 'Reduced rate', 'reduced', 500, 'Goods at Reduced Rate', p_actor, p_actor),
    (p_business_id, 'Zero rated', 'zero_rated', 0, 'Goods at zero-rate', p_actor, p_actor),
    (p_business_id, 'Exempt', 'exempt', 0, 'Exempt goods', p_actor, p_actor),
    (p_business_id, 'Third schedule (retail price)', 'third_schedule', 1800, '3rd Schedule Goods', p_actor, p_actor)
  ON CONFLICT DO NOTHING;
  INSERT INTO units (business_id, name, short_name, created_by, updated_by) VALUES
    (p_business_id, 'Piece', 'pc', p_actor, p_actor),
    (p_business_id, 'Pack', 'pack', p_actor, p_actor),
    (p_business_id, 'Dozen', 'dz', p_actor, p_actor),
    (p_business_id, 'Carton', 'ctn', p_actor, p_actor),
    (p_business_id, 'Box', 'box', p_actor, p_actor),
    (p_business_id, 'Kilogram', 'kg', p_actor, p_actor),
    (p_business_id, 'Metre', 'm', p_actor, p_actor),
    (p_business_id, 'Litre', 'l', p_actor, p_actor)
  ON CONFLICT DO NOTHING;
$$;

SELECT seed_catalogue_defaults(b.id, (SELECT u.id FROM users u WHERE u.business_id = b.id ORDER BY u.created_at LIMIT 1))
FROM businesses b;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('catalog.view', 'View products, categories, brands, units and price lists'),
  ('catalog.manage', 'Create, update and archive products, categories, brands, tax categories and price lists'),
  ('products.cost.view', 'See product cost prices and stock valuation'),
  ('products.import', 'Import products and prices from CSV'),
  ('products.export', 'Export products and prices to CSV'),
  ('inventory.view', 'View stock levels and the stock ledger'),
  ('inventory.adjust', 'Request stock adjustments'),
  ('inventory.approve', 'Approve or reject stock adjustments above the approval threshold'),
  ('inventory.opening_stock', 'Import opening stock')
ON CONFLICT (key) DO NOTHING;

-- Existing businesses: the Owner gets every new key, the Manager the same, the Cashier read access.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('catalog.view'), ('catalog.manage'), ('products.cost.view'), ('products.import'), ('products.export'),
  ('inventory.view'), ('inventory.adjust'), ('inventory.approve'), ('inventory.opening_stock')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('catalog.view'), ('inventory.view')) AS k(key)
WHERE r.is_system AND r.name = 'Cashier'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- row-level security (second line of defence)

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustment_lines ENABLE ROW LEVEL SECURITY;
