# Wellbe on Supabase: Phase 5 groundwork

Nothing here is live. Nothing touches your Google Sheets or the apps. It is the new backend, built and tested on a copy, waiting for your accounts.

## What is ready

| Part | Where | What it does |
|---|---|---|
| Tables | `migrations/0001_schema.sql` | Every sheet becomes a real table: clients and guests, packages, sessions (all 7 kinds in one table) with each client's attendance, leads, requests, notices, workouts, nutrition, the game, the wallet, insurance, expenses, POS, deletion requests, an audit log and an outbox for messages. Money is in cents. Every row keeps today's ID (C012, PKG-0173, S13-0001) next to its new one. |
| Who sees what | `migrations/0002_security.sql` | Row Level Security on every table. Owner sees all. Romy sees all day to day data but not staff pay. A trainer sees only clients they trained in the last 60 days or have booked (with their medical notes), never prices, payments or anyone else's pay. A client sees only their own rows and their children's. |
| The rules | `migrations/0003_logic.sql` | Selling (1, 3, 6 months, discount, typed price, expiry rules, Melanie's clients, Romy's bonus flag), payments and wallet, booking with trainer caps and fixed trainers, attendance, the 21:30 default Present, client cancel (with the 1:2 whole session rule and its notices), joining a 1:3 chair, the 3 and 6 month offers and Romy accepting them, freezes, physio requests, the game (coins, missions, XP, levels, chests, tickets, Wellbe Credit, leaderboards, badges), the streak reward, lead follow ups, and the settings the apps receive. All values come from the settings tables. |
| Jobs | `migrations/0004_jobs.sql` | 21:30 default Present, the message sender every minute, the nutrition worker every 5 minutes. |
| Settings | `seed/seed.sql` (made by `seed/gen-seed.js` from `server/Config.gs`) | Staff, package types and every setting group, the same values as the STAFF, PACKAGE TYPES and SETTINGS tabs. |
| Game + referral sync | `migrations/0014_game_referral_sync.sql` | Corniche Run as in RunGame.gs since 26 Oct (ladders, outfits, studio, runner names, 5:30 AM Club, prestige outfits) and the $5 referral credit (Referral.gs). Tested side by side by `tests/run_game2.js`. |
| Data import | `import/import.js` | Reads a CSV of each sheet tab, cleans it (phones, dates, money to cents, trainer names), flags problems, writes one SQL file. It reads old rows with the Apps Script's own functions, so a row means exactly what it means today. |
| Server functions | `functions/` | `api` (the apps keep their action names), `login-code` (6 digit email code), `outbox-worker` (WhatsApp, later email and push), `nutrition-worker` (AI plans), `upload` (files and photos to Storage). Small, with TODO(Majd) where a key is needed. |
| Phone app | `../mobile/` | Capacitor wrapper for the client app: push, 8 water reminders, move more, the 10:00 quote, steps from Apple Health and Google Health Connect, in app purchases plan. See `mobile/README.md`. |

## How it was tested

On a real Postgres 16 in the build machine, with a stand in for Supabase's login (`tests/00_supabase_stub.sql`).

Run: `tests/lib/snapshot.sh` then `cd tests && npm install && node run.js`. Result today: **170 checks passed, 0 failed**.

1. **Same result as today.** 26 situations run twice on the same data: once in the Apps Script (the real .gs files, on the in memory test sheets) and once in Postgres. The end states are compared field by field: every package (price, paid, dates, notes), every session and attendance mark, every notice text, every request, the wallet, the game record, the streak. Sales of every kind, payments with overpay, attendance by role, 1:2 and 1:3 cancels, joins, bookings, trainer caps, the 6 month upgrade, freeze, 21:30 default Present, game runs with level ups, refused runs, credit redeem, the 30 day streak. Refusals give the same message word for word.
2. **Who sees what.** Each trainer sees exactly the clients the Apps Script lets them see. Trainers get no prices. Romy cannot read pay. A client sees only their own client row, package money and place in a session. Internal helpers cannot be called directly. No table is left without Row Level Security.
3. **Import.** Every good row arrives. Duplicate IDs and unknown clients are reported, not lost. Lead follow ups and the 3 and 6 month offers equal the Apps Script.

## Different on purpose (better, tell me if you disagree)

* Money is exact. Today a 3 month bundle at 130.20 a month shows "$323.40000000000003" in a request text; here it is "$323.4".
* Romy no longer receives staff pay in the settings. Only the owner, and each trainer their own.
* Nutrition v2 (27 Oct 2026): plans that pass the code checks go to the client by themselves; flagged clients and plans that fail the checks twice go to the owner only. Clients read a plan only while it is approved and its 3 weeks run, enforced by the database itself.
* WhatsApp and emails are written to an outbox and sent after the change is saved, so a booking never waits for a message.

## Questions found, NOT changed (same as today until you decide)

1. **Streak reward is always a 1:3 session**, even for 1:1 clients. The code reads a field that is never filled. One line to fix (in `0003_logic.sql`, `streak_tick`, and in Streak.gs).
2. Streak goal is 30 days in the code; the plan says 28 (a SETTINGS value, `streak.days`).
3. Wellbe Credit is $0.10 per run over 2,000 m, max $0.50 a day; the plan says $0.10 per 2,000 m run.
4. Guests earn Wellbe Credit too (as you decided on 22 Oct).
5. Some packages have a Used number in the sheet that is not their count of Y flags (the test data has 3). The import keeps the sheet number and lists them; the next mark recounts from the flags, exactly like today.

