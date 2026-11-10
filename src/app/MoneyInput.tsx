import { forwardRef, useState, type FocusEvent, type InputHTMLAttributes } from "react";
import { normaliseMoneyText } from "../../shared/money";
import { TextInput } from "./FormElements";
import { setInputValueLikeTheBrowser } from "./setInputValue";

/**
 * A box for an amount in rupees. When the person leaves it, "3.2" becomes "3.20" and "1,234.5" becomes "1234.50", so every
 * amount is shown with exactly 2 decimals. Text that is not an amount (such as 3 decimals) is left as typed and marked invalid.
 */
export const MoneyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ onBlur, onChange, ...props }, ref) => {
  const [invalid, setInvalid] = useState(false);

  function leave(event: FocusEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const shown = normaliseMoneyText(input.value);
    setInvalid(shown === null);
    if (shown !== null && shown !== input.value) setInputValueLikeTheBrowser(input, shown);
    onBlur?.(event);
  }

  return <TextInput
    ref={ref}
    inputMode="decimal"
    {...props}
    aria-invalid={invalid || undefined}
    title={invalid ? "Use rupees with up to two decimals, for example 1250.50" : props.title}
    onChange={(event) => {
      if (invalid) setInvalid(false);
      onChange?.(event);
    }}
    onBlur={leave}
  />;
});
MoneyInput.displayName = "MoneyInput";
