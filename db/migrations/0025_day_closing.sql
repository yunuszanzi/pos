-- v0.7 slice 3: day-end closing per branch (FR-CSH-07). API-only like the rest.
--
-- Closing a day writes down what the branch did that day (Karachi time): every shift with its float, expected cash, count and difference;
-- sales, returns, what came in and went out by each way of paying, expenses by category. The summary is worked out INSIDE the closing
-- function in the closing transaction, so it cannot disagree with the ledgers it summarises. It is refused while a shift is still open.
-- Once a day is closed the branch cannot open a new shift on it (so no sale can land after the figures were written) and no expense can
-- be dated into it. A closing is a record and never changes; if it was a mistake it is REOPENED (with a reason, kept on the record) and the
-- day can be closed again, which writes a new record.

CREATE TABLE day_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  business_date date NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  summary jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reopened_at timestamptz,
  reopened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reopen_reason text,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  CHECK ((reopened_at IS NULL) = (reopened_by IS NULL) AND (reopened_at IS NULL) = (reopen_reason IS NULL))
);
-- One live closing a day for a branch; a reopened one stays on record beside the new one.
CREATE UNIQUE INDEX day_closings_live_uidx ON day_closings (branch_id, business_date) WHERE reopened_at IS NULL;
CREATE INDEX day_closings_date_idx ON day_closings (business_id, business_date DESC);

CREATE FUNCTION protect_day_closing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a day closing cannot be deleted'; END IF;
  IF OLD.reopened_at IS NULL AND NEW.reopened_at IS NOT NULL
     AND (to_jsonb(NEW) - 'reopened_at' - 'reopened_by' - 'reopen_reason') = (to_jsonb(OLD) - 'reopened_at' - 'reopened_by' - 'reopen_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a day closing cannot be changed; reopen it and close the day again';
END;
$$;
CREATE TRIGGER day_closings_protect BEFORE UPDATE OR DELETE ON day_closings FOR EACH ROW EXECUTE FUNCTION protect_day_closing();

-- What a branch did on a Karachi day, as one JSON document. Used for the preview and, in the closing transaction, for the record.
CREATE FUNCTION day_summary(p_business uuid, p_branch uuid, p_date date) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH
    bounds AS (SELECT (p_date::timestamp AT TIME ZONE 'Asia/Karachi') AS start_at, ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Karachi') AS end_at),
    shift_rows AS (
      SELECT s.id, t.name AS terminal, coalesce(u.display_name, '') AS opened_by, s.opened_at, s.closed_at, s.status,
             s.opening_float_paisa AS float_paisa, s.expected_paisa, s.counted_paisa, s.variance_paisa
      FROM shifts s JOIN terminals t ON t.id = s.terminal_id LEFT JOIN users u ON u.id = s.opened_by, bounds b
      WHERE s.business_id = p_business AND s.branch_id = p_branch AND s.opened_at >= b.start_at AND s.opened_at < b.end_at
    ),
    sales AS (
      SELECT count(*)::int AS bills, coalesce(sum(i.total_paisa), 0)::bigint AS total, coalesce(sum(i.tax_paisa), 0)::bigint AS tax,
             coalesce(sum(i.line_discount_paisa + i.invoice_discount_paisa), 0)::bigint AS discount, coalesce(sum(i.balance_paisa), 0)::bigint AS credit,
             count(*) FILTER (WHERE i.channel = 'back_office')::int AS desk_bills
      FROM sales_invoices i, bounds b WHERE i.business_id = p_business AND i.branch_id = p_branch AND i.posted_at >= b.start_at AND i.posted_at < b.end_at
    ),
    returns AS (
      SELECT count(*)::int AS returns, coalesce(sum(r.total_paisa), 0)::bigint AS total, coalesce(sum(r.refund_paisa), 0)::bigint AS refunded
      FROM sales_returns r, bounds b WHERE r.business_id = p_business AND r.branch_id = p_branch AND r.posted_at >= b.start_at AND r.posted_at < b.end_at
    ),
    pay_sales AS (SELECT p.method_name AS m, sum(p.amount_paisa)::bigint AS amt FROM payments p JOIN sales_invoices i ON i.id = p.invoice_id, bounds b
      WHERE i.business_id = p_business AND i.branch_id = p_branch AND i.posted_at >= b.start_at AND i.posted_at < b.end_at GROUP BY 1),
    pay_in AS (SELECT c.method_name AS m, sum(c.amount_paisa)::bigint AS amt FROM customer_payments c, bounds b
      WHERE c.business_id = p_business AND c.branch_id = p_branch AND c.posted_at >= b.start_at AND c.posted_at < b.end_at GROUP BY 1),
    pay_out AS (SELECT sp.method_name AS m, sum(sp.amount_paisa)::bigint AS amt FROM supplier_payments sp, bounds b
      WHERE sp.business_id = p_business AND sp.branch_id = p_branch AND sp.posted_at >= b.start_at AND sp.posted_at < b.end_at GROUP BY 1),
    pay_refund AS (SELECT r.refund_method_name AS m, sum(r.refund_paisa)::bigint AS amt FROM sales_returns r, bounds b
      WHERE r.business_id = p_business AND r.branch_id = p_branch AND r.refund_paisa > 0 AND r.posted_at >= b.start_at AND r.posted_at < b.end_at GROUP BY 1),
    methods AS (SELECT m FROM pay_sales UNION SELECT m FROM pay_in UNION SELECT m FROM pay_out UNION SELECT m FROM pay_refund),
    spent AS (
      SELECT c.name AS category, count(*)::int AS expenses, sum(e.amount_paisa)::bigint AS amount
      FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.business_id = p_business AND e.branch_id = p_branch AND e.expense_date = p_date AND e.reversed_at IS NULL GROUP BY c.id
    )
  SELECT jsonb_build_object(
    'date', p_date,
    'shifts', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'terminal', terminal, 'openedBy', opened_by, 'openedAt', opened_at, 'closedAt', closed_at, 'status', status,
        'openingFloatPaisa', float_paisa, 'expectedPaisa', expected_paisa, 'countedPaisa', counted_paisa, 'variancePaisa', variance_paisa) ORDER BY opened_at) FROM shift_rows), '[]'::jsonb),
    'cashVariancePaisa', coalesce((SELECT sum(variance_paisa) FROM shift_rows), 0),
    'sales', (SELECT jsonb_build_object('bills', bills, 'totalPaisa', total, 'taxPaisa', tax, 'discountPaisa', discount, 'creditPaisa', credit, 'deskBills', desk_bills) FROM sales),
    'returns', (SELECT jsonb_build_object('count', returns, 'totalPaisa', total, 'refundedPaisa', refunded) FROM returns),
    'byMethod', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'method', m.m, 'salesPaisa', coalesce(s.amt, 0), 'receiptsPaisa', coalesce(i.amt, 0), 'paidOutPaisa', coalesce(o.amt, 0), 'refundsPaisa', coalesce(f.amt, 0)) ORDER BY m.m)
      FROM methods m LEFT JOIN pay_sales s ON s.m = m.m LEFT JOIN pay_in i ON i.m = m.m LEFT JOIN pay_out o ON o.m = m.m LEFT JOIN pay_refund f ON f.m = m.m), '[]'::jsonb),
    'expenses', jsonb_build_object(
      'count', coalesce((SELECT sum(expenses) FROM spent), 0), 'totalPaisa', coalesce((SELECT sum(amount) FROM spent), 0),
      'byCategory', coalesce((SELECT jsonb_agg(jsonb_build_object('category', category, 'expenses', expenses, 'amountPaisa', amount) ORDER BY amount DESC, category) FROM spent), '[]'::jsonb))
  );
