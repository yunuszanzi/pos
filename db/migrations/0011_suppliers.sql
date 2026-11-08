-- v0.5 slice 1: suppliers, their ledger and opening payables (technical-plan 3.1; FR-PUR-01, FR-PUR-06). API-only like the rest.

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  contact_person text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  whatsapp text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  ntn text,
  strn text,
  registered boolean NOT NULL DEFAULT false,
  -- Days we have to pay a bill; 0 means due on receipt.
  terms_days integer NOT NULL DEFAULT 0 CHECK (terms_days BETWEEN 0 AND 365),
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  -- What WE owe the supplier (positive), or what they owe us (negative: a credit with them). Written only by the party_ledger
  -- trigger, so it can always be rebuilt from the ledger. The reverse sign of a customer's balance, which is what they owe us.
  balance_paisa bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX suppliers_name_uidx ON suppliers (business_id, lower(btrim(name)));

-- The ledger learns the supplier documents; the cached balance follows entries for suppliers as it does for customers.
ALTER TABLE party_ledger DROP CONSTRAINT party_ledger_doc_type_check;
ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_doc_type_check CHECK (doc_type IN (
  'sales_invoice', 'customer_payment', 'sales_return', 'opening_balance', 'adjustment', 'cheque_bounce',
  'purchase_bill', 'supplier_payment', 'purchase_return'));

CREATE OR REPLACE FUNCTION apply_party_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_type = 'customer' THEN
    PERFORM set_config('pos.ledger_write', 'on', true);
    UPDATE customers SET balance_paisa = balance_paisa + NEW.debit_paisa - NEW.credit_paisa
    WHERE id = NEW.party_id AND business_id = NEW.business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: customer % does not exist in this business', NEW.party_id; END IF;
    PERFORM set_config('pos.ledger_write', 'off', true);
  ELSIF NEW.party_type = 'supplier' THEN
    PERFORM set_config('pos.ledger_write', 'on', true);
    UPDATE suppliers SET balance_paisa = balance_paisa + NEW.credit_paisa - NEW.debit_paisa
    WHERE id = NEW.party_id AND business_id = NEW.business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: supplier % does not exist in this business', NEW.party_id; END IF;
    PERFORM set_config('pos.ledger_write', 'off', true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_supplier_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_paisa <> OLD.balance_paisa AND coalesce(current_setting('pos.ledger_write', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'a supplier balance is changed only by the ledger';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER suppliers_guard_balance BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION guard_supplier_balance();

CREATE TYPE supplier_opening_input AS (supplier_id uuid, amount_paisa bigint, as_of date, note text);

-- Loads what the shop owed each supplier on the day it moved to this system. Positive amounts are owed to the supplier (a
-- credit in the ledger), negative are credit we hold with them. All or nothing, once per supplier, as for customers.
CREATE FUNCTION post_supplier_opening_balances(p jsonb, p_actor uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_batch uuid := gen_random_uuid();
  v_count integer := 0;
  line record;
BEGIN
  FOR line IN SELECT * FROM jsonb_populate_recordset(NULL::supplier_opening_input, p->'lines') ORDER BY supplier_id LOOP
    IF line.amount_paisa IS NULL OR line.amount_paisa = 0 THEN RAISE EXCEPTION 'INVALID_OPENING_BALANCE: a balance must not be zero'; END IF;
    PERFORM 1 FROM suppliers WHERE id = line.supplier_id AND business_id = v_business AND active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SUPPLIER: a supplier is not available'; END IF;
    IF EXISTS (SELECT 1 FROM party_ledger WHERE business_id = v_business AND party_type = 'supplier' AND party_id = line.supplier_id) THEN
      RAISE EXCEPTION 'OPENING_BALANCE_EXISTS: a supplier already has entries in their ledger';
    END IF;
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, credit_paisa, entry_at, created_by)
    VALUES (v_business, 'supplier', line.supplier_id, 'opening_balance', v_batch, 'OPENING',
            coalesce(nullif(line.note, ''), 'Opening balance'),
            greatest(-line.amount_paisa, 0), greatest(line.amount_paisa, 0),
            (line.as_of::timestamp AT TIME ZONE coalesce((SELECT timezone FROM business_settings WHERE business_id = v_business), 'Asia/Karachi')),
            p_actor);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

INSERT INTO permissions (key, description) VALUES
  ('suppliers.view', 'View suppliers (name, contact, terms)'),
  ('suppliers.manage', 'Add, edit and archive suppliers; load opening payables'),
  ('suppliers.ledger', 'View what the shop owes a supplier: balance, ledger and ageing')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('suppliers.view'), ('suppliers.manage'), ('suppliers.ledger')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
