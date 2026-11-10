import type { TillCustomer } from "../api/customersApi";

const digitsOf = (text: string) => text.replace(/\D/g, "");

/** The local customer list: search by name, business name or any phone number without calling the server. */
export class CustomerIndex {
  private readonly all: TillCustomer[];
  private readonly byId = new Map<string, TillCustomer>();

  constructor(customers: Iterable<TillCustomer>) {
    this.all = [...customers].filter((customer) => customer.active).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    for (const customer of this.all) this.byId.set(customer.id, customer);
  }

  get size() {
    return this.all.length;
  }

  get(id: string): TillCustomer | undefined {
    return this.byId.get(id);
  }

  /** Names match on every typed word anywhere; a typed number matches the end or the middle of a phone, so "5550000" finds "0321-5550000". */
  search(text: string, limit = 20): TillCustomer[] {
    const query = text.trim().toLowerCase();
    if (!query) return [];
    const words = query.split(/\s+/);
    const digits = digitsOf(query);
    const wantsPhone = digits.length >= 3 && digits.length === query.replace(/[\s\-+()]/g, "").length;
    const found: TillCustomer[] = [];
    for (const customer of this.all) {
      const haystack = `${customer.name} ${customer.businessName}`.toLowerCase();
      const phoneMatch = wantsPhone && [customer.phone, customer.phone2, customer.whatsapp].some((phone) => digitsOf(phone).includes(digits));
      if (phoneMatch || (!wantsPhone && words.every((word) => haystack.includes(word)))) found.push(customer);
      if (found.length >= limit) break;
    }
    return found;
  }
}
