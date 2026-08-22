import { compare, hash } from "bcryptjs";

/**
 * Password hashing (task 5.1) — bcrypt via bcryptjs (pure JS, no native
 * build). Verification never throws on a corrupt stored hash: it degrades to
 * a failed login (401) so a bad row can't become a 500 or a timing oracle.
 */

export const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string, rounds: number = BCRYPT_ROUNDS): Promise<string> {
  return hash(plain, rounds);
}

export async function verifyPassword(
  plain: string,
  storedHash: string
): Promise<boolean> {
  if (plain.length === 0) {
    return false;
  }
  try {
    return await compare(plain, storedHash);
  } catch {
    return false;
  }
}
