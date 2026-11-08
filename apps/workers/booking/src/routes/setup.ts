import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import { countWhere } from "../lib/d1-helpers.js";
import { shopExists } from "../middleware/shop-access.js";
import { batchWithAudit } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";

const r = new Hono<{ Bindings: Env }>();

export async function computeSetupState(db: D1Database, shopId: string): Promise<{
  checklist: Record<string, boolean>;
  ready_to_go_live: boolean;
}> {
  const has_services =
    (await countWhere(
      db,
      "SELECT COUNT(*) AS n FROM services WHERE shop_id = ? AND is_active = 1",
      shopId
    )) >= 1;

  const has_staff =
    (await countWhere(db, "SELECT COUNT(*) AS n FROM staff WHERE shop_id = ? AND is_active = 1", shopId)) >= 1;

  const staff_assigned_to_services =
    (await countWhere(
      db,
      `SELECT COUNT(*) AS n FROM staff_services ss
       INNER JOIN staff s ON s.id = ss.staff_id
       WHERE s.shop_id = ?`,
      shopId
    )) >= 1;

  const staff_availability_set =
    (await countWhere(db, "SELECT COUNT(*) AS n FROM schedules WHERE shop_id = ? AND is_active = 1", shopId)) >= 1;

  const shop = await db
    .prepare(
      "SELECT stripe_connect_onboarded, setup_completed FROM shops WHERE id = ? LIMIT 1"
    )
    .bind(shopId)
    .first<{ stripe_connect_onboarded: number | null; setup_completed: number | null }>();

  const stripe_connect_onboarded = Number(shop?.stripe_connect_onboarded ?? 0) === 1;

  const settings = await db
    .prepare("SELECT address, hours_json, sells_products FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ address: string | null; hours_json: string | null; sells_products: number | null }>();

  const has_address_and_hours = Boolean(
    settings?.address?.trim() && settings?.hours_json?.trim()
  );

  const products_required = Number(settings?.sells_products ?? 0) === 1;

  const has_products = products_required
    ? (await countWhere(
        db,
        "SELECT COUNT(*) AS n FROM services WHERE shop_id = ? AND is_active = 1 AND service_type = 'product'",
        shopId
      )) >= 1
    : true;

  const site = await db
    .prepare("SELECT status FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1")
    .bind(shopId)
    .first<{ status: string }>();
  const site_generated = Boolean(site?.status === "active");

  const checklist = {
    has_services,
    has_staff,
    staff_assigned_to_services,
    staff_availability_set,
    stripe_connect_onboarded,
    has_address_and_hours,
    products_required,
    has_products,
    site_generated,
  };

  const ready_to_go_live =
    has_services &&
    has_staff &&
    staff_assigned_to_services &&
    staff_availability_set &&
    stripe_connect_onboarded &&
    has_address_and_hours &&
    has_products &&
    site_generated;

  return { checklist, ready_to_go_live };
}

r.get("/:shopId/setup-status", async (c) => {
  const shopId = c.req.param("shopId");
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }
  const { checklist, ready_to_go_live } = await computeSetupState(c.env.DB, shopId);
  const setup_completed =
    Number(
      (
        await c.env.DB.prepare("SELECT setup_completed FROM shops WHERE id = ?").bind(shopId).first<{ setup_completed: number }>()
      )?.setup_completed ?? 0
    ) === 1;

  return c.json({
    shopId,
    setup_completed,
    checklist,
    ready_to_go_live,
  });
});

r.post("/:shopId/complete-setup", async (c) => {
  const shopId = c.req.param("shopId");
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }
  const { ready_to_go_live, checklist } = await computeSetupState(c.env.DB, shopId);
  if (!ready_to_go_live) {
    return c.json(
      {
        success: false,
        error: "Setup checklist incomplete",
        checklist,
      },
      400
    );
  }
  const before = await c.env.DB
    .prepare("SELECT setup_completed FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ setup_completed: number | null }>();
  const refused = await batchWithAudit(
    c,
    [c.env.DB.prepare("UPDATE shops SET setup_completed = 1 WHERE id = ?").bind(shopId)],
    {
      action: "shop.setup.complete",
      outcome: "succeeded",
      shopId,
      entityType: "shop",
      entityId: shopId,
      // A repeat (already 1) records succeeded with no changes.
      changes: fieldChanges({ setup_completed: Number(before?.setup_completed ?? 0) }, { setup_completed: 1 }).changes,
    }
  );
  if (refused) return refused;
  return c.json({ success: true, shopId, setup_completed: true });
});

export default r;
