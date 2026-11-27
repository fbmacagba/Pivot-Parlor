import { useEffect, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  data as json,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { ErasureRequestDialog, type ErasureTarget } from "~/components/audit/ErasureRequestDialog";
import { parseChanges, parseDetails } from "~/components/audit/entryJson";
import {
  ACTION_GROUPS,
  actionLabel,
  auditQuery,
  dateOnlyQuery,
  entryStatus,
  formatAuditDate,
  formatAuditDateTime,
  pipelineActorLabel,
  verifyContinueFrom,
  verifyMessage,
  type VerifyResult,
} from "~/lib/audit";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

export const meta = () => pageTitle("Activity");

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

/** Just enough of a shop to name it in the filter and on each entry. */
interface ShopName {
  id: string;
  name: string;
}

interface Entry {
  id: string;
  occurred_at: string;
  seq: number | null;
  sealed_at: string | null;
  archived_at: string | null;
  action: string;
  phase: string;
  outcome: string | null;
  reason: string | null;
  actor_type: string;
  actor_ref: string | null;
  actor_name: string | null;
  actor_email: string | null;
  redacted: boolean;
  origin_name?: string | null;
  origin_redacted?: boolean;
  ip: string | null;
  ip_ref: string | null;
  shop_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes_json: string | null;
  details_json: string | null;
  request_id: string | null;
  historical: number;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  // The dev.tsx layout's check does not run for a data request that names only
  // this route (/dev/activity.data?_routes=routes%2Fdev.activity).
  await requireRole(request, "developer", env.API_URL);
  const api = createApiClient(env.API_URL, getSessionToken(request));
  const qs = auditQuery(new URL(request.url).searchParams);
  // The shops list only puts names on ids (the filter's picker, each entry's
  // shop). The trail does not depend on it, so the two go out together and a
  // failed shops read just leaves ids showing.
  const [trail, shopList] = await Promise.allSettled([
    api.get<{ entries: Entry[]; next_cursor: string | null }>(`/api/audit${qs ? `?${qs}` : ""}`),
    api.get<ShopName[]>("/api/shops"),
  ]);
  const shops: ShopName[] =
    shopList.status === "fulfilled" && Array.isArray(shopList.value)
      ? shopList.value.map((s) => ({ id: s.id, name: s.name }))
      : [];
  const shopsLoaded = shopList.status === "fulfilled" && Array.isArray(shopList.value);
  if (trail.status === "fulfilled" && Array.isArray(trail.value?.entries)) {
    return json({
      entries: trail.value.entries,
      next_cursor: trail.value.next_cursor ?? null,
      error: null as string | null,
      shops,
      shopsLoaded,
    });
  }
  const reason = trail.status === "rejected" ? trail.reason : null;
  return json({
    entries: [] as Entry[],
    next_cursor: null,
    error: reason instanceof Error ? reason.message : "Could not load activity",
    shops,
    shopsLoaded,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  // Outside the try below: its catch would turn the thrown redirect into an
  // error message. A POST runs only this action, never the layout's loader.
  await requireRole(request, "developer", env.API_URL);
  const api = createApiClient(env.API_URL, getSessionToken(request));
  const form = await readFormData(request);
  if (!form) return json({ error: UNREADABLE_FORM }, { status: 400 });
  const intent = form.get("intent");
  try {
    if (intent === "verify") {
      const from = Number(form.get("from_seq")) || undefined;
      const to = Number(form.get("to_seq")) || undefined;
      return json({ verify: await api.post<VerifyResult>("/api/audit/verify", { from_seq: from, to_seq: to }), error: null });
    }
    if (intent === "import") {
      const r = await api.post<{ imported: number; more: boolean }>("/api/audit/import-historical");
      return json({ imported: r, error: null });
    }
    if (intent === "erase") {
      const userId = String(form.get("user_id") ?? "");
      // The route can genuinely return a null redact_after (a subject
      // already redacted, with no date ever set) — kept nullable here
      // rather than the earlier `string` type, which would have crashed
      // the page's own render on that value.
      return json({ erased: await api.post<{ redact_after: string | null }>(`/api/audit/subjects/${encodeURIComponent(userId)}/erase`), error: null });
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Request failed" });
  }
  return json({ error: "Unknown request" });
}

function Changes({ json: raw }: { json: string | null }) {
  const changes = parseChanges(raw);
  if (!changes) return null;
  // One unreadable entry costs its own detail, never the page.
  if (!changes.ok) return <p className="mt-2 text-sm text-white/70">Changes: details unavailable for this entry.</p>;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {changes.rows.map((row) => (
        <li key={row.field} className="break-words">
          <span className="text-white/60">{row.field}:</span>{" "}
          {row.before !== "" && (
            <>
              <span className="sr-only">was </span>
              <span className="text-white/60 line-through">{row.before}</span> <span className="sr-only">now </span>
            </>
          )}
          <span className="text-white">{row.after}</span>
        </li>
      ))}
    </ul>
  );
}

function Details({ json: raw }: { json: string | null }) {
  const details = parseDetails(raw);
  if (!details) return null;
  if (!details.ok) return <p className="text-sm text-white/70">Details unavailable for this entry.</p>;
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-xs">{details.pretty}</pre>
  );
}

export default function DevActivity() {
  const { entries, next_cursor, error, shops, shopsLoaded } = useLoaderData<typeof loader>();
  const shopNames = new Map(shops.map((s) => [s.id, s.name]));
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const nav = useNavigation();
  // Ruling 51: erasure needs an explicit confirmation step (ErasureRequestDialog)
  // rather than firing straight from a list-row button — this tracks WHICH
  // person the dialog is confirming for; the dialog's own Form does the
  // actual submit once the developer confirms.
  const [confirmErase, setConfirmErase] = useState<ErasureTarget | null>(null);
  // Fix round 2 re-review (CRITICAL regression on Ruling 51): the dialog
  // must NOT close itself from the click that submits it (that unmounts
  // its own <form> before the browser's native submit step runs — see
  // ErasureRequestDialog.tsx's header comment for the full story). It
  // closes from the submission's OUTCOME instead, read here from this
  // page's own useNavigation()/useActionData(): once nav.state returns to
  // "idle" this closes the dialog on success or surfaces the error INSIDE
  // it (DeleteShopDialog's own pattern) on failure — never both silently.
  //
  // Fix round 3 (progress.md, Ruling 52 — Important race): round 2's
  // `erasingRef` was a bare boolean, and the dialog could still be
  // dismissed (Cancel / Escape / overlay-click) while a submission was in
  // flight. That let a developer confirm erase for subject A, cancel out
  // of A's still-in-flight dialog, open the dialog for subject B, and then
  // have A's outcome land on B's dialog when A settled — closing it, or
  // showing A's error on it, for a request B never made. Two changes fix
  // this:
  //   1. The dialog itself can no longer be dismissed while ITS erase is
  //      in flight (Cancel disabled, Escape/overlay-click ignored — see
  //      ErasureRequestDialog.tsx's `busy`-gated onOpenChange), so the
  //      "cancel out from under an in-flight request" step is no longer
  //      possible at all.
  //   2. Defense in depth regardless: the ref now remembers the in-flight
  //      submission's user_id (not just "an erase is happening"), and the
  //      settled outcome is only applied if that user_id still matches
  //      whichever target's dialog is currently open — a stale outcome
  //      for a subject that isn't (or is no longer) the open dialog's
  //      target is silently ignored rather than misapplied.
  const [eraseError, setEraseError] = useState<string | null>(null);
  const erasingUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (nav.state !== "idle") {
      if (nav.formData?.get("intent") === "erase") {
        erasingUserIdRef.current = String(nav.formData.get("user_id") ?? "");
      }
      return;
    }
    const erasedUserId = erasingUserIdRef.current;
    if (!erasedUserId) return;
    erasingUserIdRef.current = null;
    // The outcome belongs to whichever subject was submitted — apply it
    // only if that's still the subject the dialog has open.
    if (confirmErase?.userId !== erasedUserId) return;
    if (result && "erased" in result && result.erased) {
      setConfirmErase(null);
      setEraseError(null);
    } else {
      setEraseError((result && "error" in result && result.error) || "Request failed");
    }
  }, [nav.state, nav.formData, result, confirmErase]);
  // Erase-specific busy flag (Ruling 52): true only while the in-flight
  // navigation is an erase submission for THIS dialog's own open target —
  // not `nav.state !== "idle"` on its own, which is also true during any
  // unrelated verify/import submission. Drives both the Confirm button's
  // disabled state and the dialog's can't-be-dismissed-mid-request gate.
  const eraseBusy =
    nav.state !== "idle" &&
    nav.formData?.get("intent") === "erase" &&
    nav.formData?.get("user_id") === confirmErase?.userId;
  const closeEraseDialog = () => {
    setConfirmErase(null);
    setEraseError(null);
  };
  // Which of this page's own posts is in flight, so its button can say so.
  const pendingIntent = nav.state !== "idle" ? (nav.formData?.get("intent") ?? null) : null;
  const filterShopId = params.get("shop_id") ?? "";
  const sealed = entries.filter((e) => e.seq !== null).map((e) => e.seq as number);
  // After a check that stopped at its read limit, the next click picks up
  // from the entry after the last one it checked.
  const continueFrom = result && "verify" in result && result.verify ? verifyContinueFrom(result.verify) : null;
  const qs = auditQuery(params);
  // The subject export takes only from/to, not the full filter set (see
  // dev.activity.export.tsx) — carried onto both "Export their/this
  // visitor's data" links below so a filtered date range is actually
  // actionable there, not just on the list/CSV/proof export.
  const dateQs = dateOnlyQuery(params);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl text-white">Activity</h1>
          <p className="text-sm text-white/60">Every recorded change, AI call and data access. Entries can be added, never edited.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Plain links, not router links: each answers with a file download. */}
          <Button asChild variant="outline">
            <a href={`/dev/activity/export?part=csv${qs ? `&${qs}` : ""}`}>Export CSV</a>
          </Button>
          <Button asChild variant="outline">
            <a href={`/dev/activity/export?part=proof${qs ? `&${qs}` : ""}`}>Export proof</a>
          </Button>
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            {(continueFrom !== null || sealed.length > 0) && (
              <input type="hidden" name="from_seq" value={continueFrom ?? Math.min(...sealed)} />
            )}
            {sealed.length > 0 && <input type="hidden" name="to_seq" value={Math.max(...sealed)} />}
            <Button type="submit" disabled={nav.state !== "idle"}>
              {pendingIntent === "verify" ? "Checking…" : "Check now"}
            </Button>
          </Form>
        </div>
      </header>

      {result && "verify" in result && result.verify && (
        <p
          role="status"
          className={
            result.verify.checked === 0 ? "text-white/70" : result.verify.ok ? "text-emerald-400" : "text-red-400"
          }
        >
          {verifyMessage(result.verify)}
        </p>
      )}
      {result && "imported" in result && result.imported && (
        <p role="status" className="text-white/80">Imported {result.imported.imported} AI usage rows{result.imported.more ? "; run again for more." : "."}</p>
      )}
      {result && "erased" in result && result.erased && (
        <p role="status" className="text-white/80">
          {result.erased.redact_after
            ? `Erasure recorded. Personal details will be blanked on ${formatAuditDate(result.erased.redact_after)}.`
            : "Erasure recorded. This person's details are already scheduled to be blanked."}
        </p>
      )}
      {result && result.error && <p role="alert" className="text-red-400">{result.error}</p>}

      {/* key: the fields are uncontrolled, so a new address (a link on an
          entry, Back) must rebuild them or they keep showing the old filter. */}
      <Form
        key={params.toString()}
        method="get"
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {shopsLoaded ? (
          <Select label="Shop" name="shop_id" defaultValue={filterShopId}>
            <option value="">All shops</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {filterShopId && !shopNames.has(filterShopId) && (
              <option value={filterShopId}>{filterShopId} (not in the shops list)</option>
            )}
          </Select>
        ) : (
          // The shops list could not be read, so the picker has no names to
          // offer; the filter still works by id.
          <Input name="shop_id" label="Shop id (shop names could not be loaded)" defaultValue={filterShopId} />
        )}
        <Input
          name="actor"
          label="Person reference"
          placeholder="subj_user_…"
          autoCapitalize="off"
          spellCheck={false}
          defaultValue={params.get("actor") ?? ""}
        />
        <Input type="date" name="from" label="From" defaultValue={params.get("from") ?? ""} />
        <Input type="date" name="to" label="To" defaultValue={params.get("to") ?? ""} />
        <Select label="Action" name="action" defaultValue={params.get("action") ?? ""}>
          {ACTION_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
        <Select label="Outcome" name="outcome" defaultValue={params.get("outcome") ?? ""}>
          <option value="">Any outcome</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="refused">Refused</option>
          <option value="unknown">Unknown</option>
        </Select>
        <Button type="submit">Filter</Button>
        <p className="text-xs text-white/60 sm:col-span-2 lg:col-span-4">
          To see one person&apos;s activity, open any of their entries and choose &quot;All activity by this
          person&quot;: it fills in their reference.
        </p>
      </Form>

      {error && <LoadError what="the activity trail" />}

      <ol className="space-y-2">
        {entries.length === 0 && !error && <li className="text-white/60">No activity matches these filters.</li>}
        {entries.map((e) => {
          const status = entryStatus(e);
          const who = e.redacted ? "Redacted" : pipelineActorLabel(e) ?? e.actor_name ?? e.actor_email ?? (e.actor_type === "system" ? "System" : e.actor_type === "anonymous" ? "Visitor" : e.actor_type);
          return (
            <li key={e.id} className="rounded-lg border border-white/10 bg-white/[0.02]">
              <details>
                <summary className="tap-target flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <time className="text-xs text-white/60" dateTime={e.occurred_at}>{formatAuditDateTime(e.occurred_at)}</time>
                  <span className="min-w-[9rem] flex-1 font-medium text-white">{actionLabel(e.action)}{e.phase === "started" ? " (started)" : ""}</span>
                  <span className="text-sm text-white/70">{who}</span>
                  {e.shop_id && shopNames.has(e.shop_id) && (
                    <span className="text-sm text-white/60">{shopNames.get(e.shop_id)}</span>
                  )}
                  {e.outcome && <Badge variant={e.outcome === "succeeded" ? "success" : e.outcome === "unknown" ? "warning" : "error"}>{e.outcome}</Badge>}
                  <Badge variant={status.variant} className="ml-auto">{status.label}</Badge>
                  {e.historical === 1 && <Badge variant="outline">Historical</Badge>}
                </summary>
                <div className="space-y-2 border-t border-white/10 px-4 py-3 text-sm text-white/70">
                  {e.reason && <p>Reason: {e.reason}</p>}
                  {e.shop_id && (
                    <p>
                      Shop:{" "}
                      <a
                        className="tap-target inline-flex items-center underline"
                        href={`/dev/activity?shop_id=${encodeURIComponent(e.shop_id)}`}
                        title="Show only this shop's activity"
                      >
                        {shopNames.get(e.shop_id) ?? e.shop_id}
                      </a>
                      {shopNames.has(e.shop_id) && <span className="text-white/60"> ({e.shop_id})</span>}
                    </p>
                  )}
                  {e.entity_type && <p>Item: {e.entity_type} {e.entity_id}</p>}
                  <Changes json={e.changes_json} />
                  <Details json={e.details_json} />
                  {e.request_id && <p><a className="tap-target inline-flex items-center underline" href={`/dev/activity?request_id=${encodeURIComponent(e.request_id)}`}>Everything from this request</a></p>}
                  {e.ip && !e.redacted && <p>IP: {e.ip}</p>}
                  {e.seq !== null && <p>Entry number {e.seq}</p>}
                  {e.actor_ref?.startsWith("subj_user_") && !e.redacted && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a className="tap-target underline" href={`/dev/activity?actor=${encodeURIComponent(e.actor_ref)}`}>All activity by this person</a>
                      <a className="tap-target underline" href={`/dev/activity/export?subject=${encodeURIComponent(e.actor_ref)}${dateQs ? `&${dateQs}` : ""}`}>Export their data</a>
                      <Button
                        type="button"
                        variant="ghost"
                        className="tap-target"
                        onClick={() => {
                          setEraseError(null);
                          setConfirmErase({ userId: e.actor_ref!.slice("subj_user_".length), who });
                        }}
                      >
                        Record erasure request
                      </Button>
                    </div>
                  )}
                  {/* Erasure is user-only (the route takes a userId), and a
                      shop subject (subj_shop_<id>) is created only when that
                      shop is deleted (apps/worker/src/routes/shops.ts's
                      shop.delete handler) — a live shop has no such row, so
                      no "export this shop's data" link is offered here; it
                      would 404 for every live shop. A visitor_ip subject has
                      neither an actor_ref-based filter in the API nor an
                      erasure route, but its export works via ip_ref alone. */}
                  {e.ip_ref && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a className="tap-target underline" href={`/dev/activity/export?subject=${encodeURIComponent(e.ip_ref)}${dateQs ? `&${dateQs}` : ""}`}>Export this visitor&apos;s data</a>
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap justify-between gap-3">
        {next_cursor ? (
          <a className="tap-target underline" href={`/dev/activity?${auditQuery(new URLSearchParams({ ...Object.fromEntries(params), cursor: next_cursor }))}`}>Older entries</a>
        ) : <span />}
        <Form method="post">
          <input type="hidden" name="intent" value="import" />
          <Button type="submit" variant="secondary" disabled={nav.state !== "idle"}>
            {pendingIntent === "import" ? "Importing…" : "Import AI usage history"}
          </Button>
        </Form>
      </div>

      <ErasureRequestDialog
        target={confirmErase}
        onClose={closeEraseDialog}
        busy={eraseBusy}
        error={eraseError}
      />
    </div>
  );
}
