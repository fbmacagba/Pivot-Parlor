import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

/**
 * WS-7: PBKDF2 raised to 600k iterations with a versioned hash format
 * (v2:<iterations>:<salt>:<hash>). Legacy "<salt>:<hash>" rows (100k) must
 * keep verifying and be transparently re-hashed on successful login.
 */

/** The pre-WS-7 hash format, exactly as auth.ts used to write it. */
async function legacyHash(password: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `${saltB64}:${hash}`;
}

async function storedHashOf(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT password_hash FROM platform_users WHERE email = ?")
    .bind(email)
    .first<{ password_hash: string }>();
  return row!.password_hash;
}

describe("WS-7: PBKDF2 versioned hashes", () => {
  it("registration stores a v2 600k hash and login accepts it", async () => {
    const email = `kdf-${crypto.randomUUID()}@test.local`;
    const reg = await dispatch("POST", "/auth/register", {
      headers: { "CF-Connecting-IP": "203.0.113.60" },
      body: { name: "Kay", email, password: "pw-123456" },
    });
    expect(reg.status).toBe(201);
    expect(await storedHashOf(email)).toMatch(/^v2:600000:/);

    const login = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": "203.0.113.60" },
      body: { email, password: "pw-123456" },
    });
    expect(login.status).toBe(200);
  });

  it("a legacy 100k hash still logs in and is upgraded to v2 in place", async () => {
    const email = `legacy-${crypto.randomUUID()}@test.local`;
    const hash = await legacyHash("old-pw-123");
    await env.DB.prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified) VALUES (?, 'Old Timer', ?, ?, 'customer', NULL, 1)"
    )
      .bind(crypto.randomUUID(), email, hash)
      .run();

    const login = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": "203.0.113.61" },
      body: { email, password: "old-pw-123" },
    });
    expect(login.status).toBe(200);

    const upgraded = await storedHashOf(email);
    expect(upgraded).toMatch(/^v2:600000:/);
    expect(upgraded).not.toBe(hash);

    // And the upgraded hash keeps working.
    const again = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": "203.0.113.61" },
      body: { email, password: "old-pw-123" },
    });
    expect(again.status).toBe(200);
  });

  it("a wrong password against a legacy hash fails and does NOT rewrite the row", async () => {
    const email = `legacy-wrong-${crypto.randomUUID()}@test.local`;
    const hash = await legacyHash("right-pw");
    await env.DB.prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id) VALUES (?, 'Old Timer', ?, ?, 'customer', NULL)"
    )
      .bind(crypto.randomUUID(), email, hash)
      .run();

    const login = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": "203.0.113.62" },
      body: { email, password: "wrong-pw" },
    });
    expect(login.status).toBe(401);
    expect(await storedHashOf(email)).toBe(hash);
  });
});
