// =====================================================================
// Sends what the database queued in public.outbox (WhatsApp to staff, emails, pushes), AFTER the change was saved.
// Runs every minute (migrations/0004_jobs.sql). Same idea as flushNotify_ in Code.gs: messages never slow a booking.
// TODO(Majd): secrets in Supabase > Edge Functions > Secrets:
//   CALLMEBOT_KEYS  = {"romy":"<Romy key>","majd":"<Majd key>"}   (new keys, the old ones were in code)
//   STAFF_WA        = {"romy":"96176511048","majd":"96170976173"}
//   FCM_SERVER_KEY  = later, for push notifications to phones
// =====================================================================
import { asService, json } from "../_shared/supabase.ts";

const keys = JSON.parse(Deno.env.get("CALLMEBOT_KEYS") || "{}"), phones = JSON.parse(Deno.env.get("STAFF_WA") || "{}");

async function whatsapp(to: string, body: string) {
  if (!keys[to] || !phones[to]) throw new Error(`no WhatsApp key for ${to}`);
  const u = `https://api.callmebot.com/whatsapp.php?phone=${phones[to]}&apikey=${keys[to]}&text=${encodeURIComponent(body)}`;
  const r = await fetch(u); if (!r.ok) throw new Error(`CallMeBot ${r.status}`);
}

Deno.serve(async () => {
  const db = asService();
  const { data: rows } = await db.from("outbox").select("*").is("sent_at", null).lt("attempts", 5).order("id").limit(30);
  let sent = 0;
  for (const m of rows ?? []) {
    try {
      if (m.channel === "whatsapp") await whatsapp(m.to_staff, m.body);
      else if (m.channel === "email") throw new Error("TODO(Majd): email sender (Resend or SMTP) not set up yet");
      else if (m.channel === "push") throw new Error("TODO(Majd): FCM not set up yet");
      await db.from("outbox").update({ sent_at: new Date().toISOString() }).eq("id", m.id); sent++;
    } catch (e) {
      await db.from("outbox").update({ attempts: m.attempts + 1, error: String((e as Error).message) }).eq("id", m.id);
    }
  }
  return json({ ok: true, sent, waiting: (rows?.length ?? 0) - sent });
});
