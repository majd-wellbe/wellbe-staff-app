// Sign in with a 6 digit email code, exactly like Client.gs clCode_ / clLogin_ today.
// Codes, limits and sessions live in the database (migrations/0008_auth.sql). This file only sends the email.
// Secrets: RESEND_API_KEY, MAIL_FROM (e.g. "Wellbe Health Center <app@wellbe...>", a domain verified in Resend).
import { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

type R = Record<string, unknown>;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function codeEmail(first: string, code: string) {
  const f = esc(first || "");
  return {
    subject: "Your Wellbe code: " + code,
    text: "Hi " + first + ",\n\nYour Wellbe app code is " + code + "\nIt works for 10 minutes.\n\nDid not ask for it? Ignore this email.\n\nWellbe Health Center",
    html: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#151b1e">' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:2px;color:#1f6e5b">WELLBE</div>' +
      '<p style="font-size:16px">Hi ' + f + ", here is your code:</p>" +
      '<div style="font-size:36px;font-weight:800;letter-spacing:8px;background:#e9f6f2;border-radius:12px;padding:16px;text-align:center">' + code + "</div>" +
      '<p style="color:#5b6b70;font-size:14px">It works for 10 minutes. Did not ask for it? Just ignore this email.</p></div>',
  };
}

export async function sendMail(to: string, m: { subject: string; text: string; html: string }, fetcher: typeof fetch = fetch): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  if (!key || !from) { console.error("RESEND_API_KEY or MAIL_FROM missing"); return false; }
  try {
    const r = await fetcher("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) console.error("Resend " + r.status + " " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error("Resend " + e); return false; }
}

const rpc = async (db: SupabaseClient, fn: string, args: R): Promise<R> => {
  const { data, error } = await db.rpc(fn, args);
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: "Server error" }) as R;
};

// app_cl_code {email, mode, name}
export async function askCode(db: SupabaseClient, b: R, fetcher: typeof fetch = fetch, desk = "the front desk"): Promise<R> {
  const r = await rpc(db, "wb_login_code", { p_email: String(b.email ?? ""), p_mode: b.mode ?? null, p_name: b.name ?? null });
  if (!r.ok) return r;
  const email = String(r.email ?? b.email ?? "").trim().toLowerCase(), code = String(r.code);
  const sent = await sendMail(email, codeEmail(String(r.first ?? ""), code), fetcher);
  if (!sent) {
    await rpc(db, "wb_login_code_cancel", { p_email: email });
    return { ok: false, error: "We could not send the email right now. Try again in a few minutes, or message " + String(r.desk ?? desk) + " on WhatsApp." };
  }
  const out: R = { ok: true };
  if (r.guest) out.guest = true;
  if (r.client) out.client = true;
  return out;                                   // never the code
}

// app_cl_login {email, code} -> {ok, token}
export function verifyCode(db: SupabaseClient, b: R): Promise<R> {
  return rpc(db, "wb_login_verify", { p_email: String(b.email ?? ""), p_code: String(b.code ?? "") });
}