## Not ported yet (honest list)

* **Boot**: the big read each app does when it opens (staff boot, client boot, guest boot). The tables and security are ready; the boot views are the next piece and the largest.
* **Workouts**: programs, logging weights, decisions, the exercise list.
* **Nutrition v2** is built (`migrations/0012_nutrition.sql`, `functions/nutrition-worker/`, client app screens and `client/nut-pdf.js`, staff app review, notes and restaurant library, tests `tests/nutrition.js`, `tests/nut_pdf.js`, `tests/deno/nutrition_test.ts`). Week 1 draft and client review loop, 4 breakfast / snack options, lunch and dinner every 2 days, 2 prep sessions, nights out and family lunch, client notes as memory. The paid 3-week plan stays LOCKED (`nutrition.paid_open = false`) until the owner opens it. NOT applied yet. Not built yet: push delivery of reminders (FCM), a payment provider for the 3-week cycle. See DEPLOY.md Step 8.
* **Landing page leads** (Code.gs: free slots, saving a lead, the W40 alerts), **guest sign up** (Guest.gs), **change session** (move, change trainer), **week template**, **insurance claims**, **POS sale and stock**, **expense logging**, **client requests of the other kinds**, **delete account**, **game op get and the old upgrades shop**.
* Photos and client files: they need uploading to Storage once (they are not in the CSVs).

These are mostly reads and simple writes, which Row Level Security already protects. The risky parts (money, booking, attendance, the game, credit) are the ones done and tested.

## Cut over plan (no big bang)

1. **Parallel run.** Supabase is filled every night from the sheets with the import, read only. The apps still use Apps Script. Each morning a check compares the numbers (clients, packages left, money due). A week of matching numbers before the next step.
2. **Login.** Clients and staff get a Supabase login (same 6 digit email code). The old links keep working during the switch.
3. **One action at a time.** In `core/wb-core.js` one small list will say which action goes to which server (added at this step). Start with reads, then attendance, then selling, then the game. The `api` function keeps the old action names, so the screens do not change.
4. **Sheets become the copy.** When everything runs on Supabase, a nightly export writes the sheets back read only, so you can still look at your numbers in Google Sheets.
5. **Rollback.** Moving an action back is one line in that list. Nothing is deleted on the old side until the end.

## What only Majd can do

1. **Create the Supabase project (free to start).** supabase.com, Start your project, sign in with GitHub, New project. Name: wellbe. Region: Central EU (Frankfurt), the closest to Lebanon. Save the database password in your password manager. Free plan. Pro ($25 a month) only at launch.
2. **Send me the project URL and keys.** Project Settings, API: copy the Project URL and the anon public key. The service role key stays with you (I tell you where to paste it).
3. **Switch on the scheduler.** Database (or Integrations), Extensions: turn on pg_cron and pg_net. Then Vault: add two secrets, project_url and service_role_key.
4. **Login emails.** The free built in sender allows only a few emails an hour. Pick a sender: Resend (free up to 3,000 emails a month) on a domain you own, for example login.shopwellbethebrand.com. In GoDaddy, add the DNS records Resend shows you. Then in Supabase: Authentication, Emails, SMTP Settings: paste the Resend SMTP details. Authentication, Email Templates: use the code template with {{ .Token }}.
5. **New WhatsApp keys** for the outbox (the CallMeBot keys from Phase 1): Edge Functions, Secrets: CALLMEBOT_KEYS and STAFF_WA (format in `functions/outbox-worker/index.ts`).
6. **AI key** for nutrition: Edge Functions, Secrets: ANTHROPIC_KEY.
7. **Storage.** Storage, New bucket: client-files (private) and client-photos (private). Decide: move photos and files from Drive to Supabase (1 GB free, $0.021 per GB after) or keep Drive links. I recommend Supabase: one place, same security rules.
8. **Apple Developer account, $99 a year.** developer.apple.com/programs, Enroll. Enroll as an Organization so the store shows "Wellbe Health Center": you need a free D-U-N-S number first (Apple links to it during enrollment, it can take a few days). Individual is faster but shows your own name.
9. **Google Play account, $25 once.** play.google.com/console, Sign up, choose Organization. A personal account must first run a closed test with 12 testers for 14 days before it can publish; an organization account does not.
10. **Payments.** For sessions and packages at the center you may use your own payment: ask Areeba (or Whish Business) for an online merchant account with a webhook. For things used inside the app (coin packs, outfits, an online workout subscription), Apple and Google require their in app purchase: a free RevenueCat account (revenuecat.com) connects both stores.
11. **A Mac with Xcode** (yours or a developer's) to build the iPhone app. Steps in `mobile/README.md`.

## Files

```
supabase/
  migrations/0001_schema.sql   tables
  migrations/0002_security.sql who sees what
  migrations/0003_logic.sql    money, booking, game, streak rules
  migrations/0004_jobs.sql     scheduled jobs
  seed/gen-seed.js, seed.sql   settings from server/Config.gs
  import/import.js             sheets CSV to SQL, with a problem report
  functions/                   api, login-code, outbox-worker, nutrition-worker, upload
  tests/                       run.js (170 checks), reset.sh, Supabase stand in, helpers
mobile/                        Capacitor wrapper, reminders, steps
```
