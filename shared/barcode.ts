/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new RangeError("EAN-13 needs exactly 12 digits before the check digit");
  const sum = [...first12].reduce((total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/**
 * An internal barcode for a product that has none. The prefix 20-29 is reserved by GS1 for in-store use,
 * so it cannot collide with a manufacturer's code. `random` supplies 10 digits (inject it for tests).
 */
export function generateInternalEan13(random: () => number = Math.random): string {
  const body = Array.from({ length: 10 }, () => Math.floor(random() * 10)).join("");
  const first12 = `20${body}`;
  return `${first12}${ean13CheckDigit(first12)}`;
}
