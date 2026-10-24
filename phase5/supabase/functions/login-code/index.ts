// =====================================================================
// Sign in with a 6 digit code by email (same as today: Client.gs clCode_ / clLogin_).
// Supabase Auth sends the code itself ("Email OTP"). This function only adds today's rule:
// only emails that exist in clients (or guests) can ask, max CODES_PER_DAY a day.
// TODO(Majd): in Supabase > Authentication > Email templates, use the {{ .Token }} code template,
//             and in Authentication > SMTP settings put the sender (README step "Login emails").
// =====================================================================
import { asService, cors, json } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { email } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return json({ ok: false, error: "Type a valid email" });
  const db = asService();
  const { count } = await db.from("clients").select("id", { count: "exact", head: true }).or(`email.ilike.${e},parent_email.ilike.${e}`).is("deleted_at", null);
  // unknown emails become guests, like today (Guest.gs): the app shows the guest screens
  const { data: since } = await db.from("audit_log").select("id", { count: "exact" }).eq("action", "login_code").eq("actor_label", e)
    .gte("at", new Date(Date.now() - 86400000).toISOString());
  if ((since?.length ?? 0) >= 8) return json({ ok: false, error: "Too many codes asked today. Try again tomorrow." });
  await db.from("audit_log").insert({ action: "login_code", actor_label: e, data: { known: (count ?? 0) > 0 } });
  const { error } = await db.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
  if (error) return json({ ok: false, error: error.message });
  return json({ ok: true, guest: (count ?? 0) === 0 });
});
