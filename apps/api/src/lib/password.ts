/**
 * Passwords.
 *
 * A second sign-in method beside the magic link, not a replacement for it. The
 * link stays the recovery path and the way most people will sign in; the
 * password exists so HR can hand a new joiner credentials on paper on their
 * first morning without depending on their email working yet.
 *
 * **Hashing is scrypt from Node's own crypto.** No dependency, memory-hard,
 * and the parameters travel inside the stored string so they can be raised
 * later without invalidating existing hashes: a hash records how it was made,
 * and verification reads that rather than assuming.
 *
 * **Temporary passwords are meant to be read aloud and typed.** Three groups
 * of four from an alphabet with no O/0, I/1 or l, hyphenated, e.g.
 * `K7MP-2QRW-9VXA`. Fourteen characters of that alphabet is ~62 bits, which
 * is far beyond what a rate-limited endpoint will ever let anyone guess, and
 * unlike a random string it survives being written on a Post-it.
 */

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

/** promisify drops the options argument from scrypt's type; wrap it by hand. */
const scrypt = (
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    // scrypt needs 128·N·r bytes; at N=2^15, r=8 that is exactly Node's default
    // 32MB ceiling and it refuses. Say what we need rather than shrink N.
    scryptCb(password, salt, keylen, { ...opts, maxmem: 256 * opts.N * opts.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  )

/** Cost parameters. N=2^15 is ~30ms on a modern core; raise N when that stops being true. */
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 } as const

export const PASSWORD_MIN_LENGTH = 10

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  })
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false

  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateTemporaryPassword(): string {
  const group = () =>
    Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('')
  return `${group()}-${group()}-${group()}`
}

/**
 * What a chosen password has to satisfy. Length is the only rule that
 * measurably helps; composition rules push people towards `Password1!`.
 */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) {
    return 'Your password cannot contain your email address'
  }
  if (/^(.)\1+$/.test(password)) return 'Use more than one character'
  return null
}
