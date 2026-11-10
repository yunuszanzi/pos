// Copies of what the app was last told about the signed-in person and the till, kept so a page opened with no connection can start
// from them instead of failing. They are only ever a fallback for "the server could not be reached"; any real answer replaces them,
// and signing out removes them. Storage can be missing or full: every call here tolerates that.

const prefix = "pos.offline.";

export function keepCopy(name: string, value: unknown): void {
  try {
    localStorage.setItem(prefix + name, JSON.stringify(value));
  } catch {
    // No room, or storage is off: the app simply has no copy to fall back on.
  }
}

export function readCopy<T>(name: string): T | null {
  try {
    const text = localStorage.getItem(prefix + name);
    return text ? JSON.parse(text) as T : null;
  } catch {
    return null;
  }
}

export function forgetCopies(): void {
  try {
    for (const key of Object.keys(localStorage).filter((entry) => entry.startsWith(prefix))) localStorage.removeItem(key);
  } catch {
    // Nothing more can be done.
  }
}
