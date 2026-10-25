// =====================================================================
// Client files and photos into Supabase Storage (was: Drive folder "Wellbe Client Files" and base64 in a sheet cell).
//   POST {key | token, cid, name, mime, b64, kind}   kind "photo" = profile photo, anything else = a client file
// Who is calling comes ONLY from the staff key or the client token, checked in the database (public.wb_whoami),
// the same sign in as the api door. Rules as in the Apps Script: client files are owner only;
// a profile photo by the owner, or by the client for their own account (or their child's).
// Buckets (private): client-files, client-photos (DEPLOY.md step 4). Deploy with "Verify JWT" OFF.
// =====================================================================
import { asService, corsFor, jsonFor } from "../_shared/supabase.ts";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const MAX = 10 * 1024 * 1024;

export async function handle(req: Request, db = asService()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return jsonFor(req, { ok: false, error: "Bad request" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return jsonFor(req, { ok: false, error: "Bad request" }, 400); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return jsonFor(req, { ok: false, error: "Bad request" }, 400);
  const key = str(b.key), token = str(b.token), cid = String(b.cid ?? "").toUpperCase(), kind = b.kind === "photo" ? "photo" : "file";
  try {
    const { data: who, error: werr } = await db.rpc("wb_whoami", { p_key: key, p_token: token });
    if (werr) return jsonFor(req, { ok: false, error: werr.message });
    if (!who) return jsonFor(req, { ok: false, error: key ? "auth" : "signin" });
    if (!cid || !str(b.b64)) return jsonFor(req, { ok: false, error: "Nothing to upload" });
    const { data: c } = await db.from("clients").select("id, email, parent_email").eq("legacy_id", cid).maybeSingle();
    if (!c) return jsonFor(req, { ok: false, error: "Client not found" });
    const owner = who.role === "owner";
    const mine = !!who.email && [c.email, c.parent_email].some((e: string | null) => String(e ?? "").toLowerCase() === String(who.email).toLowerCase());
    if (kind === "file" ? !owner : !(owner || mine)) return jsonFor(req, { ok: false, error: who.email ? "Not your account" : "not allowed" });
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(String(b.b64).replace(/^data:[^,]*,/, "")), (ch) => ch.charCodeAt(0)); }
    catch { return jsonFor(req, { ok: false, error: "File could not be read" }); }
    if (bytes.length > MAX) return jsonFor(req, { ok: false, error: "File too big (10 MB max)" });
    const mime = str(b.mime) ?? "application/octet-stream", name = String(b.name || "file").slice(0, 120);
    if (kind === "photo" && !/^image\//.test(mime)) return jsonFor(req, { ok: false, error: "Photos only" });
    const bucket = kind === "photo" ? "client-photos" : "client-files";
    const path = `${c.id}/${Date.now()}-${name.replace(/[^\w.\-]/g, "_")}`;
    const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType: mime });
    if (error) return jsonFor(req, { ok: false, error: error.message });
    let by: string | null = who.email ?? null;
    if (who.staff) { const { data: st } = await db.from("staff").select("name").eq("id", who.staff).maybeSingle(); by = st?.name ?? who.staff; }
    if (kind === "photo") await db.from("client_photos").upsert({ client_id: c.id, storage_path: path, updated_at: new Date().toISOString() });
    else await db.from("client_files").insert({ client_id: c.id, file_name: name, storage_path: path, file_type: mime, uploaded_by: by });
    return jsonFor(req, { ok: true, path });
  } catch (e) {
    return jsonFor(req, { ok: false, error: String((e as Error)?.message || e) });
  }
}

// started always on Supabase; the tests set WB_TEST and call handle() themselves
if (!Deno.env.get("WB_TEST")) Deno.serve((req) => handle(req));
