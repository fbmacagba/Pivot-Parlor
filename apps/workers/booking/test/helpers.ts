/** Shared test fixtures — seed rows the way the main worker's suite does. */
import { env } from "cloudflare:test";

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

export async function seedUser(role: string, shopId: string | null): Promise<string> {
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

/** Seed a 09:00-17:00 schedule. day_of_week is Monday-first (0=Mon..6=Sun),
 *  matching the admin editor; defaults to Monday (0). */
export async function seedScheduleDay(shopId: string, staffId: string, dayOfWeek = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
     VALUES (?, ?, ?, ?, '09:00', '17:00')`
  )
    .bind(uid("sched"), shopId, staffId, dayOfWeek)
    .run();
}

export async function seedService(shopId: string, durationMin = 30): Promise<string> {
  const id = uid("svc");
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', ?, 2500, 1)"
  )
    .bind(id, shopId, durationMin)
    .run();
  return id;
}

export async function slugFor(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}
