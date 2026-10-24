-- =====================================================================
-- WELLBE on Supabase: 0001 schema
-- Mirrors the Google Sheets of today (Operations + Client Portal) as real tables.
-- Rules:
--   * every table has a uuid id plus legacy_id = today's ID (C012, PKG-0173, S13-0001, G0004, W40-0001)
--   * money is integer cents (price_cents, paid_cents, amount_cents)
--   * calendar days are DATE, moments are TIMESTAMPTZ. "Today" is always Beirut today: app_today()
--   * business settings live in staff, package_types and settings (same as Config.gs + the 3 tabs)
-- =====================================================================
create extension if not exists pgcrypto;

create schema if not exists app;      -- private helpers (not exposed through the API)

-- ---------------------------------------------------------------------
-- SETTINGS (Config.gs CFG_DEFAULTS + STAFF / PACKAGE TYPES / SETTINGS tabs)
-- ---------------------------------------------------------------------
create table public.staff (
  id          text primary key check (id ~ '^[a-z0-9_]+$'),      -- 'joe': never changes, it is the login link
  name        text not null,
  name_ar     text,
  role        text not null check (role in ('owner', 'assistant', 'trainer')),
  trainer     text not null default '',                          -- name in the Trainer column ('Joe'), '' for Romy
  match       text not null default '',                          -- piece of the name to find in old rows ('mik')
  email       text,
  phone       text,
  cap         int check (cap is null or cap > 0),                -- max clients in one hour across 1:1, 1:2, 1:3
  pay         jsonb not null default '{}'::jsonb,                -- {rule:'tier'|'fixed'|'cut', base, cut, fixed:{training,Physio,...}}
  train       boolean not null default false,                    -- shows in Book and Change trainer
  active      boolean not null default true,
  sort        int not null default 0,                            -- order in lists (tab order today)
  updated_at  timestamptz not null default now()
);

