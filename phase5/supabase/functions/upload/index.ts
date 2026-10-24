// =====================================================================
// Client files and photos into Supabase Storage (was: Drive folder "Wellbe Client Files" and base64 in a sheet cell).
// Staff (owner) upload body composition files and intake files; clients upload their profile photo.
// Buckets (private): client-files, client-photos. TODO(Majd): create both buckets (README step "Storage").
// =====================================================================
import { asCaller, cors, json } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = asCaller(req);
  const { cid, name, mime, b64, kind } = await req.json().catch(() => ({}));
  if (!cid || !b64) return json({ ok: false, error: "Nothing to upload" });
  const { data: c } = await db.from("clients").select("id").eq("legacy_id", cid).maybeSingle();   // RLS: only people allowed to see this client
  if (!c) return json({ ok: false, error: "Client not found" });
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  if (bytes.length > 10 * 1024 * 1024) return json({ ok: false, error: "File too big (10 MB max)" });
  const bucket = kind === "photo" ? "client-photos" : "client-files";
  const path = `${c.id}/${Date.now()}-${String(name || "file").replace(/[^\w.\-]/g, "_")}`;
  const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType: mime || "application/octet-stream" });
  if (error) return json({ ok: false, error: error.message });
  if (kind === "photo") await db.from("client_photos").upsert({ client_id: c.id, storage_path: path, updated_at: new Date().toISOString() });
  else await db.from("client_files").insert({ client_id: c.id, file_name: name || "file", storage_path: path, file_type: mime || null });
  return json({ ok: true, path });
});
