import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getStaffByShop, getStaffById, createStaffMemberStmt, updateStaffMemberStmt,
  addStaffServiceStmt, getStaffServices, createUserStmt, getUserByEmail,
} from "../db/queries.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, batchWithAudit, statusOutcome } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { hashPassword } from "../lib/password.js";

const staff = new Hono<{ Bindings: Bindings }>();

// All routes require auth; reads are admin+staff, mutations are admin-only
// (staff manage their own data via /api/staff/me, not these shop-scoped routes).
staff.use("*", authMiddleware);

// ─── GET /api/shops/:shopId/staff ─────────────────────────────────────────────

staff.get("/", requireShopRole("admin", "staff"), async (c) => {
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

staff.get("/:staffId", requireShopRole("admin", "staff"), async (c) => {
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

staff.post("/", requireShopRole("admin"), async (c) => {
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

  const password_hash = await hashPassword(tempPassword);

  const staffId = crypto.randomUUID();
  const serviceIds = [...new Set(body.service_ids ?? [])];

  // One batch: the user, the staff row, the service links and the audit entry
  // commit together or not at all (no orphan platform_users row).
  // email_verified: the account is provisioned by the shop admin (operator-vouched).
  const refused = await batchWithAudit(
    c,
    [
      createUserStmt(c.env.DB, { id: userId, email: body.email, password_hash, role: "staff", shop_id: shopId, email_verified: 1 }),
      createStaffMemberStmt(c.env.DB, {
        id: staffId,
        shop_id: shopId,
        user_id: userId,
        display_name: body.display_name,
        bio: body.bio ?? null,
      }),
      ...serviceIds.map((sid) => addStaffServiceStmt(c.env.DB, staffId, sid)),
    ],
    {
      action: "staff.create",
      outcome: "succeeded",
      shopId,
      entityType: "staff",
      entityId: staffId,
      changes: { is_active: [null, 1] },
      // Ids and counts only: never the name, email, bio or temporary password.
      details: { user_id: userId, services: serviceIds.length, temp_password_issued: !body.password },
    },
  );
  if (refused) return refused;

  return c.json({
    success: true,
    data: { id: staffId, user_id: userId, ...(body.password ? {} : { temp_password: tempPassword }) },
  }, 201);
});

// ─── PUT /api/shops/:shopId/staff/:staffId ────────────────────────────────────

staff.put("/:staffId", requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!; const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }

  const body = await c.req.json<{
    display_name?: string;
    bio?: string | null;
    speciality?: string | null;
    service_ids?: string[];
  }>();

  // Specialism is a short public label ("Skin fades & beard work"); empty
  // clears it, anything else is trimmed and capped.
  const speciality =
    body.speciality === undefined
      ? undefined
      : typeof body.speciality === "string" && body.speciality.trim()
        ? body.speciality.trim().slice(0, 80)
        : null;

  // Only the columns the update writes, so a stray body key never shows as changed.
  const columns = { display_name: body.display_name, bio: body.bio, speciality };
  const { changes, fields: changed } = fieldChanges(member as unknown as Record<string, unknown>, columns);
  const serviceIds = body.service_ids ? [...new Set(body.service_ids)] : null;

  const stmts = [
    updateStaffMemberStmt(c.env.DB, staffId, columns),
    ...(serviceIds
      ? [
          c.env.DB.prepare("DELETE FROM staff_services WHERE staff_id = ?").bind(staffId),
          ...serviceIds.map((sid) => addStaffServiceStmt(c.env.DB, staffId, sid)),
        ]
      : []),
  ].filter((s) => s !== null);
  const details: Record<string, unknown> = {};
  if (changed.length > 0) details.fields = changed;
  if (serviceIds) details.services = serviceIds.length;
  const refused = await batchWithAudit(c, stmts, {
    action: "staff.update",
    outcome: "succeeded",
    shopId,
    entityType: "staff",
    entityId: staffId,
    changes,
    details: Object.keys(details).length > 0 ? details : null,
  });
  if (refused) return refused;

  const updated = await getStaffById(c.env.DB, staffId);
  return c.json({ success: true, data: updated });
});

// ─── DELETE /api/shops/:shopId/staff/:staffId (soft-delete) ──────────────────

staff.delete("/:staffId", requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!; const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }
  const refused = await batchWithAudit(c, [updateStaffMemberStmt(c.env.DB, staffId, { is_active: 0 })!], {
    action: "staff.delete",
    outcome: "succeeded",
    shopId,
    entityType: "staff",
    entityId: staffId,
    // Diffed, so deleting an already inactive member records no change.
    changes: fieldChanges(member as unknown as Record<string, unknown>, { is_active: 0 }).changes,
  });
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── POST /api/shops/:shopId/staff/:staffId/avatar ────────────────────────────

staff.post("/:staffId/avatar", requireShopRole("admin"), async (c) => {
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

  // Pattern T: the started entry commits before the R2 write, so an upload
  // that cannot be recorded never happens (503, nothing written).
  try {
    return await auditFor(c).run(
      {
        action: "staff.update",
        shopId,
        entityType: "staff",
        entityId: staffId,
        details: { fields: ["avatar_url"] },
      },
      async (): Promise<Response> => {
        const buf = await file.arrayBuffer();
        await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType } });

        let base = (c.env.ASSET_BASE_URL ?? "").trim().replace(/\/$/, "");
        if (!base) base = `https://assets.pivot-parlor.com`;
        // The key is fixed per member, so a replacement photo would sit behind the
        // old one's day-long cache; the version makes each upload a new URL.
        const avatarUrl = `${base}/${key}?v=${Date.now().toString(36)}`;

        await updateStaffMemberStmt(c.env.DB, staffId, { avatar_url: avatarUrl })!.run();

        return c.json({ success: true, avatarUrl });
      },
      statusOutcome(),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default staff;
