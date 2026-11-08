-- v0.5 slice 5: the supplier each SKU is normally bought from, so the reorder list can group its draft orders (FR-PUR-07).
-- API-only like the rest: no grants to anon/authenticated (see 0001).

CREATE TABLE preferred_suppliers (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  variant_id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id)
);
CREATE INDEX preferred_suppliers_supplier_idx ON preferred_suppliers (business_id, supplier_id);

ALTER TABLE preferred_suppliers ENABLE ROW LEVEL SECURITY;
