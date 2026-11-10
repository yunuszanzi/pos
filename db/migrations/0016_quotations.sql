-- v0.6 slice 1: quotations (FR-QUO-01..05). API-only like the rest.
--
-- A quotation is a working document: it touches neither stock nor any ledger (FR-QUO-02). Amounts are worked out by the shared
-- pricing code and stored like a sales invoice's, so converting a quotation later keeps the quoted prices whatever the price
-- list says by then. A draft can be changed (its lines are replaced); once sent it is fixed, and a change is a new REVISION:
-- the same number with the next revision number, the old one kept as history (status 'revised').
--
-- Statuses: draft, sent, accepted, rejected, converted, revised. "Expired" is never stored: a sent quotation whose validity date
-- has passed reads as expired (the API works it out), so no job has to run at midnight.

CREATE TABLE quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  revision_no integer NOT NULL DEFAULT 1 CHECK (revision_no > 0),
  -- The first revision of this quotation (itself for revision 1).
  root_id uuid NOT NULL,
  -- Set on a revision that a later one replaced.
  superseded_by uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'converted', 'revised')),
  -- A registered customer, or a prospect who is only a name and a phone.
  customer_id uuid,
  prospect_name text NOT NULL DEFAULT '',
  prospect_phone text NOT NULL DEFAULT '',
  quote_date date NOT NULL DEFAULT current_date,
  valid_until date NOT NULL,
  terms text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  tax_mode text NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  gross_paisa bigint NOT NULL DEFAULT 0 CHECK (gross_paisa >= 0),
  line_discount_paisa bigint NOT NULL DEFAULT 0 CHECK (line_discount_paisa >= 0),
  invoice_discount_paisa bigint NOT NULL DEFAULT 0 CHECK (invoice_discount_paisa >= 0),
  taxable_paisa bigint NOT NULL DEFAULT 0 CHECK (taxable_paisa >= 0),
  tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  rounding_paisa bigint NOT NULL DEFAULT 0,
  total_paisa bigint NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number, revision_no),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  CHECK (customer_id IS NOT NULL OR prospect_name <> ''),
  CHECK (valid_until >= quote_date),
  CHECK (total_paisa = gross_paisa - line_discount_paisa - invoice_discount_paisa
    + CASE WHEN tax_mode = 'exclusive' THEN tax_paisa ELSE 0 END + rounding_paisa)
);
CREATE INDEX quotations_status_idx ON quotations (business_id, status, quote_date DESC);
CREATE INDEX quotations_customer_idx ON quotations (business_id, customer_id, quote_date DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX quotations_root_idx ON quotations (root_id, revision_no);

CREATE TABLE quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  quotation_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
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
  -- How much of the line an order or invoice has taken up (slice 2). The only column that changes once the quotation is sent.
  converted_base numeric(14,3) NOT NULL DEFAULT 0 CHECK (converted_base >= 0 AND converted_base <= qty_base),
  UNIQUE (id, business_id),
  UNIQUE (quotation_id, line_no),
  FOREIGN KEY (quotation_id, business_id) REFERENCES quotations(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, business_id) REFERENCES product_variants(id, business_id),
  FOREIGN KEY (unit_id, business_id) REFERENCES units(id, business_id),
  CHECK (qty_base = qty_entered * factor_to_base),
  CHECK (net_paisa = gross_paisa - line_discount_paisa - invoice_discount_share_paisa),
  CHECK (total_paisa = net_paisa + CASE WHEN tax_included THEN 0 ELSE tax_paisa END),
  CHECK (taxable_paisa = net_paisa - CASE WHEN tax_included THEN tax_paisa ELSE 0 END)
);

-- After it is sent a quotation is a record of what was offered: only its status (and the revision link) may move, and a line
-- may only gain converted quantity.
CREATE FUNCTION protect_sent_quotation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'quotations' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a quotation that was sent cannot be deleted'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status <> 'draft'
       AND (to_jsonb(NEW) - 'status' - 'superseded_by' - 'updated_at' - 'updated_by') <> (to_jsonb(OLD) - 'status' - 'superseded_by' - 'updated_at' - 'updated_by') THEN
      RAISE EXCEPTION 'a quotation that was sent cannot be changed; revise it instead';
    END IF;
    RETURN NEW;
  END IF;
  -- quotation_lines
  SELECT status INTO v_status FROM quotations WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.quotation_id ELSE OLD.quotation_id END;
  IF v_status IS NULL OR v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'converted_base') = (to_jsonb(OLD) - 'converted_base') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'the lines of a quotation that was sent cannot be changed; revise it instead';
END;
$$;
CREATE TRIGGER quotations_protect BEFORE UPDATE OR DELETE ON quotations FOR EACH ROW EXECUTE FUNCTION protect_sent_quotation();
CREATE TRIGGER quotation_lines_protect BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines FOR EACH ROW EXECUTE FUNCTION protect_sent_quotation();

