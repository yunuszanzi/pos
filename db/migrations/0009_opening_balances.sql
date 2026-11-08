-- v0.4 slice 4: customer opening balances (FR-CUS-06). API-only like the rest: no grants to anon/authenticated (see 0001).

CREATE TYPE opening_balance_input AS (customer_id uuid, amount_paisa bigint, as_of date, note text);

-- Loads what customers owed on the day the shop moved to this system, as ledger entries dated that day. Positive amounts are
-- owed by the customer (debit), negative are credit we hold for them (credit). All or nothing in the caller's transaction.
-- Each customer is locked first, and one that already has any ledger entry is refused: an opening balance is a starting
-- point, and changing a balance after that is an adjustment or a payment, never a second opening.
CREATE FUNCTION post_opening_balances(p jsonb, p_actor uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_batch uuid := gen_random_uuid();
  v_count integer := 0;
  line record;
BEGIN
  FOR line IN SELECT * FROM jsonb_populate_recordset(NULL::opening_balance_input, p->'lines') ORDER BY customer_id LOOP
    IF line.amount_paisa IS NULL OR line.amount_paisa = 0 THEN RAISE EXCEPTION 'INVALID_OPENING_BALANCE: a balance must not be zero'; END IF;
    PERFORM 1 FROM customers WHERE id = line.customer_id AND business_id = v_business AND active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CUSTOMER: a customer is not available'; END IF;
    IF EXISTS (SELECT 1 FROM party_ledger WHERE business_id = v_business AND party_type = 'customer' AND party_id = line.customer_id) THEN
      RAISE EXCEPTION 'OPENING_BALANCE_EXISTS: a customer already has entries in their khata';
    END IF;
    -- Dated the start of that day in the business's time zone, so a statement for the month after it opens with this balance.
    INSERT INTO party_ledger (business_id, party_type, party_id, doc_type, doc_id, doc_number, memo, debit_paisa, credit_paisa, entry_at, created_by)
    VALUES (v_business, 'customer', line.customer_id, 'opening_balance', v_batch, 'OPENING',
            coalesce(nullif(line.note, ''), 'Opening balance'),
            greatest(line.amount_paisa, 0), greatest(-line.amount_paisa, 0),
            (line.as_of::timestamp AT TIME ZONE coalesce((SELECT timezone FROM business_settings WHERE business_id = v_business), 'Asia/Karachi')),
            p_actor);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
