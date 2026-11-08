import { forwardRef, type InputHTMLAttributes } from "react";
import { sanitiseQuantityText } from "../../shared/units";
import { TextInput } from "./FormElements";
import { setInputValueLikeTheBrowser } from "./setInputValue";

/**
 * A box for a quantity or a count. It only takes digits and one decimal point, so letters never appear, whether typed or
 * pasted: "2a5" becomes "25". Up to three decimals (the exact precision stock is kept in), or none with `decimals={0}` for
 * counts such as copies. Works controlled, and with React Hook Form's `register`.
 */
export const QuantityInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { decimals?: number }>(({ onChange, decimals = 3, ...props }, ref) => (
  <TextInput
    ref={ref}
    inputMode={decimals > 0 ? "decimal" : "numeric"}
    autoComplete="off"
    {...props}
    onChange={(event) => {
      const input = event.currentTarget;
      const cleaned = sanitiseQuantityText(input.value, decimals);
      // Put the cleaned text back and let the box announce that, so the screen and the form only ever see a valid quantity.
      if (cleaned !== input.value) return setInputValueLikeTheBrowser(input, cleaned);
      onChange?.(event);
    }}
  />
));
QuantityInput.displayName = "QuantityInput";
