-- Money is shown, entered and rounded to 2 decimal places (whole paisa) everywhere. v0.1 let a business choose 0 or 1
-- decimal places, but nothing ever read the choice. Bring every business to 2 and allow nothing else.
UPDATE business_settings SET amount_rounding = 2 WHERE amount_rounding <> 2;
ALTER TABLE business_settings DROP CONSTRAINT business_settings_amount_rounding_check;
ALTER TABLE business_settings ADD CONSTRAINT business_settings_amount_rounding_check CHECK (amount_rounding = 2);
