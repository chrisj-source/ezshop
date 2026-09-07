import { hash, verify } from '@node-rs/argon2';

/** argon2id, tuned for a 2 vCPU box: ~50-80ms per hash. */
const OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTS);
  } catch {
    return false;
  }
}

export function passwordProblem(p: string): string | null {
  if (p.length < 10) return 'Password must be at least 10 characters.';
  if (p.length > 200) return 'Password is too long.';
  if (/^\d+$/.test(p)) return 'Password cannot be only digits.';
  return null;
}
