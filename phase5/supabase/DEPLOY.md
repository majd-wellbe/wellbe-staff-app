# Wellbe on Supabase: how to put it live

Plain steps, in order. Nothing here changes what staff and clients see until the very last part (the switch).
Until then the apps keep using the Apps Script exactly as today.

What you need open: the Supabase dashboard (project `fuwxmbdygqrmcbhwvrfx`), the Apps Script editor of the Wellbe server, and GitHub (repository `wellbe-staff-app`, folder `supabase`).

Rules for secrets: never paste a key, a password or a secret in the chat. You paste them only into the Supabase dashboard or into Script Properties. The only key that is public on purpose is the publishable key (`sb_publishable_...`).

If you prefer, say "do step N" and I do that step on your laptop through Chrome, like the first Supabase setup. Steps 2 and the secrets in 3 and 4 stay yours.


## Step 1. Database: run the new files (about 10 minutes)

Project moved on 26 Oct 2026 from Tokyo (deleted) to Ireland eu-west-1 (`fuwxmbdygqrmcbhwvrfx`). Step 1 is DONE there: 0001 to 0009 and the seed ran on 26 Oct 2026 (actions 58, tables_without_rls 0, backend apps). Order for any future rebuild: 0001 to 0004 first, then:

1. `0005_boot.sql`
2. `0006_features.sql`
3. `0007_ops.sql`
4. `0009_align.sql`
5. `0008_auth.sql` (LAST of the migrations, see why below)
6. `seed/seed.sql` again (it only adds what is missing, it never changes what is there)

For each file:

1. In GitHub open the file in `supabase/migrations` (the seed is in `supabase/seed`), click **Raw**, select all, copy.
2. In Supabase open **SQL Editor**, click **New query**, paste, click **Run**.
3. You should see "Success. No rows returned". If you see an error, stop and send me the error text (no secrets in it).

Why 0008 goes last: it closes every database function behind the one API door and makes the list of allowed actions. A function added after it stays unreachable until you run `select app.api_sync();`. So if you ever run one of these files again later, run that one line at the end.

Check (paste and run, then send me the result):

```sql
select (select count(*) from app.api_actions) as actions,
       (select count(*) from pg_tables t where schemaname = 'public' and not rowsecurity) as tables_without_rls,
       (select value from public.settings where key = 'backend') as backend;
```

Good result: actions 58, tables_without_rls 0, backend `{"use": "apps"}`.


## Step 2. Staff links and client sign ins (5 minutes, yours only)

So that every staff link and every client sign in made today keeps working on Supabase with no new login.

1. Apps Script editor: click the gear (**Project Settings**), scroll to **Script Properties**.
2. Copy the value of `APP_KEYS`. In the Supabase SQL Editor run, with the value pasted between the quotes:

```sql
select app.import_staff_keys('PASTE THE APP_KEYS VALUE HERE'::jsonb);
```

It answers with the number of staff links saved (one per staff member with a link).

3. Copy the value of `CL_SECRET`, and of `CL_DELETED` if it exists. Run:

```sql
select app.import_legacy_auth('PASTE THE CL_SECRET VALUE HERE', 'PASTE THE CL_DELETED VALUE HERE, OR {}'::jsonb);
```

4. Close the query tab without saving it (the values should not stay in a saved query).


## Step 3. Email for the 6 digit codes: Resend (15 minutes)

Today the codes go out from your Gmail through the Apps Script. On Supabase they go out through Resend.

1. Make an account at resend.com.
2. **Domains**, **Add Domain**: use a domain you own (for example `shopwellbethebrand.com`). Resend shows a few DNS records. Add them where that domain is managed (for a Shopify domain: Shopify admin, Settings, Domains, the domain, DNS settings). Wait until Resend shows **Verified** (minutes to a few hours).
3. **API Keys**, **Create API Key**, permission "Sending access". Copy it (shown once).
4. Supabase dashboard: **Edge Functions**, then **Secrets**. Add:

* `RESEND_API_KEY`: the key from Resend
* `MAIL_FROM`: `Wellbe Health Center <app@shopwellbethebrand.com>` (with your verified domain)

Optional: `ALLOWED_ORIGINS` only if the apps ever move away from `https://majd-wellbe.github.io`.


## Step 4. The three edge functions: `api`, `login-code`, `upload` (15 minutes)

`api` is the one door the apps call. `login-code` is for pages that only sign in. `upload` stores client files and photos.
All three check the staff key or the client sign in themselves, so **Verify JWT must be OFF** for all three.

First the storage for files: Supabase **Storage**, **New bucket**, name `client-files`, leave **Public** off, create. Again with `client-photos`, Public off.

### Way A: the dashboard (no tools on your laptop)

Use the ready single files in `supabase/functions/dist/` (each one already holds the shared code).

For each of `api`, `login-code`, `upload`:

1. **Edge Functions**, **Deploy a new function**, **Via Editor**.
2. Name it exactly `api` (then `login-code`, then `upload`).
3. Delete the sample code, paste the whole content of `dist/api.ts` (then `dist/login-code.ts`, `dist/upload.ts`), click **Deploy function**.
4. Open the function, **Details** (or **Settings**), turn **Verify JWT** (also called "Enforce JWT verification") **off**, save.

### Way B: the command line (if Node is installed on your laptop)

In a terminal, inside your copy of the `wellbe-staff-app` repository:

```
npx supabase login
npx supabase link --project-ref fuwxmbdygqrmcbhwvrfx
npx supabase functions deploy api --no-verify-jwt
npx supabase functions deploy login-code --no-verify-jwt
npx supabase functions deploy upload --no-verify-jwt
```

Check: open this address in the browser. It must answer `{"ok":false,"error":"Bad request"}` (that is the good answer to a plain visit):
`https://fuwxmbdygqrmcbhwvrfx.supabase.co/functions/v1/api`


