-- v0.4 slice 1: customers, groups, areas and price tiers (technical-plan 3.1; FR-CUS-01, 07, FR-SAL-03). API-only like the rest.

CREATE TABLE areas (
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
CREATE UNIQUE INDEX areas_name_uidx ON areas (business_id, lower(name));

-- A group can carry a price list, so "all wholesalers" get their tier without setting it on each customer.
CREATE TABLE customer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  price_list_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (price_list_id, business_id) REFERENCES price_lists(id, business_id)
);
CREATE UNIQUE INDEX customer_groups_name_uidx ON customer_groups (business_id, lower(name));

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  business_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  phone2 text NOT NULL DEFAULT '',
  whatsapp text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  area_id uuid,
  group_id uuid,
  -- 13 digits, stored without dashes. Never sent to a till's cache (technical-plan 5.7).
  cnic text CHECK (cnic IS NULL OR cnic ~ '^[0-9]{13}$'),
  ntn text,
  strn text,
  registered boolean NOT NULL DEFAULT false,
  -- The customer's own tier; empty means the group's, then the shelf price.
  price_list_id uuid,
  -- 0 means no credit: the customer pays in full.
  credit_limit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_limit_paisa >= 0),
  -- Days an invoice may stay unpaid before the customer counts as overdue; 0 means no terms.
  terms_days integer NOT NULL DEFAULT 0 CHECK (terms_days BETWEEN 0 AND 365),
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  -- The dataset version this row last changed at, for the till's delta sync.
  change_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (area_id, business_id) REFERENCES areas(id, business_id),
  FOREIGN KEY (group_id, business_id) REFERENCES customer_groups(id, business_id),
  FOREIGN KEY (price_list_id, business_id) REFERENCES price_lists(id, business_id)
);
CREATE INDEX customers_business_name_idx ON customers (business_id, lower(name));
CREATE INDEX customers_change_version_idx ON customers (business_id, change_version);
CREATE UNIQUE INDEX customers_cnic_uidx ON customers (business_id, cnic) WHERE cnic IS NOT NULL;

CREATE FUNCTION stamp_customer_change_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_version := next_data_version(NEW.business_id, 'customers');
  RETURN NEW;
END;
$$;
CREATE TRIGGER customers_stamp_version BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION stamp_customer_change_version();

-- A group's tier change must reach the till: touch the customers that depend on it.
CREATE FUNCTION touch_customers_of_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE customers SET updated_at = updated_at WHERE group_id = NEW.id AND business_id = NEW.business_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_groups_touch_customers AFTER UPDATE ON customer_groups FOR EACH ROW EXECUTE FUNCTION touch_customers_of_group();

CREATE TRIGGER areas_version AFTER INSERT OR UPDATE OR DELETE ON areas FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');
CREATE TRIGGER customer_groups_version AFTER INSERT OR UPDATE OR DELETE ON customer_groups FOR EACH ROW EXECUTE FUNCTION bump_dataset_version('reference');

-- Walk-in sales keep a null customer; a named customer must belong to the same business.
ALTER TABLE sales_invoices
  ADD CONSTRAINT sales_invoices_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id);

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('customers.view', 'View customers (name, phone, tier, credit limit)'),
  ('customers.create', 'Add a customer (for example from the till)'),
  ('customers.manage', 'Edit and archive customers, groups and areas; see CNIC')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('customers.view'), ('customers.create'), ('customers.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('customers.view'), ('customers.create')) AS k(key)
WHERE r.is_system AND r.name = 'Cashier'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
