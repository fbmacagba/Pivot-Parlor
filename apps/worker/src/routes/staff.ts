import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getStaffByShop, getStaffById, createStaffMember, updateStaffMember,
  addStaffService, getStaffServices, createUser, getUserByEmail,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireShop } from "../middleware/rbac.js";

const staff = new Hono<{ Bindings: Bindings }>();

// All routes require auth + shop ownership
staff.use("*", authMiddleware, requireShop());

// ─── GET /api/shops/:shopId/staff ─────────────────────────────────────────────

staff.get("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const members = await getStaffByShop(c.env.DB, shopId);
  const enriched = await Promise.all(
    members.map(async (m) => {
      const services = await getStaffServices(c.env.DB, m.id);
      return { ...m, services };
    })
  );
  return c.json({ success: true, data: enriched });
});

// ─── GET /api/shops/:shopId/staff/:staffId ────────────────────────────────────

staff.get("/:staffId", async (c) => {
  const shopId = c.req.param("shopId")!;
  const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }
  const services = await getStaffServices(c.env.DB, staffId);
  return c.json({ success: true, data: { ...member, services } });
});

// ─── POST /api/shops/:shopId/staff ───────────────────────────────────────────
// Creates a user account then a staff record

staff.post("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await c.req.json<{
    display_name?: string;
    email?: string;
    password?: string;
    bio?: string;
    service_ids?: string[];
  }>();

  if (!body.display_name || !body.email) {
    return c.json({ success: false, error: "display_name and email are required" }, 400);
  }

  // Reject a duplicate email up front with a clear 409 instead of letting the
  // createUser unique-constraint violation surface as an opaque 500.
  const existingUser = await getUserByEmail(c.env.DB, body.email);
  if (existingUser) {
    return c.json({ success: false, error: "Email already registered" }, 409);
  }

  // Create a platform_users account for the staff member
  const userId = crypto.randomUUID();
  const tempPassword = body.password ?? crypto.randomUUID().slice(0, 12);

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(tempPassword), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  const password_hash = `${saltB64}:${hash}`;

  await createUser(c.env.DB, { id: userId, email: body.email, password_hash, role: "staff", shop_id: shopId });

  const staffId = crypto.randomUUID();
  await createStaffMember(c.env.DB, {
    id: staffId,
    shop_id: shopId,
    user_id: userId,
    display_name: body.display_name,
    bio: body.bio ?? null,
  });

  // Assign services if provided
  if (body.service_ids?.length) {
    await Promise.all(body.service_ids.map((sid) => addStaffService(c.env.DB, staffId, sid)));
  }

  return c.json({
    success: true,
    data: { id: staffId, user_id: userId, ...(body.password ? {} : { temp_password: tempPassword }) },
  }, 201);
});

// ─── PUT /api/shops/:shopId/staff/:staffId ────────────────────────────────────

staff.put("/:staffId", async (c) => {
  const shopId = c.req.param("shopId")!; const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }

  const body = await c.req.json<{
    display_name?: string;
    bio?: string | null;
    service_ids?: string[];
  }>();

  await updateStaffMember(c.env.DB, staffId, {
    display_name: body.display_name,
    bio: body.bio,
  });

  if (body.service_ids) {
    await c.env.DB.prepare("DELETE FROM staff_services WHERE staff_id = ?").bind(staffId).run();
    await Promise.all(body.service_ids.map((sid) => addStaffService(c.env.DB, staffId, sid)));
  }

  const updated = await getStaffById(c.env.DB, staffId);
  return c.json({ success: true, data: updated });
});

// ─── DELETE /api/shops/:shopId/staff/:staffId (soft-delete) ──────────────────

staff.delete("/:staffId", async (c) => {
  const shopId = c.req.param("shopId")!; const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }
  await updateStaffMember(c.env.DB, staffId, { is_active: 0 });
  return c.json({ success: true });
});

// ─── POST /api/shops/:shopId/staff/:staffId/avatar ────────────────────────────

staff.post("/:staffId/avatar", async (c) => {
  const shopId = c.req.param("shopId")!;
  const staffId = c.req.param("staffId")!;

  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }

  let form: Record<string, unknown>;
  try {
    form = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: "Invalid multipart body" }, 400);
  }

  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ success: false, error: "file required" }, 400);
  }
  if (file.size > 5 * 1024 * 1024) {
    return c.json({ success: false, error: "File too large (max 5MB)" }, 400);
  }

  const ext = file.name.match(/\.(png|jpg|jpeg|webp)$/i)?.[1]?.toLowerCase() ?? "jpg";
  const contentType =
    file.type ||
    (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");

  const key = `staff/${shopId}/${staffId}/avatar.${ext}`;
  const buf = await file.arrayBuffer();
  await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType } });

  let base = (c.env.ASSET_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base) base = `https://assets.pivot-parlor.com`;
  const avatarUrl = `${base}/${key}`;

  await updateStaffMember(c.env.DB, staffId, { avatar_url: avatarUrl });

  return c.json({ success: true, avatarUrl });
});

export default staff;