## Step 5. Calendar and brand catalog sync: Supabase.gs (10 minutes)

Supabase cannot read your Google Calendar or the Shopify catalog by itself. The Apps Script sends them: the physio calendar every 10 minutes, the brand products every 6 hours.

1. Make the shared secret. In the Supabase SQL Editor run:

```sql
select encode(gen_random_bytes(24), 'hex') as secret;
```

Copy the answer. Then run, with that same text pasted:

```sql
insert into app.secrets (key, value) values ('sync_secret', 'PASTE THE SECRET HERE')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

2. Apps Script editor: **+** next to Files, **Script**, name it `Supabase`. Paste the whole content of `server/Supabase.gs`. Save.
3. **Project Settings**, **Script Properties**, add two:

* `SB_URL`: `https://fuwxmbdygqrmcbhwvrfx.supabase.co`
* `SB_SYNC_SECRET`: the same secret as in point 1

4. Back in the editor, pick the function `sbSetupTriggers` in the menu at the top, click **Run**. Allow the permissions it asks for. The log ends with "Supabase sync ready".
5. Check in the SQL Editor:

```sql
select (select count(*) from public.calendar_busy) as calendar_events,
       (select jsonb_array_length(items) from public.brand_cache) as brand_products;
```

No new deployment of the web app is needed for this file: triggers always run the saved code.


## Step 6. Copy the data from the sheets (I do it, you paste one file)

Decision: **I read the sheets myself** through the Google Drive connection and make the SQL. This is the way with the fewest steps for you: no Node, no downloads, no files to move.

1. You say in the chat: "import now".
2. I download the two spreadsheets (Client Portal and Operations) as Excel files with all their tabs, run the import (the same code as the tests: `import/import.js`), read the report, and fix or explain every problem it lists.
3. I send you `import.sql` and the report. If the file is too big for the SQL Editor, I send it in a few parts, numbered.
4. You paste it in the SQL Editor and click **Run** (each part in order).

If the Drive connection cannot download them: in each spreadsheet click **File**, **Download**, **Microsoft Excel (.xlsx)**, and attach both files in the chat. Same result.

What comes over: clients, guests, packages, every session and attendance mark, leads, requests, notices, the game, streaks, wallet, goals, workouts, nutrition, insurance, expenses, POS and stock, session notes, physio intakes, profile photos. Client files (PDFs) stay in Google Drive: the rows come over with their Drive links, and the files can move to Storage later.

To copy again later (for example each evening of the side by side week), the old copy must be emptied first. This removes only the copied data. It keeps staff, package types, settings, staff links and sign ins:

```sql
truncate public.clients, public.sessions, public.leads, public.expenses, public.recurring_expenses, public.inventory, public.pos_sales,
  public.wo_exercises, public.deletion_requests, public.outbox, public.audit_log, public.calendar_busy cascade;
```

Then paste the new `import.sql`. (The calendar comes back by itself within 10 minutes.)

First look on your laptop: open the staff app with `?wb=supabase` before the `#`:
`https://majd-wellbe.github.io/wellbe-staff-app/?wb=supabase#k=YOUR KEY`
You are now on Supabase on this browser only. To go back: the same address with `?wb=auto`.


## Step 7. The side by side week, the switch, and going back

### Before the switch day (my list, not yours)

1. The WhatsApp and nutrition workers: they need two secrets in the Supabase Vault (`project_url`, `service_role_key`, you paste them, I give the exact lines), their own secrets (`CALLMEBOT_KEYS`, `STAFF_WA`, `ANTHROPIC_KEY`), and the nutrition plan checks still have to be moved from the Apps Script. I finish and test that before we pick a date.
2. The landing pages still send leads straight to the Apps Script. They get the Supabase address on the switch day.

### Side by side week (shadow mode)

1. Each evening after closing, the data is copied again (Step 6, the empty and paste part). I can do it for you through Chrome.
2. On your phone and on Romy's, open the apps once with `?wb=shadow` in the address. From then on every screen load also asks Supabase in the background and compares the two answers. You see nothing different. Writes (sales, attendance) still go only to the Apps Script.
3. Each day I read the differences (`app.shadow_log`) and tell you which are real. Differences that come from things done that same day are normal, because the copy is from the evening before.
4. Goal: three days in a row with no real difference.

### The switch (an evening, about 20 minutes, nobody uses the apps during it)

1. After 21:30 (the automatic Present has run), tell the team not to use the apps for 20 minutes.
2. Copy the data one last time (Step 6, empty and paste).
3. In the Supabase SQL Editor:

```sql
update public.settings set value = '{"use":"supabase"}'::jsonb, updated_at = now() where key = 'backend';
```

4. In the Operations sheet, tab **SETTINGS**, add a row: Key `backend.use`, Value `supabase`. Then in the Apps Script editor run `cfgBump` (or wait 10 minutes).
5. Every phone moves to Supabase the next time its app opens or refreshes. To check one phone at once: open it with `?wb=auto`.
6. The landing pages get the Supabase address (I push that change).
7. Keep the Apps Script running: it still sends the calendar and the brand catalog (Step 5).

### Going back (rollback)

1. In the SETTINGS tab set `backend.use` to `apps`, run `cfgBump`.
2. In the SQL Editor:

```sql
update public.settings set value = '{"use":"apps"}'::jsonb, updated_at = now() where key = 'backend';
```

3. Phones move back at their next open. For one phone at once: `?wb=apps`.
4. Honest warning: anything done on Supabase between the switch and the rollback (sales, payments, attendance) is not in the sheets. I make you the list from Supabase so Romy can enter it in the sheets. Nothing is ever deleted on the Apps Script side, so going back is always possible.
