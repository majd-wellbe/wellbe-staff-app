-- =====================================================================
-- WELLBE on Supabase: 0010 keep the sheet as it is
-- Owner decisions (27 Oct 2026) for the data copy (DEPLOY.md Step 6):
--  1. Sheet fields the apps do not use yet are kept as stored values (no app logic reads them):
--     CLIENTS: date of birth, underage, parent and emergency contacts, plan, notes, date added, status, active package IDs.
--     PACKAGES: unused pass disposition, the three alert / email sent flags.
--     POS INVENTORY: product ID, purchase date, supplier, quantity purchased, total cost, notes.
--     EXPENSES: the Month column.
--     Text exactly as the sheet shows it (dates as dd/MM/yyyy text), so nothing is reinterpreted.
--     Left out on purpose (worked out from other columns): balance, remaining passes, price per pass,
--     remaining amount, client name on packages.
--  2. Original statuses are kept: a session row can say 'Early Cancel' (as the 1:1 / Physio / Madero tabs do),
--     a package can have an empty status.
--  3. sheet_row (row in the source tab, header = row 1) on every copied table, plus sheet_tab where one
--     table takes rows from several tabs. Empty for rows made later by the apps.
--  4. POS INVENTORY may hold the same product name twice (two purchases): the unique rule on item is dropped.
-- Safe to run again.
-- =====================================================================

-- ---------- 1. kept sheet fields ----------
alter table public.clients add column if not exists birth_date      text;   -- CLIENTS E  Date of Birth (as shown)
alter table public.clients add column if not exists underage        text;   -- F  Underage? (Y / N / empty)
alter table public.clients add column if not exists parent_name     text;   -- G
alter table public.clients add column if not exists parent_phone    text;   -- H
alter table public.clients add column if not exists emergency_name  text;   -- I
alter table public.clients add column if not exists emergency_phone text;   -- J
alter table public.clients add column if not exists plan            text;   -- K  Treatment / Workout Plan
alter table public.clients add column if not exists sheet_notes     text;   -- L  Notes
alter table public.clients add column if not exists date_added      text;   -- M  Date Added (as shown)
alter table public.clients add column if not exists sheet_status    text;   -- N  Status (Active / Inactive)
alter table public.clients add column if not exists active_pkg_ids  text;   -- O  Active Package IDs (as written)

alter table public.packages add column if not exists unused_disposition text;  -- O  Unused Pass Disposition
alter table public.packages add column if not exists alert_2pass_sent   text;  -- Q  2-Pass Alert Sent
alter table public.packages add column if not exists alert_renew_sent   text;  -- R  Renewal Alert Sent
alter table public.packages add column if not exists confirm_email_sent text;  -- S  Confirmation Email Sent

alter table public.inventory add column if not exists product_id    text;   -- A  Product ID
alter table public.inventory add column if not exists purchase_date text;   -- B  Purchase Date (as shown)
alter table public.inventory add column if not exists supplier      text;   -- C
alter table public.inventory add column if not exists qty_purchased text;   -- E
alter table public.inventory add column if not exists total_cost    text;   -- G  Total Cost ($)
alter table public.inventory add column if not exists notes         text;   -- J

alter table public.expenses add column if not exists month_label text;      -- H  Month

-- ---------- 2. original statuses ----------
alter table public.sessions drop constraint if exists sessions_status_check;
alter table public.sessions add constraint sessions_status_check
  check (status in ('Scheduled', 'Done', 'Cancelled', 'Early Cancel', 'Late Cancel', 'No Show', ''));
-- packages.status has no check; empty is allowed (the default 'Active' only applies to new rows that leave it out)

-- ---------- 3. sheet row order ----------
do $$
declare t text;
begin
  foreach t in array array['clients', 'client_notes', 'packages', 'sessions', 'session_clients', 'leads', 'client_requests', 'notices',
    'game_players', 'streaks', 'wallet_ledger', 'client_goals', 'wo_programs', 'wo_logs', 'client_body', 'wo_decisions', 'wo_exercises',
    'nutrition_intake', 'nutrition_plans', 'nutrition_weighins', 'insurance_clients', 'insurance_claims', 'recurring_expenses', 'expenses',
    'inventory', 'pos_sales', 'session_notes', 'physio_intake', 'client_files', 'client_photos'] loop
    execute format('alter table public.%I add column if not exists sheet_row int', t);
  end loop;
end $$;
alter table public.clients  add column if not exists sheet_tab text;   -- CLIENTS (Client Portal) or APP GUESTS (Operations)
alter table public.sessions add column if not exists sheet_tab text;   -- SESSIONS 11 / 12 / 13 / MADERO / PHYSIOPREHAB / OSTEO
alter table public.session_clients add column if not exists sheet_tab text;

-- ---------- 4. inventory: same product name may appear twice ----------
alter table public.inventory drop constraint if exists inventory_item_key;
create index if not exists inventory_item_idx on public.inventory (item);
