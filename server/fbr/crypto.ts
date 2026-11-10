import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The FBR security token is a secret the shop owner types in once. It is stored encrypted (AES-256-GCM) with a key that lives only in the
// server's environment (APP_ENCRYPTION_KEY), so a copy of the database alone cannot read it, and it is never sent back to a browser.

export class EncryptionKeyError extends Error {}

function key(): Buffer {
  const text = process.env.APP_ENCRYPTION_KEY;
  if (!text) throw new EncryptionKeyError("APP_ENCRYPTION_KEY is not set on the server, so the FBR token cannot be stored safely");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== 32) throw new EncryptionKeyError("APP_ENCRYPTION_KEY must be 32 random bytes written in base64");
  return bytes;
}

const part = (buffer: Buffer) => buffer.toString("base64url");

/** `v1.<iv>.<tag>.<ciphertext>`: a fresh random IV every time, and the tag makes any change to the stored text detectable. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${part(iv)}.${part(cipher.getAuthTag())}.${part(encrypted)}`;
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, encrypted] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new EncryptionKeyError("The stored FBR token is not in a format this server understands");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new EncryptionKeyError("The stored FBR token cannot be read with this server's key. Enter the token again.");
  }
}

/** What the screen may show of a token: the last four characters, so the owner can tell which one is stored. */
export const tokenHint = (plain: string) => `••••${plain.slice(-4)}`;
