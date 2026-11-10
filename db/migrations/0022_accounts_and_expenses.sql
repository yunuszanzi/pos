-- v0.7 slice 1: money accounts and expenses (FR-CSH-05, FR-CSH-06). API-only like the rest.
--
-- An ACCOUNT is a place money sits besides the till drawer: a cash box, a bank account, a wallet (JazzCash, Easypaisa). Its balance is
-- the sum of an append-only list of entries and is changed only by that list (a guard trigger refuses anything else). Every non-cash
-- payment method gets its own account, and money taken or paid by that method lands in it by trigger: sales payments, customer payments
-- and refunds out, supplier payments out. Cheques are not in an account until they are deposited (a manual entry).
--
-- An EXPENSE is money spent: a category, an amount, the date, and where it was paid from: an account, or the register (the open shift's
-- drawer, as a cash-out, so the shift's expected cash stays right). Expenses are immutable; a mistake is REVERSED (once, with a reason),
-- which puts the money back and leaves both records.

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('cash', 'bank', 'wallet')),
  active boolean NOT NULL DEFAULT true,
  -- The sum of the account's entries. Changed only by the entries trigger.
  balance_paisa bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX accounts_name_uidx ON accounts (business_id, lower(btrim(name)));

CREATE TABLE account_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  entry_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  -- Money in is positive, money out is negative.
  amount_paisa bigint NOT NULL CHECK (amount_paisa <> 0),
  doc_type text NOT NULL CHECK (doc_type IN ('opening', 'deposit', 'withdrawal', 'transfer', 'expense', 'expense_reversal', 'sales_payment', 'customer_payment', 'supplier_payment', 'sales_refund')),
  doc_id uuid,
  doc_number text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id, business_id) REFERENCES accounts(id, business_id)
);
CREATE INDEX account_entries_account_idx ON account_entries (account_id, entry_date, created_at);
CREATE INDEX account_entries_doc_idx ON account_entries (business_id, doc_type, doc_id);

