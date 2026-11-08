import { formatDocumentDate } from "../../../shared/receipt";

/** A day written yyyy-mm-dd as dd/mm/yyyy for a list; empty when there is none. The documents print in the business's own date style. */
export const dayText = (day: string | null | undefined) => (day ? day.split("-").reverse().join("/") : "");

/** The day of a moment in time, dd/mm/yyyy in the business's time zone (Karachi, the only one a business can have). */
export const momentDayText = (iso: string | null | undefined) => (iso ? formatDocumentDate(iso, "dd/MM/yyyy", "Asia/Karachi").split(" ")[0] : "");