create table public.package_types (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,                            -- exactly as sold: '1:3 - 8x/month ($140pp)'
  passes        int not null check (passes >= 0),
  price_cents   int not null check (price_cents >= 0),
  kind          text not null check (kind in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero')),
  valid_days    int check (valid_days is null or valid_days > 0),
  valid_months  int check (valid_months is null or valid_months > 0),   -- wins over valid_days
  monthly       boolean not null default false,                  -- can be sold as a 3 or 6 month bundle ('x/month' today)
  mel           boolean not null default false,                  -- "PT with Mel": the client becomes Melanie's client
  trial         boolean not null default false,
  free          boolean not null default false,
  shop          boolean not null default false,                  -- listed in the client app
  active        boolean not null default true,
  sort          int not null default 0
);

-- one row per group: center, trial, pay, services, offers, late, hours, windows, streak, insurance, game, lists
create table public.settings (
  key         text primary key,
  value       jsonb not null,
  notes       text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PEOPLE
-- ---------------------------------------------------------------------
create table public.clients (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,                                     -- C012 (client) or G0004 (guest)
  kind          text not null default 'client' check (kind in ('client', 'guest')),
  name          text not null,
  email         text,                                            -- the login email; a child row holds the parent's email
  phone         text,
  parent_email  text,                                            -- set when this row is a child managed by a parent
  is_mel        boolean not null default false,                  -- Melanie's own client (pay split)
  lead_id       uuid,                                            -- guest who came from an ad lead
  converted_to  uuid references public.clients(id),             -- guest who became a client
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index on public.clients (lower(email));
create index on public.clients (lower(parent_email));

create table public.client_notes (                               -- CLIENT NOTES: medical notes always shown to coaches
  client_id    uuid primary key references public.clients(id) on delete cascade,
  always_show  text not null default '',
  program      text not null default '',
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create table public.session_notes (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  session_id  uuid,
  client_id   uuid references public.clients(id) on delete cascade,
  by_staff    text,
  note        text not null,
  logged_at   timestamptz not null default now()
);

create table public.physio_intake (
  id            uuid primary key default gen_random_uuid(),
  day           date not null,
  client_id     uuid not null references public.clients(id) on delete cascade,
  by_staff      text,
  body_area     text, complaint text, pain_now int, red_flags text, impression text, plan text,
  form          jsonb not null default '{}'::jsonb
);

create table public.client_files (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  file_name    text not null,
  storage_path text not null,                                   -- Supabase Storage path (was a Drive link)
  file_type    text,
  uploaded_by  text,
  day          date not null default (now() at time zone 'Asia/Beirut')::date
);

create table public.client_goals (                               -- CLIENT GOALS: the promise + 3 keys
  client_id  uuid primary key references public.clients(id) on delete cascade,
  promise    text, key1 text, key2 text, key3 text,
  made_by    text,
  updated_at timestamptz not null default now()
);

create table public.client_photos (                              -- Profile.gs: small photo per client (Storage path, not base64)
  client_id    uuid primary key references public.clients(id) on delete cascade,
  storage_path text not null,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PACKAGES (PACKAGES tab, 23 columns)
-- ---------------------------------------------------------------------
create table public.packages (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,                                 -- PKG-0173
  client_id         uuid not null references public.clients(id),
  type_name         text not null,                               -- label as sold (old labels kept as they are)
  kind              text not null check (kind in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero')),
  passes            int not null default 0,                      -- Total Sessions (E)
  used              int not null default 0,                      -- Used (F), = count of Y pass flags, kept by recount
  price_cents       int not null default 0,                      -- Price (I)
  paid_cents        int not null default 0,                      -- Paid (V)
  discount_pct      numeric(6,2) not null default 0,             -- (T) stored as % (7 = 7%)
  start_date        date,                                        -- (J)
  expiry_date       date,                                        -- (K)
  extended_expiry   date,                                        -- (L) freeze
  effective_expiry  date,                                        -- (M) what counts
  status            text not null default 'Active',              -- (N) Active / Expired / Cancelled / Forfeited
  new_client        boolean not null default false,              -- (P) Romy's bonus flag
  note              text not null default '',                    -- (U)
  created_by        text,
  created_at        timestamptz not null default now()
);
create index on public.packages (client_id);
create index on public.packages (status);
-- left / per pass / due are derived, never stored
create view public.packages_v with (security_invoker = true) as
  select p.*, greatest(0, p.passes - p.used) as left_passes,
         case when p.passes > 0 then round(p.price_cents::numeric / p.passes) else 0 end as per_pass_cents,
         greatest(0, p.price_cents - p.paid_cents) as due_cents,
         coalesce(p.effective_expiry, p.expiry_date) as end_date
    from public.packages p;

-- ---------------------------------------------------------------------
-- SESSIONS: one table for 1:1, 1:2, 1:3, Physio, Prehab, Osteo, Madero
-- ---------------------------------------------------------------------
create table public.sessions (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,                                       -- S13-0001, S12-0002, SPP-0004 ...
  kind        text not null check (kind in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero')),
  day         date not null,
  start_time  time not null,
  end_time    time not null,
  trainer     text not null default '',                          -- trainer name ('Joe'); fixed services use the fixed trainer
  room        text not null default '',
  status      text not null default 'Scheduled' check (status in ('Scheduled', 'Done', 'Cancelled', 'Late Cancel', 'No Show')),
  pay_source  text not null default '',                          -- physio: 'Client Direct' / insurance
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index on public.sessions (day);
create index on public.sessions (trainer, day);

create table public.session_clients (
  session_id  uuid not null references public.sessions(id) on delete cascade,
  slot        int not null check (slot between 0 and 2),
  package_id  uuid not null references public.packages(id),
  client_id   uuid not null references public.clients(id),
  name        text not null default '',
  att         text not null default '' check (att in ('', 'Present', 'Late Cancel', 'No Show', 'Early Cancel')),
  pass        text not null default '' check (pass in ('', 'Y', 'N')),   -- Y = a pass is used
  gcal_event  text,
  primary key (session_id, slot)
);
create index on public.session_clients (package_id);
create index on public.session_clients (client_id);

-- ---------------------------------------------------------------------
-- LEADS (LEADS W40) and CLIENT REQUESTS and NOTICES
-- ---------------------------------------------------------------------
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,                                   -- W40-0001
  submitted_at    timestamptz not null default now(),
  name text, phone text, email text,
  trained_before text, stopped text, why_now text, injuries text,
  trial_date date, trial_time text, booking_type text,
  status          text not null default 'No Booking' check (status in ('No Booking', 'Pending', 'Confirmed', 'Cancelled', 'No Answer')),
  called text, notes text, source text,
  client_id uuid references public.clients(id), package_id uuid references public.packages(id), session_id uuid references public.sessions(id)
);

create table public.client_requests (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,                                       -- REQ-00001
  created_at  timestamptz not null default now(),
  client_id   uuid not null references public.clients(id),
  type        text not null,                                     -- Physio visit, Freeze, Reschedule, 3 month offer, 6 month upgrade, Game cash, ...
  details     text not null default '',
  slot        text not null default '',
  package_id  uuid references public.packages(id),
  status      text not null default 'New' check (status in ('New', 'Done', 'Declined')),
  handled_by  text,
  handled_at  timestamptz,
  data        jsonb not null default '{}'::jsonb
);
create index on public.client_requests (status);

create table public.notices (                                    -- in-app messages
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,                                       -- NT-00001
  created_at  timestamptz not null default now(),
  for_client  uuid references public.clients(id) on delete cascade,
  for_staff   text references public.staff(id),
  type        text not null,
  text        text not null,
  read_at     timestamptz,
  check ((for_client is null) <> (for_staff is null))
);

-- ---------------------------------------------------------------------
-- WORKOUTS
-- ---------------------------------------------------------------------
create table public.wo_programs (
  client_id  uuid primary key references public.clients(id) on delete cascade,
  program    jsonb not null default '{}'::jsonb,
  version    int not null default 1,
  updated_by text,
  updated_at timestamptz not null default now()
);
create table public.wo_decisions (
  session_id uuid not null references public.sessions(id) on delete cascade,
  client_id  uuid not null references public.clients(id) on delete cascade,
  choice text, missed_workout text, decided_by text, decided_at timestamptz not null default now(),
  primary key (session_id, client_id)
);
create table public.wo_logs (
  id         uuid primary key default gen_random_uuid(),
  logged_at  timestamptz not null default now(),
  day        date not null,
  client_id  uuid not null references public.clients(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  workout    text, exercise text not null,
  sets       jsonb not null default '[]'::jsonb,                 -- [{kg, reps}]
  by_who     text
);
create index on public.wo_logs (client_id, day);
create table public.wo_exercises (group_name text not null, exercise text not null, added_by text, day date, primary key (group_name, exercise));

create table public.client_body (                                -- CLIENT BODY
  id uuid primary key default gen_random_uuid(),
  day date not null, client_id uuid not null references public.clients(id) on delete cascade,
  weight_kg numeric(5,1), height_cm numeric(5,1), birth_year int, sex text, goal_weight_kg numeric(5,1), by_who text
);

-- ---------------------------------------------------------------------
-- NUTRITION
-- ---------------------------------------------------------------------
create table public.nutrition_intake (
  client_id uuid primary key references public.clients(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb, step int not null default 0, done boolean not null default false,
  version int not null default 1, target_kg numeric(5,1), body_comp jsonb, flags text, updated_at timestamptz not null default now()
);
create table public.nutrition_plans (
  id uuid primary key default gen_random_uuid(), legacy_id text unique,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null check (status in ('Queued', 'Writing', 'Pending', 'Approved', 'Declined', 'Failed', 'Coach review', 'Replaced')),
  macros jsonb, plan jsonb, intake_version int, weight_at_plan numeric(5,1), target numeric(5,1),
  by_who text, decided_at timestamptz, coach_note text, error text, attempts int not null default 0, writing_since timestamptz
);
create index on public.nutrition_plans (status);
create table public.nutrition_weighins (
  id uuid primary key default gen_random_uuid(), day date not null,
  client_id uuid not null references public.clients(id) on delete cascade, weight_kg numeric(5,1) not null, by_who text
);

-- ---------------------------------------------------------------------
-- GAME: Corniche Run (coins = game only, credit = Wellbe Credit in cents)
-- ---------------------------------------------------------------------
create table public.game_players (
  client_id       uuid primary key references public.clients(id) on delete cascade,
  name            text not null default '',
  best_score      int not null default 0,
  best_m          int not null default 0,
  coins           int not null default 0 check (coins >= 0),
  runs            int not null default 0,
  total_m         bigint not null default 0,
  day_key         date, day_best int not null default 0,
  week_key        date, week_best int not null default 0,
  upgrades        jsonb not null default '{}'::jsonb,            -- {magnet, jet, shoes, life}
  missions        jsonb not null default '{}'::jsonb,            -- today's state {d, st, done, bonus, cash, trx, wl, wb}
  badges          jsonb not null default '[]'::jsonb,
  last_run_at     timestamptz,
  earned_total    bigint not null default 0,
  credit_cents    int not null default 0 check (credit_cents >= 0),   -- Wellbe Credit balance not sent yet
  credit_earned_cents int not null default 0,
  xp              bigint not null default 0,
  owned           jsonb not null default '{}'::jsonb,            -- shop items, tickets, lbHide
  created_at      timestamptz not null default clock_timestamp(),   -- tie order on the leaderboards (sheet row order today)
  updated_at      timestamptz not null default now()
);
create table public.game_runs (
  id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id) on delete cascade,
  at timestamptz not null default now(), secs int, m int, ran_m int, coins int, score int, spent int, earned int,
  credit_cents int not null default 0, xp int not null default 0, ev jsonb
);
create index on public.game_runs (client_id, at);
create table public.coin_ledger (                                -- every coin in or out
  id bigserial primary key, client_id uuid not null references public.clients(id) on delete cascade,
  at timestamptz not null default now(), delta int not null, reason text not null
);
create table public.credit_ledger (                              -- every Wellbe Credit cent in or out
  id bigserial primary key, client_id uuid not null references public.clients(id) on delete cascade,
  at timestamptz not null default now(), delta_cents int not null, reason text not null, request_id uuid
);

create table public.streaks (                                    -- CLIENT STREAKS
  client_id    uuid primary key references public.clients(id) on delete cascade,
  done_days    date[] not null default '{}',
  keys_day     date,
  keys         boolean[] not null default '{false,false,false}',
  last_reward  date,
  reward_pkg   uuid references public.packages(id),
  rewards      int not null default 0
);

-- ---------------------------------------------------------------------
-- MONEY: wallet, insurance, expenses, POS
-- ---------------------------------------------------------------------
create table public.wallet_ledger (                              -- WALLET tab: refundable overpayments (+) and uses (-)
  id uuid primary key default gen_random_uuid(), day date not null,
  client_id uuid not null references public.clients(id), amount_cents int not null, reason text, package_id uuid references public.packages(id), by_who text
);
create table public.insurance_clients (
  client_id uuid primary key references public.clients(id) on delete cascade,
  insurer text not null, member_number text, notes text, rate_cents int, updated_at timestamptz not null default now(), by_who text
);
create table public.insurance_claims (
  id uuid primary key default gen_random_uuid(), legacy_id text unique,
  client_id uuid not null references public.clients(id), insurer text not null, month date not null,
  sessions int not null default 0, amount_cents int not null default 0, package_ids uuid[] not null default '{}',
  submitted date, expected date, reference text, status text not null default 'To send',
  paid_on date, paid_cents int, by_who text
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), day date not null, what text not null, category text,
  amount_cents int not null, method text, by_who text, recurring_id uuid
);
create table public.recurring_expenses (
  id uuid primary key default gen_random_uuid(), legacy_id text unique, what text not null, category text,
  amount_cents int not null, every text not null, first_day date not null, end_day date, active boolean not null default true, last_logged date
);
create table public.inventory (
  id uuid primary key default gen_random_uuid(), item text not null unique, price_cents int not null default 0, stock int not null default 0, cost_cents int
);
create table public.pos_sales (
  id uuid primary key default gen_random_uuid(), at timestamptz not null default now(),
  client_id uuid references public.clients(id), item text not null, qty int not null default 1,
  amount_cents int not null, method text, by_who text
);

-- ---------------------------------------------------------------------
-- ACCOUNTS: login codes, deletion requests, audit
-- ---------------------------------------------------------------------
create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(), legacy_id text unique, created_at timestamptz not null default now(),
  email text not null, client_ids uuid[] not null default '{}', names text,
  status text not null default 'New', done_by text, done_at timestamptz
);
create table public.audit_log (
  id bigserial primary key, at timestamptz not null default now(),
  actor uuid, actor_label text, action text not null, entity text, entity_id uuid, data jsonb
);
create table public.outbox (                                     -- WhatsApp / email / push sent by a worker AFTER the write commits
  id bigserial primary key, created_at timestamptz not null default now(),
  channel text not null check (channel in ('whatsapp', 'email', 'push')),
  to_staff text, to_client uuid, to_address text, body text not null, data jsonb,
  sent_at timestamptz, attempts int not null default 0, error text
);