$$;

-- Closes the day for a branch. Refused if a shift opened on that day, or earlier, is still open; if the day is in the future; or if it is closed.
CREATE FUNCTION post_day_closing(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_date date := (p->>'business_date')::date;
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_open text;
BEGIN
  PERFORM 1 FROM branches WHERE id = v_branch AND business_id = v_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_BRANCH: this branch is not available'; END IF;
  IF v_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'INVALID_DATE: a day cannot be closed before it has happened'; END IF;
  IF EXISTS (SELECT 1 FROM day_closings WHERE branch_id = v_branch AND business_date = v_date AND reopened_at IS NULL) THEN
    RAISE EXCEPTION 'DAY_CLOSED: this day is already closed for the branch';
  END IF;
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO v_open FROM shifts s JOIN terminals t ON t.id = s.terminal_id
  WHERE s.business_id = v_business AND s.branch_id = v_branch AND s.status = 'open' AND (s.opened_at AT TIME ZONE 'Asia/Karachi')::date <= v_date;
  IF v_open IS NOT NULL THEN RAISE EXCEPTION 'SHIFTS_OPEN: close the open shift on % first', v_open; END IF;

  SELECT document_number, sequence_no INTO v_number, v_sequence FROM next_series_number(v_business, v_branch, 'day_closing', 'CLS-', p_actor);
  INSERT INTO day_closings (id, business_id, branch_id, business_date, number, sequence_no, summary, note, closed_by)
  VALUES (v_id, v_business, v_branch, v_date, v_number, v_sequence, day_summary(v_business, v_branch, v_date), coalesce(p->>'note', ''), p_actor);
  RETURN v_id;
END;
$$;

CREATE FUNCTION reopen_day_closing(p_business uuid, p_closing uuid, p_reason text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED: say why the day is being reopened'; END IF;
  UPDATE day_closings SET reopened_at = now(), reopened_by = p_actor, reopen_reason = btrim(p_reason)
  WHERE id = p_closing AND business_id = p_business AND reopened_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such closed day, or it was reopened already'; END IF;
END;
$$;

-- A closed day takes no new shifts (so no sale lands after the figures were written) and no expense dated into it.
CREATE FUNCTION guard_closed_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_date date;
BEGIN
  IF TG_TABLE_NAME = 'shifts' THEN v_date := (NEW.opened_at AT TIME ZONE 'Asia/Karachi')::date; ELSE v_date := NEW.expense_date; END IF;
  IF EXISTS (SELECT 1 FROM day_closings WHERE branch_id = NEW.branch_id AND business_date = v_date AND reopened_at IS NULL) THEN
    RAISE EXCEPTION 'DAY_CLOSED: % is closed for this branch; ask someone who may reopen the day', to_char(v_date, 'DD/MM/YYYY');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shifts_closed_day BEFORE INSERT ON shifts FOR EACH ROW EXECUTE FUNCTION guard_closed_day();
CREATE TRIGGER expenses_closed_day BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION guard_closed_day();

INSERT INTO permissions (key, description) VALUES
  ('cash.close_day', 'Close a branch''s day (day-end closing) and reopen it with a reason')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'cash.close_day' FROM roles r WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE day_closings ENABLE ROW LEVEL SECURITY;