CREATE FUNCTION apply_account_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'account entries are append-only; record a new entry instead'; END IF;
  PERFORM set_config('pos.ledger_write', 'on', true);
  UPDATE accounts SET balance_paisa = balance_paisa + NEW.amount_paisa, updated_at = now() WHERE id = NEW.account_id AND business_id = NEW.business_id;
  PERFORM set_config('pos.ledger_write', 'off', true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_entries_apply AFTER INSERT ON account_entries FOR EACH ROW EXECUTE FUNCTION apply_account_entry();
CREATE TRIGGER account_entries_immutable BEFORE UPDATE OR DELETE ON account_entries FOR EACH ROW EXECUTE FUNCTION apply_account_entry();

CREATE FUNCTION guard_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_paisa <> OLD.balance_paisa AND coalesce(current_setting('pos.ledger_write', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'an account balance is changed only by its entries';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_guard_balance BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_balance();

-- ---------------------------------------------------------------- payment methods own an account

ALTER TABLE payment_methods ADD COLUMN account_id uuid;
ALTER TABLE payment_methods ADD FOREIGN KEY (account_id, business_id) REFERENCES accounts(id, business_id);

-- Every non-cash method (except cheques, which are not money until deposited) has an account named after it.
CREATE FUNCTION ensure_payment_method_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_account uuid;
BEGIN
  IF NEW.kind = 'cash' OR NEW.code = 'cheque' OR NEW.account_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_account FROM accounts WHERE business_id = NEW.business_id AND lower(btrim(name)) = lower(btrim(NEW.name));
  IF v_account IS NULL THEN
    INSERT INTO accounts (business_id, name, kind, created_by, updated_by)
    VALUES (NEW.business_id, NEW.name, CASE WHEN NEW.kind = 'wallet' THEN 'wallet' ELSE 'bank' END, NEW.created_by, NEW.created_by)
    RETURNING id INTO v_account;
  END IF;
  NEW.account_id := v_account;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_methods_account BEFORE INSERT OR UPDATE OF kind, code ON payment_methods FOR EACH ROW EXECUTE FUNCTION ensure_payment_method_account();

-- The methods that exist already.
UPDATE payment_methods SET kind = kind WHERE kind <> 'cash' AND code <> 'cheque' AND account_id IS NULL;

-- Money taken or paid by a method that has an account lands in it.
CREATE FUNCTION post_method_account_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_method uuid;
  v_account uuid;
  v_amount bigint;
  v_type text;
  v_doc uuid;
  v_number text := '';
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    v_method := NEW.method_id; v_amount := NEW.amount_paisa; v_type := 'sales_payment'; v_doc := NEW.invoice_id;
    SELECT number INTO v_number FROM sales_invoices WHERE id = NEW.invoice_id;
  ELSIF TG_TABLE_NAME = 'customer_payments' THEN
    v_method := NEW.method_id; v_amount := NEW.amount_paisa; v_type := 'customer_payment'; v_doc := NEW.id; v_number := NEW.number;
  ELSIF TG_TABLE_NAME = 'supplier_payments' THEN
    v_method := NEW.method_id; v_amount := -NEW.amount_paisa; v_type := 'supplier_payment'; v_doc := NEW.id; v_number := NEW.number;
  ELSIF TG_TABLE_NAME = 'sales_returns' THEN
    v_method := NEW.refund_method_id; v_amount := -NEW.refund_paisa; v_type := 'sales_refund'; v_doc := NEW.id; v_number := NEW.number;
  END IF;
  IF v_method IS NULL OR v_amount = 0 THEN RETURN NEW; END IF;
  SELECT account_id INTO v_account FROM payment_methods WHERE id = v_method AND business_id = NEW.business_id;
  IF v_account IS NOT NULL THEN
    INSERT INTO account_entries (business_id, account_id, amount_paisa, doc_type, doc_id, doc_number, created_by)
    VALUES (NEW.business_id, v_account, v_amount, v_type, v_doc, coalesce(v_number, ''), NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_account_entry AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION post_method_account_entry();
CREATE TRIGGER customer_payments_account_entry AFTER INSERT ON customer_payments FOR EACH ROW EXECUTE FUNCTION post_method_account_entry();
CREATE TRIGGER supplier_payments_account_entry AFTER INSERT ON supplier_payments FOR EACH ROW EXECUTE FUNCTION post_method_account_entry();
CREATE TRIGGER sales_returns_account_entry AFTER INSERT ON sales_returns FOR EACH ROW EXECUTE FUNCTION post_method_account_entry();

-- ---------------------------------------------------------------- expenses

CREATE TABLE expense_categories (
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
CREATE UNIQUE INDEX expense_categories_name_uidx ON expense_categories (business_id, lower(btrim(name)));

CREATE FUNCTION seed_expense_defaults(p_business_id uuid, p_actor uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO expense_categories (business_id, name, created_by, updated_by)
  SELECT p_business_id, n, p_actor, p_actor FROM unnest(ARRAY['Rent', 'Electricity, gas and water', 'Salaries and wages', 'Transport and fuel', 'Repairs and maintenance',
    'Stationery and packing', 'Tea and refreshments', 'Bank and wallet charges', 'Other']) AS n
  ON CONFLICT DO NOTHING;
$$;
SELECT seed_expense_defaults(b.id, (SELECT u.id FROM users u WHERE u.business_id = b.id ORDER BY u.created_at LIMIT 1)) FROM businesses b;

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  category_id uuid NOT NULL,
  expense_date date NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  -- Paid from an account, or from the register (the open shift's drawer).
  paid_from text NOT NULL CHECK (paid_from IN ('account', 'register')),
  account_id uuid,
  shift_id uuid,
  payee text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  -- A photo or PDF of the bill in private storage (set once, by the attachment endpoint).
  attachment_path text,
  attachment_name text,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (category_id, business_id) REFERENCES expense_categories(id, business_id),
  FOREIGN KEY (account_id, business_id) REFERENCES accounts(id, business_id),
  FOREIGN KEY (shift_id, business_id) REFERENCES shifts(id, business_id),
  CHECK ((paid_from = 'account' AND account_id IS NOT NULL AND shift_id IS NULL) OR (paid_from = 'register' AND shift_id IS NOT NULL AND account_id IS NULL)),
  CHECK ((reversed_at IS NULL) = (reversed_by IS NULL))
);
CREATE INDEX expenses_date_idx ON expenses (business_id, expense_date DESC);
CREATE INDEX expenses_category_idx ON expenses (business_id, category_id, expense_date DESC);

-- A posted expense never changes, except that it may be reversed once and may gain its attachment.
CREATE FUNCTION protect_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an expense cannot be deleted; reverse it instead'; END IF;
  IF OLD.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'a reversed expense cannot be changed'; END IF;
  IF (to_jsonb(NEW) - 'reversed_at' - 'reversed_by' - 'reversal_reason' - 'attachment_path' - 'attachment_name')
     = (to_jsonb(OLD) - 'reversed_at' - 'reversed_by' - 'reversal_reason' - 'attachment_path' - 'attachment_name') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a posted expense cannot be changed; reverse it and record a new one';
END;
$$;
CREATE TRIGGER expenses_protect BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION protect_expense();

CREATE TABLE account_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  number text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  transfer_date date NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  -- From an account, or from the register (a bank deposit of the day's cash).
  from_account_id uuid,
  from_shift_id uuid,
  to_account_id uuid NOT NULL,
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (id, business_id),
  UNIQUE (business_id, number),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id),
  FOREIGN KEY (from_account_id, business_id) REFERENCES accounts(id, business_id),
  FOREIGN KEY (from_shift_id, business_id) REFERENCES shifts(id, business_id),
  FOREIGN KEY (to_account_id, business_id) REFERENCES accounts(id, business_id),
  CHECK ((from_account_id IS NULL) <> (from_shift_id IS NULL)),
  CHECK (from_account_id IS NULL OR from_account_id <> to_account_id)
);
CREATE FUNCTION deny_transfer_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'an account transfer cannot be changed or deleted; record a transfer back instead';
END;
$$;
CREATE TRIGGER account_transfers_immutable BEFORE UPDATE OR DELETE ON account_transfers FOR EACH ROW EXECUTE FUNCTION deny_transfer_change();

-- ---------------------------------------------------------------- posting

CREATE FUNCTION next_series_number(p_business uuid, p_branch uuid, p_doc_type text, p_prefix text, p_actor uuid)
RETURNS TABLE (document_number text, sequence_no integer) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_series (business_id, branch_id, doc_type, prefix, created_by, updated_by)
  SELECT p_business, b.id, p_doc_type, p_prefix || upper(b.code), p_actor, p_actor FROM branches b WHERE b.id = p_branch AND b.business_id = p_business
  ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT * FROM take_next_document_number(p_business, p_branch, p_doc_type);
END;
$$;

-- Records an expense in the caller's transaction. Paid from an account: the account's balance goes down. Paid from the register: the
-- shift must be open and the money leaves its drawer as a cash-out, so the shift's expected cash stays right.
CREATE FUNCTION post_expense(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_category uuid := (p->>'category_id')::uuid;
  v_amount bigint := (p->>'amount_paisa')::bigint;
  v_paid_from text := p->>'paid_from';
  v_account uuid := nullif(p->>'account_id', '')::uuid;
  v_shift uuid := nullif(p->>'shift_id', '')::uuid;
  v_date date := coalesce(nullif(p->>'expense_date', '')::date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_category_name text;
  v_status text;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: enter an amount more than zero'; END IF;
  IF v_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'INVALID_DATE: an expense cannot be dated in the future'; END IF;
  SELECT name INTO v_category_name FROM expense_categories WHERE id = v_category AND business_id = v_business AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CATEGORY: this expense category is not available'; END IF;
  PERFORM 1 FROM branches WHERE id = v_branch AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_BRANCH: this branch is not available'; END IF;

  IF v_paid_from = 'account' THEN
    SELECT id INTO v_account FROM accounts WHERE id = v_account AND business_id = v_business AND active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ACCOUNT: this account is not available'; END IF;
  ELSIF v_paid_from = 'register' THEN
    SELECT status INTO v_status FROM shifts WHERE id = v_shift AND business_id = v_business AND branch_id = v_branch FOR SHARE;
    IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN: the register must have an open shift to pay an expense from it'; END IF;
  ELSE
    RAISE EXCEPTION 'INVALID_ACCOUNT: choose where the money was paid from';
  END IF;

  SELECT document_number, sequence_no INTO v_number, v_sequence FROM next_series_number(v_business, v_branch, 'expense', 'EXP-', p_actor);
  INSERT INTO expenses (id, business_id, branch_id, number, sequence_no, category_id, expense_date, amount_paisa, paid_from, account_id, shift_id, payee, reference, note, created_by)
  VALUES (v_id, v_business, v_branch, v_number, v_sequence, v_category, v_date, v_amount, v_paid_from,
          CASE WHEN v_paid_from = 'account' THEN v_account END, CASE WHEN v_paid_from = 'register' THEN v_shift END,
          coalesce(p->>'payee', ''), coalesce(p->>'reference', ''), coalesce(p->>'note', ''), p_actor);

  IF v_paid_from = 'account' THEN
    INSERT INTO account_entries (business_id, account_id, entry_date, amount_paisa, doc_type, doc_id, doc_number, memo, created_by)
    VALUES (v_business, v_account, v_date, -v_amount, 'expense', v_id, v_number, v_category_name, p_actor);
  ELSE
    INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason, created_by)
    VALUES (v_business, v_shift, 'cash_out', v_amount, 'Expense ' || v_number || ': ' || v_category_name, p_actor);
  END IF;
  RETURN v_id;
END;
$$;

-- Reverses an expense once: the money goes back where it came from (an account entry, or a cash-in on the open shift p_shift) and the
-- expense stays on record, marked reversed with the reason.
CREATE FUNCTION reverse_expense(p_business uuid, p_expense uuid, p_reason text, p_shift uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e expenses%ROWTYPE;
  v_status text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED: say why the expense is being reversed'; END IF;
  SELECT * INTO e FROM expenses WHERE id = p_expense AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such expense'; END IF;
  IF e.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_REVERSED: this expense was reversed already'; END IF;
  IF e.paid_from = 'account' THEN
    INSERT INTO account_entries (business_id, account_id, amount_paisa, doc_type, doc_id, doc_number, memo, created_by)
    VALUES (p_business, e.account_id, e.amount_paisa, 'expense_reversal', e.id, e.number, 'Reversed: ' || btrim(p_reason), p_actor);
  ELSE
    SELECT status INTO v_status FROM shifts WHERE id = p_shift AND business_id = p_business FOR SHARE;
    IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN: the money goes back into an open shift; open one first'; END IF;
    INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason, created_by)
    VALUES (p_business, p_shift, 'cash_in', e.amount_paisa, 'Reversal of expense ' || e.number || ': ' || btrim(p_reason), p_actor);
  END IF;
  UPDATE expenses SET reversed_at = now(), reversed_by = p_actor, reversal_reason = btrim(p_reason) WHERE id = p_expense;
END;
$$;

-- Moves money between two accounts, or from the register into an account (a bank deposit). Both sides are recorded or neither.
CREATE FUNCTION post_account_transfer(p jsonb, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_business uuid := (p->>'business_id')::uuid;
  v_branch uuid := (p->>'branch_id')::uuid;
  v_amount bigint := (p->>'amount_paisa')::bigint;
  v_from uuid := nullif(p->>'from_account_id', '')::uuid;
  v_shift uuid := nullif(p->>'from_shift_id', '')::uuid;
  v_to uuid := (p->>'to_account_id')::uuid;
  v_date date := coalesce(nullif(p->>'transfer_date', '')::date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_id uuid := gen_random_uuid();
  v_number text;
  v_sequence integer;
  v_status text;
  v_first uuid;
  v_second uuid;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: enter an amount more than zero'; END IF;
  IF (v_from IS NULL) = (v_shift IS NULL) THEN RAISE EXCEPTION 'INVALID_ACCOUNT: move money from an account or from the register, not both'; END IF;
  IF v_from IS NOT NULL AND v_from = v_to THEN RAISE EXCEPTION 'INVALID_ACCOUNT: choose two different accounts'; END IF;
  IF v_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'INVALID_DATE: a transfer cannot be dated in the future'; END IF;
  PERFORM 1 FROM branches WHERE id = v_branch AND business_id = v_business;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_BRANCH: this branch is not available'; END IF;
  -- Lock the accounts in a fixed order so two transfers cannot deadlock.
  v_first := least(coalesce(v_from, v_to), v_to);
  v_second := greatest(coalesce(v_from, v_to), v_to);
  PERFORM 1 FROM accounts WHERE id IN (v_first, v_second) AND business_id = v_business AND active ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM accounts WHERE id IN (v_first, v_second) AND business_id = v_business AND active) <> (CASE WHEN v_first = v_second THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT: an account is not available';
  END IF;
  IF v_shift IS NOT NULL THEN
    SELECT status INTO v_status FROM shifts WHERE id = v_shift AND business_id = v_business AND branch_id = v_branch FOR SHARE;
    IF NOT FOUND OR v_status <> 'open' THEN RAISE EXCEPTION 'SHIFT_NOT_OPEN: the register must have an open shift to pay money out of it'; END IF;
  END IF;

  SELECT document_number, sequence_no INTO v_number, v_sequence FROM next_series_number(v_business, v_branch, 'account_transfer', 'TRF-', p_actor);
  INSERT INTO account_transfers (id, business_id, branch_id, number, sequence_no, transfer_date, amount_paisa, from_account_id, from_shift_id, to_account_id, memo, created_by)
  VALUES (v_id, v_business, v_branch, v_number, v_sequence, v_date, v_amount, v_from, v_shift, v_to, coalesce(p->>'memo', ''), p_actor);
  IF v_from IS NOT NULL THEN
    INSERT INTO account_entries (business_id, account_id, entry_date, amount_paisa, doc_type, doc_id, doc_number, memo, created_by)
    VALUES (v_business, v_from, v_date, -v_amount, 'transfer', v_id, v_number, coalesce(p->>'memo', ''), p_actor);
  ELSE
    INSERT INTO cash_movements (business_id, shift_id, kind, amount_paisa, reason, created_by)
    VALUES (v_business, v_shift, 'cash_out', v_amount, 'Deposit ' || v_number || coalesce(': ' || nullif(p->>'memo', ''), ''), p_actor);
  END IF;
  INSERT INTO account_entries (business_id, account_id, entry_date, amount_paisa, doc_type, doc_id, doc_number, memo, created_by)
  VALUES (v_business, v_to, v_date, v_amount, 'transfer', v_id, v_number, coalesce(p->>'memo', ''), p_actor);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- permissions

INSERT INTO permissions (key, description) VALUES
  ('expenses.view', 'View expenses and expense categories'),
  ('expenses.create', 'Record expenses, attach bills, and reverse a mistaken one'),
  ('accounts.view', 'View cash, bank and wallet accounts, their balances and entries'),
  ('accounts.manage', 'Add accounts, record deposits and withdrawals, and move money between accounts')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('expenses.view'), ('expenses.create'), ('accounts.view'), ('accounts.manage')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
