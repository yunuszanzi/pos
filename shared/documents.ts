/** INV-KHI + 123 -> INV-KHI-000123. The database builds the same text when it takes the next number, and a test keeps the two in step. */
export function formatDocumentNumber(prefix: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError("A document sequence starts at 1");
  return `${prefix}-${String(sequence).padStart(6, "0")}`;
}
