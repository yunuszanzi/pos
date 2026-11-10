-- v0.9 slice 2, continued: a recount is measured against the shelf as it is now.
--
-- When a submitted count is sent back for a recount, every item whose count differed from the books is reset to "not counted" and
-- its expected figure (and cost) is frozen again from the current stock, because stock has moved since the first freeze and the
-- person will now count what is really there. Items whose count matched are kept as counted.

CREATE OR REPLACE FUNCTION protect_stock_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_refreeze boolean := coalesce(current_setting('pos.count_refreeze', true), '') = 'on';
BEGIN
  IF TG_TABLE_NAME = 'stock_counts' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stock count cannot be deleted; cancel it instead'; END IF;
    IF OLD.status IN ('approved', 'cancelled') THEN RAISE EXCEPTION 'a % stock count cannot be changed', OLD.status; END IF;
    IF (to_jsonb(NEW) - 'status' - 'note' - 'review_note' - 'adjustment_id' - 'submitted_at' - 'submitted_by' - 'approved_at' - 'approved_by' - 'cancelled_at' - 'updated_at' - 'updated_by')
       = (to_jsonb(OLD) - 'status' - 'note' - 'review_note' - 'adjustment_id' - 'submitted_at' - 'submitted_by' - 'approved_at' - 'approved_by' - 'cancelled_at' - 'updated_at' - 'updated_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a stock count cannot be changed except for its status and notes';
  END IF;

  SELECT status INTO v_status FROM stock_counts WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.count_id ELSE NEW.count_id END;
  IF v_status <> 'counting' THEN RAISE EXCEPTION 'COUNT_NOT_OPEN: the count is %, so its lines cannot be changed', v_status; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a counted line cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF v_refreeze THEN
      IF (to_jsonb(NEW) - 'counted_base' - 'counted_at' - 'counted_by' - 'expected_base' - 'cost_paisa') <> (to_jsonb(OLD) - 'counted_base' - 'counted_at' - 'counted_by' - 'expected_base' - 'cost_paisa') THEN
        RAISE EXCEPTION 'only the counted quantity and the books'' figure of a line can change';
      END IF;
    ELSIF (to_jsonb(NEW) - 'counted_base' - 'counted_at' - 'counted_by') <> (to_jsonb(OLD) - 'counted_base' - 'counted_at' - 'counted_by') THEN
      RAISE EXCEPTION 'only the counted quantity of a line can change';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_stock_count_status(p_business uuid, p_count uuid, p_status text, p_note text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c stock_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count AND business_id = p_business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such stock count'; END IF;
  IF NOT ((c.status = 'counting' AND p_status = 'submitted') OR (c.status = 'submitted' AND p_status = 'counting')
       OR (c.status IN ('counting', 'submitted') AND p_status = 'cancelled')) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a % count cannot become %', c.status, p_status;
  END IF;
  IF p_status = 'submitted' AND NOT EXISTS (SELECT 1 FROM stock_count_lines WHERE count_id = p_count AND counted_base IS NOT NULL) THEN
    RAISE EXCEPTION 'NOTHING_COUNTED: nothing has been counted yet';
  END IF;

  UPDATE stock_counts SET status = p_status, updated_by = p_actor, updated_at = now(),
    submitted_at = CASE WHEN p_status = 'submitted' THEN now() ELSE submitted_at END,
    submitted_by = CASE WHEN p_status = 'submitted' THEN p_actor ELSE submitted_by END,
    cancelled_at = CASE WHEN p_status = 'cancelled' THEN now() ELSE cancelled_at END,
    review_note = CASE WHEN p_status IN ('counting', 'cancelled') AND coalesce(p_note, '') <> '' THEN p_note ELSE review_note END
  WHERE id = p_count;

  -- Sent back: what differed is counted afresh against the stock as it is now.
  IF p_status = 'counting' THEN
    PERFORM set_config('pos.count_refreeze', 'on', true);
    UPDATE stock_count_lines l SET counted_base = NULL, counted_at = NULL, counted_by = NULL,
      expected_base = coalesce((SELECT b.on_hand FROM stock_balances b WHERE b.variant_id = l.variant_id AND b.location_id = c.location_id), 0),
      cost_paisa = coalesce((SELECT b.avg_cost_paisa FROM stock_balances b WHERE b.variant_id = l.variant_id AND b.location_id = c.location_id), l.cost_paisa)
    WHERE l.count_id = p_count AND l.counted_base IS NOT NULL AND l.counted_base <> l.expected_base;
    PERFORM set_config('pos.count_refreeze', 'off', true);
  END IF;
END;
$$;
