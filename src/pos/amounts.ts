import { parseRupees } from "../../shared/money";

/** An amount typed in rupees as paisa, or null while it is not a valid, non-negative amount. */
export function amountOf(text: string): number | null {
  try {
    const paisa = parseRupees(text);
    return paisa >= 0 ? paisa : null;
  } catch {
    return null;
  }
}
