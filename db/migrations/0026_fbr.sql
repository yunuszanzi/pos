-- v0.8 slice 1: FBR integration (SRS section 4). API-only like the rest. Nothing here talks to FBR; this is where its settings, its
-- answers and the queue of invoices waiting to be reported are kept.
--
-- fbr_config:      one row a business: on or off, which channel, sandbox or production, the seller's details, the encrypted token.
-- fbr_reference_data: FBR's own lists (provinces, HS codes, units, sale types) as last synced, so a screen can check a code is real.
-- fbr_submissions: one row for each invoice or return that has to be reported, with its state; the document id makes it unique, so the
--                  same document can never be queued, and so never reported, twice (FR-FBR-14).
-- fbr_attempts:    every request and answer, append-only, kept for the 6 years FBR record-keeping needs (FR-FBR-15, section 4.5).

CREATE TABLE fbr_config (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'di' CHECK (mode IN ('di', 'pos', 'both')),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  seller_ntn text NOT NULL DEFAULT '',
  seller_strn text NOT NULL DEFAULT '',
  seller_name text NOT NULL DEFAULT '',
  seller_province text NOT NULL DEFAULT '',
  seller_address text NOT NULL DEFAULT '',
  -- AES-256-GCM, written by the server with a key that is not in the database (see server/fbr/crypto.ts). Never sent to a browser.
  token_encrypted text,
  token_hint text,
  token_set_at timestamptz,
  -- How long after posting an invoice FBR still lets it be cancelled or edited (FR-FBR-17). A setting because FBR changes it.
  cancel_window_hours integer NOT NULL DEFAULT 72 CHECK (cancel_window_hours BETWEEN 0 AND 8760),
  -- An unregistered buyer must be identified once a sale reaches this much (FR-FBR-10). A setting; confirm the figure with the tax advisor.
  buyer_id_threshold_paisa bigint NOT NULL DEFAULT 5000000 CHECK (buyer_id_threshold_paisa >= 0),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text,
  last_sync_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE fbr_reference_data (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('province', 'hs_code', 'uom', 'sale_type')),
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, kind, code)
);
CREATE INDEX fbr_reference_search_idx ON fbr_reference_data (business_id, kind, lower(description));

CREATE TABLE fbr_scenario_runs (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  passed boolean NOT NULL,
  message text NOT NULL DEFAULT '',
  environment text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ran_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (business_id, scenario_id)
);

CREATE TABLE fbr_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('sales_invoice', 'sales_return')),
  doc_id uuid NOT NULL,
  number text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('di', 'pos')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- pending: to be sent or sent again. accepted: FBR gave it a number. rejected: FBR refused it. failed: given up. skipped: not reportable.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  -- Held while one process is working on it, so two retry jobs never send the same invoice at the same moment.
  claimed_until timestamptz,
  payload jsonb,
  response jsonb,
  irn text,
  qr_data text,
  ref_irn text,
  error_code text,
  error_message text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, doc_type, doc_id),
  CHECK ((status = 'accepted') = (irn IS NOT NULL))
);
CREATE INDEX fbr_submissions_due_idx ON fbr_submissions (next_retry_at) WHERE status = 'pending';
CREATE INDEX fbr_submissions_status_idx ON fbr_submissions (business_id, status, created_at DESC);
CREATE UNIQUE INDEX fbr_submissions_irn_uidx ON fbr_submissions (business_id, irn) WHERE irn IS NOT NULL;

CREATE FUNCTION protect_fbr_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an FBR submission is kept for six years and cannot be deleted'; END IF;
  -- Once FBR has accepted an invoice, its number and what was sent are history.
  IF OLD.status = 'accepted' AND (NEW.status <> 'accepted' OR NEW.irn IS DISTINCT FROM OLD.irn OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.doc_id <> OLD.doc_id) THEN
    RAISE EXCEPTION 'an invoice FBR has accepted cannot be changed or reported again';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fbr_submissions_protect BEFORE UPDATE OR DELETE ON fbr_submissions FOR EACH ROW EXECUTE FUNCTION protect_fbr_submission();

