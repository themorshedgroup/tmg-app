// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: zoho-projects-poll
// Zoho Projects → TMG pull direction (plan: hidden-wiggling-lamport §4).
// Cron-invoked every 15 min (pg_cron), same shape as sffu-sender: a shared
// CRON_SECRET header authenticates the caller instead of a user session.
//
// Deploy: Supabase Dashboard → Edge Functions → new function `zoho-projects-poll`
//   Paste this whole file, then click Deploy. Leave "Verify JWT" OFF — auth
//   is the CRON_SECRET check below, not a Supabase session (there is no user).
//
// Secrets (Dashboard → Edge Functions → Manage secrets):
//   CRON_SECRET          = same long random string as the pg_cron job sends
//   ZOHO_CLIENT_ID        = same Zoho API client as zoho-projects/zoho-crm
//   ZOHO_CLIENT_SECRET
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Self-contained by convention (no sibling imports) — the token-mint/cache
// helpers and Zoho field-mapping functions here are deliberately duplicated
// from zoho-projects/index.ts rather than shared.
//
// One `list_tasks` call PER LINKED CTC FILE per cycle (not per task) to stay
// under Zoho Projects' 100-calls/2-min rate limit — see the interval math
// note near the bottom of this file before changing the cron schedule.
//
// Conflict rule (plan §5, confirmed): last-write-wins by timestamp, always
// logged — no on-screen recovery banner, just a queryable row in
// zoho_sync_conflicts plus a plain-English task_activity entry.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// ── Zoho OAuth token mint/cache — duplicated from zoho-projects/index.ts ──
async function mintZohoToken(refreshToken: string, accountsUrl: string) {
  const clientId = Deno.env.get("ZOHO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET") || "";
  const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" });
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Failed to refresh Zoho token");
  const expiresIn = Number(data.expires_in) || 3600;
  return { access_token: data.access_token, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() };
}
async function getZohoToken(sb: any, conn: any): Promise<string> {
  const BUFFER_MS = 5 * 60 * 1000;
  const exp = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
  if (conn.access_token && exp && exp - Date.now() > BUFFER_MS) return conn.access_token;
  const minted = await mintZohoToken(conn.refresh_token, conn.accounts_url || "https://accounts.zoho.com");
  try { await sb.from("zoho_projects_connection").update({ access_token: minted.access_token, access_token_expires_at: minted.expires_at }).eq("refresh_token", conn.refresh_token); } catch (_) {}
  conn.access_token = minted.access_token; conn.access_token_expires_at = minted.expires_at;
  return minted.access_token;
}

