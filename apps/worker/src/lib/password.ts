// Single PBKDF2 password-hashing path (WS-7). Every route that stores or
// checks a password_hash must import from here — do not inline the KDF again.
//
// Stored formats:
//   legacy  "<saltB64>:<hashB64>"                 — PBKDF2-SHA256, 100k iterations
//   v2      "v2:<iterations>:<saltB64>:<hashB64>" — iterations recorded in the hash
//
// New hashes are always v2 at PBKDF2_ITERATIONS. verifyPassword accepts both
// formats so pre-WS-7 rows keep working, and needsRehash() lets the login
// route transparently upgrade them while it holds the plaintext.

export const PBKDF2_ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `v2:${PBKDF2_ITERATIONS}:${saltB64}:${hash}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  let iterations: number;
  let saltB64: string;
  let expected: string;

  if (parts.length === 4 && parts[0] === "v2") {
    iterations = Number(parts[1]);
    // A corrupt iteration count must not turn login into a CPU sink or a
    // 1-iteration downgrade; reject outside a sane band.
    if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 5_000_000) return false;
    saltB64 = parts[2]!;
    expected = parts[3]!;
  } else if (parts.length === 2 && parts[0] && parts[1]) {
    iterations = LEGACY_ITERATIONS;
    saltB64 = parts[0]!;
    expected = parts[1]!;
  } else {
    return false;
  }

  let salt: Uint8Array;
  try {
    salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const derived = await derive(password, salt, iterations);
  return derived === expected;
}

/** True when the stored hash predates the current scheme/cost and should be
 *  re-hashed on the next successful login. */
export function needsRehash(storedHash: string): boolean {
  const parts = storedHash.split(":");
  return !(parts.length === 4 && parts[0] === "v2" && Number(parts[1]) >= PBKDF2_ITERATIONS);
}
