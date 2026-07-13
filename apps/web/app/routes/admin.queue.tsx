// apps/web/app/routes/admin.queue.tsx
import { useLoaderData, useFetcher } from "@remix-run/react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useState, useEffect } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

interface QueueEntry {
  id: string;
  name: string;
  phone: string | null;
  service: string | null;
  position: number;
  status: string;
  notes: string | null;
  created_at: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;

  let queue: QueueEntry[] = [];
  let shopSlug = "";
  try {
    queue = await api.get<QueueEntry[]>(`/api/shops/${shopId}/walkin`);
    const shop = await api.get<{ slug: string }>(`/api/shops/${shopId}`);
    shopSlug = shop.slug ?? "";
  } catch { /* empty */ }

  return json({ queue, shopId, shopSlug });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "updateStatus") {
    const entryId = form.get("entryId") as string;
    const status = form.get("status") as string;
    await api.patch(`/api/shops/${shopId}/walkin/${entryId}`, { status });
    return json({ ok: true });
  }
  if (intent === "clearQueue") {
    await api.del(`/api/shops/${shopId}/walkin`);
    return json({ ok: true });
  }
  return json({ ok: false }, 400);
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function QRCode({ url }: { url: string }) {
  // Use QR Server API — no npm package needed
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&bgcolor=111111&color=C9A84C&margin=10`;
  return (
    <div className="flex flex-col items-center gap-3">
      <img src={qrUrl} alt="Walk-in QR code" className="w-40 h-40 rounded-xl border border-white/10" />
      <p className="text-xs text-white/40 text-center break-all max-w-[180px]">{url}</p>
    </div>
  );
}

export default function AdminQueue() {
  const { queue: initialQueue, shopId, shopSlug } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean }>();
  const [queue, setQueue] = useState<QueueEntry[]>(initialQueue);
  const [showQR, setShowQR] = useState(false);

  const walkinUrl = typeof window !== "undefined"
    ? `${window.location.origin}/${shopSlug}/walkin`
    : `https://pivot-parlor-web.pages.dev/${shopSlug}/walkin`;

  // Poll queue every 30s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/shops/${shopId}/walkin-poll`);
        if (res.ok) {
          const data = await res.json() as { data?: QueueEntry[] };
          if (data.data) setQueue(data.data);
        }
      } catch { /* non-fatal */ }
    };
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [shopId]);

  // Optimistic update from fetcher
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      // Revalidate via loader
    }
  }, [fetcher.state, fetcher.data]);

  function updateStatus(entryId: string, status: string) {
    // Optimistic
    setQueue(prev => prev.filter(e => !(status === "served" || status === "removed" || status === "skipped") || e.id !== entryId)
      .map(e => e.id === entryId ? { ...e, status } : e));
    const form = new FormData();
    form.append("intent", "updateStatus");
    form.append("entryId", entryId);
    form.append("status", status);
    fetcher.submit(form, { method: "post" });
  }

  const waiting = queue.filter(e => e.status === "waiting");
  const serving = queue.filter(e => e.status === "serving");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Walk-in Queue</h1>
          <p className="mt-0.5 text-sm text-white/40">
            {waiting.length} waiting · {serving.length} being served · refreshes every 30s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowQR(v => !v)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/20 text-sm text-white/70 hover:bg-white/5 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
            </svg>
            {showQR ? "Hide QR" : "Show QR"}
          </button>
          <fetcher.Form method="post" onSubmit={e => { if (!confirm("Clear the entire queue?")) e.preventDefault(); }}>
            <input type="hidden" name="intent" value="clearQueue" />
            <button type="submit"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-sm text-red-400 hover:bg-red-500/10 transition-colors">
              Clear queue
            </button>
          </fetcher.Form>
        </div>
      </div>

      {/* QR Code panel */}
      {showQR && (
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6 flex flex-col sm:flex-row items-center gap-6">
          <QRCode url={walkinUrl} />
          <div>
            <h3 className="font-semibold text-white mb-1">Walk-in QR Code</h3>
            <p className="text-sm text-white/50 mb-3">Customers scan this to join the queue from their phone.</p>
            <a href={walkinUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-gold hover:underline break-all">{walkinUrl}</a>
            <p className="text-xs text-white/50 mt-3">Print and display at your entrance or counter.</p>
          </div>
        </div>
      )}

      {/* Currently serving */}
      {serving.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gold/70 uppercase tracking-wider mb-3">Now serving</h2>
          <div className="space-y-2">
            {serving.map(entry => (
              <div key={entry.id} className="flex items-center gap-4 rounded-xl border border-gold/25 bg-gold/5 px-5 py-4">
                <div className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center font-bold text-gold text-sm shrink-0">
                  {entry.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white">{entry.name}</p>
                  {entry.service && <p className="text-xs text-white/50">{entry.service}</p>}
                </div>
                <button onClick={() => updateStatus(entry.id, "served")}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/30 transition-colors">
                  Mark served ✓
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Waiting queue */}
      <div>
        <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Waiting {waiting.length > 0 ? `(${waiting.length})` : ""}
        </h2>
        {waiting.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/50 text-sm">
            Queue is empty. Show the QR code to customers to get started.
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-dark-100 divide-y divide-white/5 overflow-hidden">
            {waiting.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-4 px-5 py-4 hover:bg-white/[0.02] transition-colors">
                {/* Position */}
                <div className="w-8 shrink-0 text-center">
                  <span className="text-lg font-bold text-white/50">{entry.position}</span>
                </div>
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center font-semibold text-white/60 text-sm shrink-0">
                  {entry.name.charAt(0).toUpperCase()}
                </div>
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-white">{entry.name}</p>
                  <p className="text-xs text-white/40">
                    {entry.service ? `${entry.service} · ` : ""}{timeAgo(entry.created_at)}
                    {entry.phone ? ` · ${entry.phone}` : ""}
                  </p>
                </div>
                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {i === 0 && (
                    <button onClick={() => updateStatus(entry.id, "serving")}
                      className="px-3 py-1.5 rounded-lg bg-gold/20 text-gold text-xs font-semibold hover:bg-gold/30 transition-colors">
                      Call next
                    </button>
                  )}
                  <button onClick={() => updateStatus(entry.id, "skipped")}
                    className="px-2 py-1.5 rounded-lg text-white/50 hover:text-white/60 hover:bg-white/5 text-xs transition-colors">
                    Skip
                  </button>
                  <button onClick={() => updateStatus(entry.id, "removed")}
                    className="px-2 py-1.5 rounded-lg text-white/50 hover:text-red-400 hover:bg-red-500/10 text-xs transition-colors">
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