// ── Date/field mapping — duplicated from zoho-projects/index.ts (plan §2.1
// flags both the date format and the priority/status label sets as needing
// live confirmation against the real portal; keep these two files in sync
// if that mapping is corrected). ──
function isoToZohoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso); if (isNaN(d.getTime())) return null;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
}
function zohoDateToIso(mmddyyyy: string | null | undefined): string | null {
  if (!mmddyyyy) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mmddyyyy.trim()); if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function tmgPriorityToZoho(p: string | null | undefined): string {
  if (p === "high") return "High"; if (p === "low") return "Low"; return "Medium";
}
function zohoPriorityToTmg(p: string | null | undefined): string {
  const s = (p || "").toLowerCase();
  if (s.includes("high") || s.includes("urgent")) return "high";
  if (s.includes("low") || s === "none") return "low";
  return "medium";
}
function tmgStatusToZoho(s: string | null | undefined): string {
  if (s === "done") return "Closed"; if (s === "in_progress") return "In Progress"; return "Open";
}
function zohoStatusToTmg(s: string | null | undefined): string {
  const v = (s || "").toLowerCase();
  if (v.includes("close") || v.includes("complet")) return "done";
  if (v.includes("progress")) return "in_progress";
  return "todo";
}
function mapZohoTask(t: any) {
  return {
    id: t.id_string || String(t.id),
    title: t.name || "",
    description: t.description || null,
    due_at: zohoDateToIso(t.end_date),
    priority: zohoPriorityToTmg(t.priority),
    status: zohoStatusToTmg(t.status?.name || t.status),
    last_modified_time: t.last_modified_time_long != null ? Number(t.last_modified_time_long) : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const secret = Deno.env.get("CRON_SECRET") || "";
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || auth !== secret) return json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  const { data: conn } = await sb.from("zoho_projects_connection").select("*").limit(1).single();
  if (!conn?.refresh_token || !conn?.portal_id) return json({ error: "Zoho Projects not connected" }, 200);

  let accessToken: string;
  try { accessToken = await getZohoToken(sb, conn); }
  catch (e) { return json({ error: "Could not mint Zoho token: " + String((e as any)?.message || e) }, 200); }

  const apiDomain = conn.api_domain || "projectsapi.zoho.com";
  const portalBase = `https://${apiDomain}/restapi/portal/${conn.portal_id}`;
  const zFetch = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Zoho-oauthtoken " + accessToken } });

  // Only opted-in CTC files, one list_tasks call each (plan §4 rate-limit design).
  const { data: projects } = await sb
    .from("projects")
    .select("id,name,zoho_project_id,zoho_last_synced_at")
    .eq("record_type", "ctc_file")
    .eq("zoho_sync_enabled", true)
    .eq("archived", false)
    .not("zoho_project_id", "is", null);

  const summary: any[] = [];

  for (const proj of projects || []) {
    try {
      const u = new URL(`${portalBase}/projects/${proj.zoho_project_id}/tasks/`);
      if (proj.zoho_last_synced_at) u.searchParams.set("last_modified_time", proj.zoho_last_synced_at);
      const r = await zFetch(u.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { summary.push({ project: proj.name, error: d?.error || `HTTP ${r.status}` }); continue; }

      const zTasks = (d.tasks || []).map(mapZohoTask);
      let pulled = 0, conflicts = 0, created = 0;

      for (const zt of zTasks) {
        const { data: local } = await sb.from("tasks").select("*")
          .eq("project_id", proj.id).eq("zoho_task_id", zt.id).maybeSingle();

        if (!local) {
          // A task created directly in Zoho — mirror it into TMG.
          const { data: inserted } = await sb.from("tasks").insert({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status, project_id: proj.id,
            zoho_task_id: zt.id, zoho_last_synced_at: new Date().toISOString(),
            zoho_last_modified_time: zt.last_modified_time,
          }).select().single();
          if (inserted) {
            await sb.from("task_activity").insert({ task_id: inserted.id, kind: "system", content: "Task created in Zoho Projects" });
            created++;
          }
          continue;
        }

        const localChangedSinceSync = local.updated_at && local.zoho_last_synced_at
          ? new Date(local.updated_at) > new Date(local.zoho_last_synced_at)
          : !local.zoho_last_synced_at; // never synced before = treat as "changed" so first sync isn't lost
        const zohoChangedSinceSync = zt.last_modified_time !== local.zoho_last_modified_time;

        if (!zohoChangedSinceSync) continue; // Zoho has nothing new for this task this cycle

        if (localChangedSinceSync) {
          // Both sides changed since the last successful sync — a real conflict.
          // Last-write-wins by timestamp (confirmed v1 rule, logged either way).
          const localMs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const zohoMs = zt.last_modified_time || 0;
          const fields = ["title", "description", "due_at", "priority", "status"];
          const changedField = fields.find(f => (local[f] || null) !== ((zt as any)[f] || null)) || "title";

          if (zohoMs > localMs) {
            await sb.from("tasks").update({
              title: zt.title, description: zt.description, due_at: zt.due_at,
              priority: zt.priority, status: zt.status,
              zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
            }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String(local[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "zoho_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — Zoho's edit was more recent; Zoho's value was kept.` });
          } else {
            // TMG wins — push TMG's current values back to Zoho to overwrite its stale edit.
            const form = new URLSearchParams({
              name: local.title || "", description: local.description || "",
              priority: tmgPriorityToZoho(local.priority), status: tmgStatusToZoho(local.status),
            });
            const zd = isoToZohoDate(local.due_at); if (zd) form.set("end_date", zd);
            await zFetch(`${portalBase}/projects/${proj.zoho_project_id}/tasks/${zt.id}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
            await sb.from("tasks").update({ zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: Date.now() }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String(local[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "tmg_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — TMG's edit was more recent; TMG's value was kept and pushed to Zoho.` });
          }
          conflicts++;
        } else {
          // Only Zoho changed — plain pull, no conflict. Deliberately does NOT
          // set updated_at, so this pull is never mistaken for a TMG-side edit
          // on the next cycle (which would create a false conflict/ping-pong).
          await sb.from("tasks").update({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status,
            zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
          }).eq("id", local.id);
          pulled++;
        }
      }

      await sb.from("projects").update({ zoho_last_synced_at: new Date().toISOString() }).eq("id", proj.id);
      summary.push({ project: proj.name, pulled, created, conflicts });
    } catch (e) {
      summary.push({ project: proj.name, error: String((e as any)?.message || e) });
    }
  }

  return json({ ok: true, projects: summary }, 200);
});

// Rate-limit math (plan §4): Zoho Projects allows 100 calls/2 min per token.
// This function makes exactly 1 list_tasks call per linked CTC file, plus at
// most 1 extra update_task call per task that resolves TMG-wins in a
// conflict (rare). At a 15-minute cron interval, up to ~100 linked CTC files
// can poll safely in one cycle without risking Zoho's 30-minute lockout.
// If the number of linked files grows well past that, lengthen the interval
// (or batch projects across multiple cron ticks) rather than shortening it.