CREATE TABLE fbr_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES fbr_submissions(id),
  attempt_no integer NOT NULL,
  step text NOT NULL CHECK (step IN ('local', 'validate', 'post')),
  outcome text NOT NULL,
  http_status integer,
  message text NOT NULL DEFAULT '',
  request jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fbr_attempts_submission_idx ON fbr_attempts (submission_id, created_at);

CREATE FUNCTION deny_fbr_attempt_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the FBR log is append-only';
END;
$$;
CREATE TRIGGER fbr_attempts_immutable BEFORE UPDATE OR DELETE ON fbr_attempts FOR EACH ROW EXECUTE FUNCTION deny_fbr_attempt_change();

-- ---------------------------------------------------------------- what FBR needs to know that we did not keep

-- A counter can opt out while the business is on (FR-FBR: switchable per business and per terminal). fbr_pos_id already exists.
ALTER TABLE terminals ADD COLUMN fbr_enabled boolean NOT NULL DEFAULT true;
-- The buyer's province (DI asks for it). A walk-in has none and takes the seller's.
ALTER TABLE customers ADD COLUMN province text NOT NULL DEFAULT '';
-- Reduced-rate and exempt goods name their SRO schedule and item.
ALTER TABLE tax_categories ADD COLUMN fbr_sro_schedule_no text, ADD COLUMN fbr_sro_item_serial_no text;

-- Where an invoice or return stands with FBR, and the number it was given: copied from the submission so a reprint needs no join.
ALTER TABLE sales_invoices ADD COLUMN fbr_status text CHECK (fbr_status IN ('pending', 'accepted', 'rejected', 'failed', 'skipped')),
  ADD COLUMN fbr_irn text, ADD COLUMN fbr_qr text, ADD COLUMN fbr_at timestamptz;
ALTER TABLE sales_returns ADD COLUMN fbr_status text CHECK (fbr_status IN ('pending', 'accepted', 'rejected', 'failed', 'skipped')),
  ADD COLUMN fbr_irn text, ADD COLUMN fbr_qr text, ADD COLUMN fbr_at timestamptz;

-- Posted documents still never change, except for these four columns (and a line's returned quantity, as before).
CREATE OR REPLACE FUNCTION protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sales_invoice_lines' AND (to_jsonb(NEW) - 'returned_qty_base') = (to_jsonb(OLD) - 'returned_qty_base') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('sales_invoices', 'sales_returns')
     AND (to_jsonb(NEW) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') = (to_jsonb(OLD) - 'fbr_status' - 'fbr_irn' - 'fbr_qr' - 'fbr_at') THEN
    -- A number FBR has given is final.
    IF OLD.fbr_irn IS NOT NULL AND NEW.fbr_irn IS DISTINCT FROM OLD.fbr_irn THEN RAISE EXCEPTION 'the FBR number of a posted document cannot be changed'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted % cannot be changed or deleted; record a return instead', replace(TG_TABLE_NAME, '_', ' ');
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('fbr.view', 'See the FBR log, each invoice''s FBR status and the reconciliation'),
  ('fbr.resubmit', 'Send an invoice or return to FBR again after fixing what was wrong'),
  ('fbr.manage', 'Change the FBR settings: switch it on, the token, the environment, the mappings (Owner)')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r CROSS JOIN (VALUES ('fbr.view'), ('fbr.resubmit')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
-- Only the owner touches the credentials.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'fbr.manage' FROM roles r WHERE r.is_system AND r.name = 'Owner'
ON CONFLICT DO NOTHING;

ALTER TABLE fbr_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE fbr_reference_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE fbr_scenario_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fbr_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fbr_attempts ENABLE ROW LEVEL SECURITY;
