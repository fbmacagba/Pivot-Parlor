/** Shared test fixtures: seed rows and mint JWTs the way the worker does. */
import { env } from "cloudflare:test";
import { sign } from "hono/jwt";

type Role = "developer" | "admin" | "staff" | "customer";

let n = 0;
const uid = (prefix: string) => `${prefix}-${String(++n).padStart(4, "0")}-${crypto.randomUUID()}`;

export async function seedShop(name: string): Promise<string> {
  const id = uid("shop");
  await env.DB.prepare(
    `INSERT INTO shops (id, shop_number, slug, name, owner_email)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, Math.floor(Math.random() * 1_000_000_000), uid("slug"), name, `${uid("owner")}@test.local`)
    .run();
  return id;
}

export async function seedUser(role: Role, shopId: string | null): Promise<string> {
  const id = uid("user");
  await env.DB.prepare(
    `INSERT INTO platform_users (id, name, email, password_hash, role, shop_id)
     VALUES (?, ?, ?, 'x', ?, ?)`
  )
    .bind(id, `Test ${role}`, `${id}@test.local`, role, shopId)
    .run();
  return id;
}

export async function seedStaff(shopId: string): Promise<string> {
  const userId = await seedUser("staff", shopId);
  const id = uid("staff");
  await env.DB.prepare(
    `INSERT INTO staff (id, shop_id, user_id, display_name) VALUES (?, ?, ?, ?)`
  )
    .bind(id, shopId, userId, `Staff ${id.slice(0, 10)}`)
    .run();
  return id;
}

export async function seedScheduleDay(shopId: string, staffId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
     VALUES (?, ?, ?, 1, '09:00', '17:00')`
  )
    .bind(uid("sched"), shopId, staffId)
    .run();
}

export async function seedWaitlistEntry(shopId: string): Promise<string> {
  const id = uid("wait");
  await env.DB.prepare(
    `INSERT INTO waitlist (id, shop_id, customer_name, customer_email)
     VALUES (?, ?, 'Cust', 'cust@test.local')`
  )
    .bind(id, shopId)
    .run();
  return id;
}

/** Mint a signed JWT only — no KV session, so authMiddleware rejects it (revocation). */
export async function bareTokenFor(userId: string, role: Role, shopId: string | null): Promise<string> {
  return sign(
    {
      sub: userId,
      role,
      ...(shopId ? { shop_id: shopId } : {}),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    "test-secret"
  );
}

/** Mint a JWT exactly like POST /auth/login does: signed AND recorded in KV. */
export async function tokenFor(userId: string, role: Role, shopId: string | null): Promise<string> {
  const token = await bareTokenFor(userId, role, shopId);
  await env.KV.put(
    `session:${token}`,
    JSON.stringify({ user_id: userId, role, shop_id: shopId }),
    { expirationTtl: 3600 }
  );
  return token;
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
