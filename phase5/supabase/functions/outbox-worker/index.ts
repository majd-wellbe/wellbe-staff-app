// Sends what the database queued in public.outbox (WhatsApp to staff via CallMeBot, emails via Resend), AFTER the change was saved.
// Called every minute by pg_cron (app.call_function('outbox-worker')). Secrets: CALLMEBOT_KEYS, STAFF_WA, RESEND_API_KEY, MAIL_FROM.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const parse = (s: string | undefined) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const keys = parse(Deno.env.get("CALLMEBOT_KEYS")), phones = parse(Deno.env.get("STAFF_WA"));
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

async function whatsapp(to: string, body: string) {
  if (!keys[to] || !phones[to]) throw new Error(`no WhatsApp key for ${to}`);
  const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phones[to])}&apikey=${encodeURIComponent(keys[to])}&text=${encodeURIComponent(body)}`;
  const r = await fetch(u); const t = await r.text();
  if (!r.ok || /error|invalid|not\s+allowed/i.test(t.slice(0, 400))) throw new Error(`CallMeBot ${r.status}: ${t.replace(/<[^>]+>/g, " ").slice(0, 160)}`);
}

async function email(to: string, body: string) {
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  if (!key || !from) throw new Error("RESEND_API_KEY or MAIL_FROM missing");
  const lines = body.split("\n"), subject = "Wellbe: " + (lines[0] || "alert").slice(0, 90);
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text: body }) });
  if (!r.ok) throw new Error("Resend " + r.status + " " + (await r.text()).slice(0, 160));
}

Deno.serve(async () => {
  const { data: rows, error } = await db.from("outbox").select("*").is("sent_at", null).lt("attempts", 5).order("id").limit(30);
  if (error) return json({ ok: false, error: error.message });
  let sent = 0;
  for (const m of rows ?? []) {
    try {
      if (m.channel === "whatsapp") await whatsapp(m.to_staff, m.body);
      else if (m.channel === "email") {
        let to = m.to_address as string | null;
        if (!to && m.to_staff) { const { data: s } = await db.from("staff").select("email").eq("id", m.to_staff).maybeSingle(); to = s?.email ?? null; }
        if (!to) throw new Error("no email address");
        await email(to, m.body);
      } else if (m.channel === "push") throw new Error("push notifications not set up yet");
      await db.from("outbox").update({ sent_at: new Date().toISOString(), error: null }).eq("id", m.id); sent++;
    } catch (e) {
      await db.from("outbox").update({ attempts: (m.attempts ?? 0) + 1, error: String((e as Error).message) }).eq("id", m.id);
    }
  }
  return json({ ok: true, sent, waiting: (rows?.length ?? 0) - sent });
});