-- Creates a draft quotation, or replaces the lines and details of an existing draft (p->>'id'). The number is taken when it is
-- created. Lines must be active SKUs of active products in a unit they really have (services may be quoted; a quotation never
-- moves stock). Amounts arrive worked out by the shared pricing code; this function checks that they add up.
CREATE FUNCTION save_quotation(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_customer uuid := nullif(p->>'customer_id', '')::uuid;
  v_prospect text := coalesce(nullif(trim(p->>'prospect_name'), ''), '');
  v_status text;
  v_number text;
  v_sequence integer;
  v_count integer;
  v_matched integer;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_date date := coalesce(nullif(p->>'quote_date', '')::date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_valid date := (p->>'valid_until')::date;
  sums record;
BEGIN
  PERFORM 1 FROM branches WHERE id = v_branch AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_BRANCH: this branch is not available'; END IF;
  IF v_customer IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_customer AND business_id = v_business AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: this customer is not available'; END IF;
  ELSIF v_prospect = '' THEN
    RAISE EXCEPTION 'INVALID_CUSTOMER: choose a customer or type the name of the person this is for';
  END IF;
  IF v_valid < v_date THEN RAISE EXCEPTION 'INVALID_DATE: the quotation cannot be valid until a day before it is dated'; END IF;
  IF v_valid < v_today THEN RAISE EXCEPTION 'INVALID_DATE: the validity date has already passed'; END IF;

  SELECT count(*) INTO v_count FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines');
  IF v_count = 0 THEN RAISE EXCEPTION 'INVALID_LINE: add at least one item'; END IF;
  SELECT count(*) INTO v_matched
  FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') l
  JOIN product_variants v ON v.id = l.variant_id AND v.business_id = v_business AND v.active
  JOIN products pr ON pr.id = v.product_id AND pr.active
  JOIN product_units pu ON pu.variant_id = l.variant_id AND pu.unit_id = l.unit_id AND pu.business_id = v_business AND pu.factor_to_base = l.factor_to_base
  WHERE l.qty_entered > 0 AND l.qty_base = l.qty_entered * l.factor_to_base;
  IF v_matched <> v_count THEN RAISE EXCEPTION 'INVALID_LINE: a line is not an active product sold in that unit'; END IF;

  SELECT sum(total_paisa) AS total, sum(gross_paisa) AS gross, sum(line_discount_paisa) AS line_discount,
         sum(invoice_discount_share_paisa) AS invoice_discount, sum(tax_paisa) AS tax, sum(taxable_paisa) AS taxable
  INTO sums FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines');
  IF sums.total + (p->>'rounding_paisa')::bigint <> (p->>'total_paisa')::bigint
     OR sums.gross <> (p->>'gross_paisa')::bigint
     OR sums.line_discount <> (p->>'line_discount_paisa')::bigint
     OR sums.invoice_discount <> (p->>'invoice_discount_paisa')::bigint
     OR sums.tax <> (p->>'tax_paisa')::bigint
     OR sums.taxable <> (p->>'taxable_paisa')::bigint THEN
    RAISE EXCEPTION 'QUOTATION_TOTAL_MISMATCH: the lines do not add up to the quotation';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
    SELECT v_business, b.id, 'quotation', 'QUO-' || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = v_branch AND b.business_id = v_business
    ON CONFLICT DO NOTHING;
    SELECT document_number, sequence_no INTO v_number, v_sequence FROM take_next_document_number(v_business, v_branch, 'quotation');
    v_id := gen_random_uuid();
    INSERT INTO quotations (id, business_id, branch_id, number, sequence_no, root_id, customer_id, prospect_name, prospect_phone, quote_date, valid_until,
      terms, note, tax_mode, gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa, created_by, updated_by)
    VALUES (v_id, v_business, v_branch, v_number, v_sequence, v_id, v_customer, CASE WHEN v_customer IS NULL THEN v_prospect ELSE '' END,
      CASE WHEN v_customer IS NULL THEN coalesce(p->>'prospect_phone', '') ELSE '' END, v_date, v_valid, coalesce(p->>'terms', ''), coalesce(p->>'note', ''),
      p->>'tax_mode', sums.gross, sums.line_discount, sums.invoice_discount, sums.taxable, sums.tax, (p->>'rounding_paisa')::bigint, (p->>'total_paisa')::bigint, p_actor, p_actor);
  ELSE
    SELECT status INTO v_status FROM quotations WHERE id = v_id AND business_id = v_business FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such quotation'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'QUOTATION_NOT_EDITABLE: only a draft can be changed; revise a quotation that was sent'; END IF;
    DELETE FROM quotation_lines WHERE quotation_id = v_id;
    UPDATE quotations SET customer_id = v_customer, prospect_name = CASE WHEN v_customer IS NULL THEN v_prospect ELSE '' END,
      prospect_phone = CASE WHEN v_customer IS NULL THEN coalesce(p->>'prospect_phone', '') ELSE '' END, quote_date = v_date, valid_until = v_valid,
      terms = coalesce(p->>'terms', ''), note = coalesce(p->>'note', ''), tax_mode = p->>'tax_mode', gross_paisa = sums.gross, line_discount_paisa = sums.line_discount,
      invoice_discount_paisa = sums.invoice_discount, taxable_paisa = sums.taxable, tax_paisa = sums.tax, rounding_paisa = (p->>'rounding_paisa')::bigint,
      total_paisa = (p->>'total_paisa')::bigint, updated_by = p_actor, updated_at = now()
    WHERE id = v_id;
  END IF;

  INSERT INTO quotation_lines (business_id, quotation_id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included, taxable_paisa, tax_paisa, total_paisa)
  SELECT v_business, v_id, row_number() OVER (ORDER BY ord), l.variant_id, l.unit_id, l.product_name, coalesce(l.variant_name, ''), l.sku, l.unit_name, l.hs_code,
         l.qty_entered, l.factor_to_base, l.qty_base, l.unit_price_paisa, l.gross_paisa, l.line_discount_paisa, l.invoice_discount_share_paisa, l.net_paisa,
         l.tax_rate_bps, l.tax_included, l.taxable_paisa, l.tax_paisa, l.total_paisa
  FROM jsonb_populate_recordset(NULL::sales_line_input, p->'lines') WITH ORDINALITY AS l(line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code,
    qty_entered, factor_to_base, qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included,
    taxable_paisa, tax_paisa, total_paisa, ord);
  RETURN v_id;
END;
$$;

-- draft -> sent; sent -> accepted or rejected (an accepted one only while it is still valid); a sent or accepted quotation
-- that nobody wants any more can be rejected too. Converting (slice 2) and revising have their own functions.
CREATE FUNCTION set_quotation_status(p_business uuid, p_quotation uuid, p_status text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_valid date;
BEGIN
  SELECT status, valid_until INTO v_status, v_valid FROM quotations WHERE id = p_quotation AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such quotation'; END IF;
  IF NOT ((v_status = 'draft' AND p_status = 'sent')
       OR (v_status = 'sent' AND p_status IN ('accepted', 'rejected'))
       OR (v_status = 'accepted' AND p_status = 'rejected')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % quotation cannot become %', v_status, p_status;
  END IF;
  IF p_status IN ('sent', 'accepted') AND v_valid < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'QUOTATION_EXPIRED: this quotation was valid until %; revise it with a new date', v_valid;
  END IF;
  UPDATE quotations SET status = p_status, updated_by = p_actor, updated_at = now() WHERE id = p_quotation;
END;
$$;

-- Starts the next revision of a quotation that was sent: a draft copy under the same number with the next revision number, and the
-- old one marked revised. The new revision's validity runs from today for as long as the old one lasted (at least a week).
CREATE FUNCTION revise_quotation(p_business uuid, p_quotation uuid, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  q quotations%ROWTYPE;
  v_new uuid := gen_random_uuid();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next integer;
BEGIN
  SELECT * INTO q FROM quotations WHERE id = p_quotation AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such quotation'; END IF;
  IF q.status NOT IN ('sent', 'accepted', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % quotation cannot be revised', q.status;
  END IF;
  SELECT max(revision_no) + 1 INTO v_next FROM quotations WHERE root_id = q.root_id AND business_id = p_business;
  INSERT INTO quotations (id, business_id, branch_id, number, sequence_no, revision_no, root_id, customer_id, prospect_name, prospect_phone, quote_date, valid_until,
    terms, note, tax_mode, gross_paisa, line_discount_paisa, invoice_discount_paisa, taxable_paisa, tax_paisa, rounding_paisa, total_paisa, created_by, updated_by)
  VALUES (v_new, p_business, q.branch_id, q.number, q.sequence_no, v_next, q.root_id, q.customer_id, q.prospect_name, q.prospect_phone, v_today,
    v_today + greatest(q.valid_until - q.quote_date, 7), q.terms, q.note, q.tax_mode, q.gross_paisa, q.line_discount_paisa, q.invoice_discount_paisa,
    q.taxable_paisa, q.tax_paisa, q.rounding_paisa, q.total_paisa, p_actor, p_actor);
  INSERT INTO quotation_lines (business_id, quotation_id, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included, taxable_paisa, tax_paisa, total_paisa)
  SELECT business_id, v_new, line_no, variant_id, unit_id, product_name, variant_name, sku, unit_name, hs_code, qty_entered, factor_to_base,
    qty_base, unit_price_paisa, gross_paisa, line_discount_paisa, invoice_discount_share_paisa, net_paisa, tax_rate_bps, tax_included, taxable_paisa, tax_paisa, total_paisa
  FROM quotation_lines WHERE quotation_id = p_quotation;
  UPDATE quotations SET status = 'revised', superseded_by = v_new, updated_by = p_actor, updated_at = now() WHERE id = p_quotation;
  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('quotations.view', 'View quotations'),
  ('quotations.manage', 'Write, send, revise, accept and reject quotations')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('quotations.view'), ('quotations.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_lines ENABLE ROW LEVEL SECURITY;
