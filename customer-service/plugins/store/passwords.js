/** Salted password hashing for the Customer table. */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt parameters. `N=2**14` is the Node default cost; the demo has four accounts. */
const KEY_BYTES = 32
const SALT_BYTES = 16

/**
 * Hash a password with a fresh random salt.
 * @param password - the plaintext password.
 * @returns a `scrypt$<salt>$<hash>` string with both halves base64.
 */
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(password, salt, KEY_BYTES)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

/**
 * Check a password against a stored hash.
 * @param password - the plaintext password to check.
 * @param stored - a value produced by {@link hashPassword}.
 * @returns whether the password matches. A malformed or foreign `stored`
 *   value returns `false` rather than throwing, so one bad row cannot break login.
 */
export function verifyPassword(password, stored) {
  const [scheme, saltPart, hashPart] = String(stored).split('$')
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false
  const expected = Buffer.from(hashPart, 'base64')
  if (expected.length !== KEY_BYTES) return false
  const actual = scryptSync(password, Buffer.from(saltPart, 'base64'), KEY_BYTES)
  return timingSafeEqual(actual, expected)
}
