-- v0.4 slice 5: customer cheques, including post-dated ones (FR-CUS-09). API-only like the rest: no grants to anon/authenticated (see 0001).
--
-- A cheque is money received, so it is recorded as a customer payment the day it is taken (the khata goes down and the oldest
-- invoices are settled) and carried through received -> deposited -> cleared. If it bounces, the payment is taken back: the
-- invoices it settled are open again and the khata goes back up, with new entries; nothing already posted is changed.

-- The ledger and the allocations learn about a bounce.
ALTER TABLE party_ledger DROP CONSTRAINT party_ledger_doc_type_check;
ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_doc_type_check
  CHECK (doc_type IN ('sales_invoice', 'customer_payment', 'sales_return', 'opening_balance', 'adjustment', 'cheque_bounce'));

-- A bounce undoes an allocation with a negative one, so an invoice's outstanding amount (balance - allocations) goes back up.
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_source_type_check;
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_amount_paisa_check;
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_source_type_check
  CHECK (source_type IN ('customer_payment', 'sales_return', 'cheque_bounce'));
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_amount_paisa_check
  CHECK ((source_type = 'cheque_bounce' AND amount_paisa < 0) OR (source_type <> 'cheque_bounce' AND amount_paisa > 0));

CREATE TABLE cheques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  -- The payment recorded when the cheque was taken.
  payment_id uuid NOT NULL,
  cheque_no text NOT NULL CHECK (length(btrim(cheque_no)) > 0),
  bank text NOT NULL CHECK (length(btrim(bank)) > 0),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  -- The date written on the cheque. In the future for a post-dated cheque.
  cheque_date date NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'deposited', 'cleared', 'bounced')),
  note text NOT NULL DEFAULT '',
  bounce_reason text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  deposited_at timestamptz,
  cleared_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id),
  FOREIGN KEY (payment_id, business_id) REFERENCES customer_payments(id, business_id),
  CHECK ((status = 'bounced') = (bounced_at IS NOT NULL))
);
-- The same cheque cannot be entered twice.
CREATE UNIQUE INDEX cheques_identity_idx ON cheques (business_id, lower(btrim(bank)), btrim(cheque_no));
CREATE INDEX cheques_status_idx ON cheques (business_id, status, cheque_date);
CREATE INDEX cheques_customer_idx ON cheques (business_id, customer_id, received_at DESC);

-- Takes a cheque from a customer in the caller's transaction: the payment (oldest invoices first), then the cheque row.
CREATE FUNCTION receive_cheque(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_method uuid;
  v_payment uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  -- Cheques are a payment method of their own, made the first time one is taken.
  INSERT INTO payment_methods (business_id, code, name, kind, sort_order, created_by, updated_by)
  VALUES (v_business, 'cheque', 'Cheque', 'bank', 6, p_actor, p_actor) ON CONFLICT DO NOTHING;
  SELECT id INTO v_method FROM payment_methods WHERE business_id = v_business AND code = 'cheque' AND active;
  IF v_method IS NULL THEN RAISE EXCEPTION 'INVALID_PAYMENT: the Cheque payment method is switched off'; END IF;

  v_payment := post_customer_payment(jsonb_build_object(
    'business_id', v_business, 'branch_id', p->>'branch_id', 'customer_id', p->>'customer_id', 'method_id', v_method,
    'amount_paisa', (p->>'amount_paisa')::bigint, 'reference', 'Cheque ' || (p->>'cheque_no') || ', ' || (p->>'bank'),
    'note', coalesce(p->>'note', ''), 'allocate', 'oldest'), p_actor);

  INSERT INTO cheques (id, business_id, branch_id, customer_id, payment_id, cheque_no, bank, amount_paisa, cheque_date, note, created_by, updated_by)
  VALUES (v_id, v_business, (p->>'branch_id')::uuid, (p->>'customer_id')::uuid, v_payment, btrim(p->>'cheque_no'), btrim(p->>'bank'),
          (p->>'amount_paisa')::bigint, (p->>'cheque_date')::date, coalesce(p->>'note', ''), p_actor, p_actor);
  RETURN v_id;
END;
$$;

-- Moves a cheque on: received -> deposited -> cleared, or bounced from received or deposited. A bounce takes the payment back.
-- The cheque and then the customer are locked first, so a bounce and a payment for the same customer queue up.
CREATE FUNCTION set_cheque_status(p_business uuid, p_cheque uuid, p_status text, p_reason text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  chq record;
  taken record;
BEGIN
  SELECT * INTO chq FROM cheques WHERE id = p_cheque AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such cheque'; END IF;
  PERFORM 1 FROM customers WHERE id = chq.customer_id AND business_id = p_business FOR UPDATE;

  IF NOT ((chq.status = 'received' AND p_status IN ('deposited', 'bounced'))
       OR (chq.status = 'deposited' AND p_status IN ('cleared', 'bounced'))) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % cheque cannot become %', chq.status, p_status;
  END IF;

  IF p_status = 'bounced' THEN
    IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'REASON_REQUIRED: say why the cheque bounced'; END IF;
    FOR taken IN SELECT invoice_id, amount_paisa FROM payment_allocations WHERE business_id = p_business AND source_type = 'customer_payment' AND source_id = chq.payment_id LOOP
      INSERT INTO payment_allocations (business_id, source_type, source_id, invoice_id, amount_paisa)
      VALUES (p_business, 'cheque_bounce', chq.id, taken.invoice_id, -taken.amount_paisa);
    END LOOP;
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, created_by)
    VALUES (p_business, 'customer', chq.customer_id, 'cheque_bounce', chq.id, chq.cheque_no, 'Cheque bounced', chq.amount_paisa, p_actor);
  END IF;

  UPDATE cheques SET status = p_status, updated_by = p_actor, updated_at = now(),
    deposited_at = CASE WHEN p_status = 'deposited' THEN now() ELSE deposited_at END,
    cleared_at = CASE WHEN p_status = 'cleared' THEN now() ELSE cleared_at END,
    bounced_at = CASE WHEN p_status = 'bounced' THEN now() ELSE bounced_at END,
    bounce_reason = CASE WHEN p_status = 'bounced' THEN btrim(p_reason) ELSE bounce_reason END
  WHERE id = chq.id;
END;
$$;

INSERT INTO permissions (key, description) VALUES
  ('customers.cheques', 'Deposit cheques and mark them cleared or bounced')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'customers.cheques' FROM roles r WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE cheques ENABLE ROW LEVEL SECURITY;
