-- =====================================================================
-- WELLBE on Supabase: 0005 boot reads
-- Every screen's first load, ported 1:1 from the Apps Script:
--   public.api_app_boot(p)     staff app (App.gs appBoot_ + insBoot_ + walletBoot_ + appTrainerScope_ + noticesFor_)
--   public.api_app_history(p)  owner analytics, sessions older than the staff window (App.gs appHistory_)
--   public.api_app_cl_boot(p)  client app (Client.gs clBoot_ + insClientBoot_ + profBoot_), guests (Guest.gs guestBoot_)
-- Same JSON as the Apps Script answer, without "ok". Money in dollars (cents inside), IDs = legacy IDs (C012, PKG-0173, S13-0001).
-- Sheet row numbers do not exist any more: "row" and "ref" carry the legacy ID (writes find rows by ID).
-- =====================================================================

-- ---------------------------------------------------------------------
-- schema additions (data the boots show that 0001 had no place for)
-- ---------------------------------------------------------------------
alter table public.clients add column if not exists discount_pct numeric(6,2) not null default 0;      -- CLIENT NOTES col H (client discount)
alter table public.clients add column if not exists guest_asked jsonb not null default '{}'::jsonb;   -- APP GUESTS "Asked" (what a guest already asked for)
alter table public.physio_intake add column if not exists created_at timestamptz not null default clock_timestamp();   -- sheet order
alter table public.client_files add column if not exists created_at timestamptz not null default clock_timestamp();
alter table public.expenses add column if not exists created_at timestamptz not null default clock_timestamp();
alter table public.inventory add column if not exists created_at timestamptz not null default clock_timestamp();
alter table public.insurance_clients add column if not exists created_at timestamptz not null default clock_timestamp();
alter table public.pos_sales add column if not exists to_name text not null default '';                -- POS SALES col D (sold to)
alter table public.pos_sales add column if not exists profit_cents int not null default 0;             -- POS SALES col H
-- busy times of the physio calendar (Google Calendar today). Filled by a sync worker; the boot reads it instead of CalendarApp.
create table if not exists public.calendar_busy (
  id         uuid primary key default gen_random_uuid(),
  calendar   text not null default 'physio',
  source_id  text unique,                                        -- Google event id
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  all_day    boolean not null default false,
  synced_at  timestamptz not null default now()
);
create index if not exists calendar_busy_start on public.calendar_busy (start_at);
-- Wellbe The Brand catalog (Shopify products.json, picked by settings shop.brand). Filled by a worker every 6 hours.
create table if not exists public.brand_cache (
  key        text primary key default 'brand',
  items      jsonb not null default '[]'::jsonb,                 -- [{t, d, p, was, img, url, h}] exactly as Profile.gs profBrand_
  fetched_at timestamptz not null default now()
);
alter table public.calendar_busy enable row level security; alter table public.calendar_busy force row level security;
alter table public.brand_cache enable row level security;   alter table public.brand_cache force row level security;
drop policy if exists busy_desk on public.calendar_busy;
create policy busy_desk on public.calendar_busy for select using (app.is_desk());
drop policy if exists brand_read on public.brand_cache;
create policy brand_read on public.brand_cache for select using (app.my_role() <> 'anon');
grant select on public.calendar_busy, public.brand_cache to authenticated;

-- ---------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------
-- cents -> dollars as JavaScript prints them (130.2, 7, 12.35)
create or replace function app.usd(c bigint) returns numeric language sql immutable as $$ select app.jsnum(coalesce(c, 0) / 100.0)::numeric $$;
create or replace function app.ymd(d date) returns text language sql immutable as $$ select coalesce(to_char(d, 'YYYY-MM-DD'), '') $$;
create or replace function app.stamp_dmy(t timestamptz) returns text language sql stable as $$
  select coalesce(to_char(t at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI'), '') $$;
create or replace function app.ms(t timestamptz) returns bigint language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;
create or replace function app.cnum(legacy text) returns int language sql immutable as $$ select coalesce(substring(legacy from '\d+')::int, 0) $$;
-- '8:00', '08:00 am', '4 pm' -> hour (Code.gs toHour_)
create or replace function app.hour_of(t text) returns int language plpgsql immutable as $$
declare m text[] := regexp_match(btrim(coalesce(t, '')), '^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?', 'i'); h int; ap text;
begin
  if m is null then return null; end if;
  h := m[1]::int; ap := lower(coalesce(m[3], ''));
  if left(ap, 1) = 'p' and h < 12 then h := h + 12; end if;
  if left(ap, 1) = 'a' and h = 12 then h := 0; end if;
  return h;
end $$;

-- sessions of a date range, the way the staff app reads them (App.gs appSessions_ + appSessObj_):
-- only sessions with at least one client; status read from the row and the attendance; tab order then ID order.
create or replace function app.boot_sess(p_from date, p_to date)
returns table (id uuid, legacy_id text, k text, tab text, day date, hm text, hm_end text, trainer text, room text, status text, pay text, n int, ord int, at_ms bigint)
language sql stable security definer set search_path = public as $$
  select s.id, s.legacy_id, case when s.kind in ('Physio', 'Prehab') then 'PP' else s.kind end, s.kind, s.day,
         to_char(s.start_time, 'HH24:MI'), to_char(s.end_time, 'HH24:MI'), s.trainer, s.room,
         case when s.status = 'Cancelled' or c.allc then 'Cancelled'
              when s.status = 'Done' or (case when s.kind = '1:2' then c.alla else c.anya end) then 'Done' else 'Scheduled' end,
         case when s.kind in ('Physio', 'Prehab') then s.pay_source else '' end,
         c.n, case s.kind when '1:1' then 1 when '1:2' then 2 when '1:3' then 3 when 'Physio' then 4 when 'Prehab' then 4 when 'Osteo' then 5 else 6 end,
         app.ms(app.at(s.day, s.start_time))
    from public.sessions s
    join lateral (select count(*)::int as n, bool_and(sc.att ~ 'Cancel') as allc, bool_and(sc.att <> '') as alla, bool_or(sc.att <> '') as anya
                    from public.session_clients sc where sc.session_id = s.id) c on c.n > 0
   where s.day between p_from and p_to
$$;
-- the same as the staff app's session objects (with cid on every client)
create or replace function app.boot_sess_json(p_from date, p_to date, p_trainer text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.legacy_id, 'ref', s.k || '|' || s.legacy_id, 'tab', s.tab, 'date', app.ymd(s.day), 'start', s.hm, 'end', s.hm_end,
           'trainer', s.trainer, 'room', s.room, 'status', s.status, 'pay', s.pay,
           'clients', (select jsonb_agg(jsonb_build_object('slot', sc.slot, 'pkg', p.legacy_id, 'name', sc.name, 'att', sc.att, 'flag', sc.pass, 'reminded', false, 'note', '', 'cid', c.legacy_id) order by sc.slot)
                         from public.session_clients sc join public.packages p on p.id = sc.package_id join public.clients c on c.id = p.client_id where sc.session_id = s.id))
         order by s.ord, s.legacy_id), '[]'::jsonb)
    from app.boot_sess(p_from, p_to) s where p_trainer is null or s.trainer = p_trainer
$$;
-- end date of a package in the client app: effective, then extended, then expiry (Client.gs clBoot_)
create or replace function app.cl_end(p public.packages) returns date language sql immutable as $$ select coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date) $$;
create or replace function app.cl_phase(p public.packages, today date) returns text language sql immutable as $$
  select case when p.status ~* 'cancel' then 'past'
              when btrim(p.status) = 'Active' and p.start_date > today then 'future'
              when btrim(p.status) = 'Active' and p.passes > 0 and not coalesce(app.cl_end(p) < today and p.used >= p.passes, false) then 'current'
              else 'past' end
$$;
-- a client request as the apps show it (Client.gs clReqObj_)
create or replace function app.req_json(q public.client_requests) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', q.legacy_id, 'created', app.stamp_dmy(q.created_at), 'cid', c.legacy_id, 'client', c.name, 'type', q.type, 'details', q.details,
    'slot', q.slot, 'pkg', coalesce((select legacy_id from public.packages where id = q.package_id), ''), 'status', q.status, 'by', coalesce(q.handled_by, ''),
    'handled', app.stamp_dmy(q.handled_at), 'data', q.data)
    from public.clients c where c.id = q.client_id
$$;
-- the promise + 3 keys (Client.gs clGoalsMap_), null when there is no promise
create or replace function app.goal_json(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('promise', g.promise, 'keys', to_jsonb(array_remove(array[nullif(g.key1, ''), nullif(g.key2, ''), nullif(g.key3, '')], null)), 'updated', app.stamp_dmy(g.updated_at))
    from public.client_goals g where g.client_id = p_client and coalesce(g.promise, '') <> ''
$$;
-- unread notices (newest first, max 30) for staff ids or client ids (App.gs noticesFor_)
create or replace function app.notices_json(p_staff text, p_clients uuid[]) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(o order by at desc, lid desc), '[]'::jsonb) from (
    select n.created_at as at, n.legacy_id as lid, jsonb_build_object('id', n.legacy_id, 'created', app.stamp_dmy(n.created_at), 'for', coalesce(c.legacy_id, n.for_staff), 'type', n.type, 'text', n.text) as o
      from public.notices n left join public.clients c on c.id = n.for_client
     where n.read_at is null and ((p_staff is not null and n.for_staff = p_staff) or n.for_client = any(coalesce(p_clients, '{}')))
     order by n.created_at desc, n.legacy_id desc limit 30) x
$$;
-- package types listed in the client and guest app (Config.gs cfgShopTypes_)
create or replace function app.shop_types() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'label', regexp_replace(name, '\s*\(\$[^)]*\)', ''), 'n', passes, 'price', app.usd(price_cents), 'kind', kind) order by sort), '[]'::jsonb)
    from public.package_types where active and shop and price_cents > 0
$$;
create or replace function app.brand() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select items from public.brand_cache where key = 'brand'), '[]'::jsonb)
$$;

-- free trial slots for the guest app and the landing page (Code.gs getSlots_): the trial trainer's load per hour
-- across 1:1, 1:2, 1:3 plus Pending leads; full = no room or a 1:1 / 1:2 client at that hour
create or replace function app.trial_days() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare today date := app_today(); ahead int := app.setting_int('{windows,trialAhead}', 7); notice int := app.setting_int('{windows,trialNoticeH}', 12);
  st public.staff; cap int; d date; dow int; h int; slots jsonb; out jsonb := '[]'; v_all int; v_13 int; pend int; lft int;
  blocked jsonb := coalesce(app.setting('{hours,blocked}'), '[]'); tdays jsonb := coalesce(app.setting('{hours,trialDays}'), '[]');
begin
  select * into st from public.staff where id = app.setting('{trial,trainer}') #>> '{}';
  cap := coalesce(st.cap, (app.setting('{services,1:3,cap}'))::text::int, 0);
  for i in 0 .. ahead loop
    d := today + i; dow := extract(isodow from d)::int;
    if not tdays @> to_jsonb(dow) or blocked ? app.ymd(d) then continue; end if;
    slots := '[]';
    for h in select (x #>> '{}')::int from jsonb_array_elements(coalesce(app.setting('{hours,trial}'), '[]')) x loop
      if app.at(d, make_time(h, 0, 0)) - now() < make_interval(hours => notice) then continue; end if;
      select coalesce(sum(n), 0), coalesce(sum(n) filter (where s.kind = '1:3'), 0) into v_all, v_13
        from public.sessions s, lateral (select count(*)::int n from public.session_clients sc where sc.session_id = s.id) c
       where st.id is not null and s.trainer = st.trainer and s.kind in ('1:1', '1:2', '1:3') and s.day = d and extract(hour from s.start_time) = h and s.status !~* 'cancel';
      select count(*) into pend from public.leads where status = 'Pending' and trial_date = d and app.hour_of(trial_time) = h;
      lft := greatest(0, cap - v_all - pend);
      slots := slots || jsonb_build_object('hour', h, 'type', case when lft = 0 or v_all - v_13 > 0 then 'full' else 'instant' end);
    end loop;
    if jsonb_array_length(slots) > 0 then out := out || jsonb_build_object('date', app.ymd(d), 'dow', dow, 'slots', slots); end if;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- STAFF BOOT
-- ---------------------------------------------------------------------
create or replace function public.api_app_boot(p jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb := app.caller(); v_role text := c->>'role'; st public.staff; today date := app_today();
  back int := app.setting_int('{windows,staffBack}', 70); ahead int := app.setting_int('{windows,ahead}', 35); see int := app.setting_int('{windows,trainerSee}', 60);
  bundle int := app.setting_int('{offers,bundleDays}', 70); month_start date := date_trunc('month', today)::date;
  ids uuid[]; trainer boolean; out jsonb; pk jsonb; cl jsonb;
begin
  if v_role not in ('owner', 'assistant', 'trainer') then raise exception 'auth'; end if;
  select * into st from public.staff where id = c->>'staff';
  trainer := v_role = 'trainer';
  out := jsonb_build_object('me', jsonb_build_object('id', st.id, 'name', st.name, 'role', st.role, 'trainer', st.trainer), 'today', app.ymd(today),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('t', name, 'n', passes, 'p', app.usd(price_cents), 'kind', kind) order by sort), '[]') from public.package_types where active),
    'cfg', public.public_cfg());

  -- clients a trainer may see: trained in the last trainerSee days or booked ahead (not cancelled)
  if trainer then
    select array_agg(distinct p.client_id) into ids
      from app.boot_sess(today - back, today + ahead) s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id
     where s.trainer = st.trainer and s.status <> 'Cancelled' and s.day >= today - see;
    ids := coalesce(ids, '{}');
  end if;

  -- packages
  select coalesce(jsonb_agg(o order by lid), '[]') into pk from (
    select p.legacy_id as lid,
      case when trainer then jsonb_build_object('id', p.legacy_id, 'client', c2.legacy_id, 'name', c2.name, 'type', regexp_replace(p.type_name, '\s*\(\$[^)]*\)', ''), 'kind', p.kind,
             'total', p.passes, 'used', p.used, 'price', app.usd(greatest(0, p.price_cents - p.paid_cents)), 'paid', 0, 'start', app.ymd(p.start_date),
             'expiry', app.ymd(coalesce(p.effective_expiry, p.expiry_date)), 'status', p.status)
           else jsonb_build_object('id', p.legacy_id, 'row', p.legacy_id, 'client', c2.legacy_id, 'name', c2.name, 'type', p.type_name, 'total', p.passes, 'used', p.used,
             'price', app.usd(p.price_cents), 'paid', app.usd(p.paid_cents), 'start', app.ymd(p.start_date), 'expiry', app.ymd(coalesce(p.effective_expiry, p.expiry_date)),
             'status', p.status, 'kind', p.kind) end
      || case when exists (select 1 from public.client_requests q where q.package_id = p.id and q.type = 'Freeze' and q.status <> 'Declined') then '{"frozen":1}'::jsonb else '{}' end
      || case when p.type_name ~ 'x/month' and p.start_date is not null and (select count(*) from public.packages q where q.client_id = p.client_id and q.type_name = p.type_name
                and q.start_date is not null and abs(q.start_date - p.start_date) <= bundle) >= 3 then '{"months":3}'::jsonb else '{}' end
      || case when p.discount_pct <> 0 then jsonb_build_object('disc', p.discount_pct / 100) else '{}' end as o
      from public.packages p join public.clients c2 on c2.id = p.client_id
     where not trainer or p.client_id = any(ids)) x;

  -- clients, their medical notes, last coach notes and promise
  select coalesce(jsonb_agg(o order by app.cnum(lid), lid), '[]') into cl from (
    select c2.legacy_id as lid,
      jsonb_build_object('id', c2.legacy_id, 'name', c2.name, 'email', case when trainer then '' else coalesce(c2.email, '') end, 'phone', case when trainer then '' else coalesce(c2.phone, '') end,
        'notes', coalesce(n.always_show, ''), 'program', coalesce(n.program, ''),
        'log', coalesce((select jsonb_agg(jsonb_build_object('d', app.ymd(l.day), 'sid', coalesce((select legacy_id from public.sessions where id = l.session_id), ''), 'by', coalesce(l.by_staff, ''), 't', l.note) order by l.logged_at desc)
                          from (select * from public.session_notes where client_id = c2.id order by logged_at desc limit 8) l), '[]'))
      || case when trainer then jsonb_build_object('mel', n.client_id is not null and c2.is_mel)
              when n.client_id is not null then jsonb_build_object('mel', c2.is_mel, 'disc', c2.discount_pct) else '{}' end
      || coalesce(jsonb_build_object('goal', app.goal_json(c2.id)) - case when app.goal_json(c2.id) is null then 'goal' else '' end, '{}') as o
      from public.clients c2 left join public.client_notes n on n.client_id = c2.id
     where c2.kind = 'client' and c2.legacy_id ~ '^C\d+$' and c2.deleted_at is null and (not trainer or c2.id = any(ids))) x;

  out := out || jsonb_build_object('sessions', app.boot_sess_json(today - back, today + ahead, case when trainer then st.trainer end), 'clients', cl, 'pkgs', pk);

  if trainer then
    out := out || jsonb_build_object('intakes', (select coalesce(jsonb_agg(app.intake_json(i) order by i.created_at), '[]') from public.physio_intake i where i.client_id = any(ids)),
      'leads', '[]'::jsonb, 'leadFollowups', '[]'::jsonb, 'expenses', '[]'::jsonb, 'recurring', '[]'::jsonb, 'pos', '[]'::jsonb, 'inventory', '[]'::jsonb);
  else
    out := out || jsonb_build_object(
      'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', l.legacy_id, 'row', l.legacy_id, 'name', coalesce(l.name, ''), 'phone', coalesce(l.phone, ''), 'date', app.ymd(l.trial_date),
                  'time', coalesce(l.trial_time, ''), 'type', coalesce(l.booking_type, ''), 'status', l.status, 'injuries', coalesce(nullif(l.injuries, ''), 'No'), 'why', coalesce(l.why_now, ''),
                  'submitted', to_char(l.submitted_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI:SS')) order by l.legacy_id), '[]')
                  from public.leads l where l.status not in ('Cancelled', 'No Answer')),
      'leadFollowups', (select coalesce(jsonb_agg(jsonb_build_object('id', f.legacy_id, 'row', f.legacy_id, 'name', coalesce(f.name, ''), 'phone', coalesce(f.phone, ''), 'stage', f.stage, 'status', f.status,
                  'submitted', to_char(f.submitted_at at time zone 'Asia/Beirut', 'YYYY-MM-DD HH24:MI'), 'date', app.ymd(f.trial_date), 'time', coalesce(f.trial_time, '')) order by f.submitted_at, f.legacy_id), '[]')
                  from public.lead_followups f),
      'requests', (select coalesce(jsonb_agg(app.req_json(q) order by q.created_at, q.legacy_id), '[]') from public.client_requests q where q.status = 'New'));
    if v_role = 'owner' then
      out := out || jsonb_build_object(
        'intakes', (select coalesce(jsonb_agg(app.intake_json(i) order by i.created_at), '[]') from public.physio_intake i),
        'files', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', f.file_name, 'url', f.storage_path, 'type', coalesce(f.file_type, ''), 'by', coalesce(f.uploaded_by, ''), 'date', app.ymd(f.day)) order by f.created_at), '[]')
                    from public.client_files f join public.clients c2 on c2.id = f.client_id));
    end if;
    out := out || jsonb_build_object(
      'expenses', (select coalesce(jsonb_agg(jsonb_build_object('d', app.ymd(e.day), 'what', e.what, 'cat', coalesce(e.category, ''), 'amt', app.usd(e.amount_cents)) order by e.created_at), '[]')
                     from public.expenses e where v_role = 'owner' or e.day >= month_start - 31),
      'recurring', (select coalesce(jsonb_agg(jsonb_build_object('id', r.legacy_id, 'what', r.what, 'cat', coalesce(r.category, ''), 'amt', app.usd(r.amount_cents), 'every', r.every,
                     'start', app.ymd(r.first_day), 'end', app.ymd(r.end_day), 'last', app.ymd(r.last_logged)) order by r.legacy_id), '[]') from public.recurring_expenses r where r.active),
      'inventory', (select coalesce(jsonb_agg(jsonb_build_object('p', i.item, 'left', i.stock, 'price', app.usd(i.price_cents), 'cost', app.usd(i.cost_cents)) order by i.created_at), '[]') from public.inventory i),
      'pos', (select coalesce(jsonb_agg(jsonb_build_object('d', app.ymd((s.at at time zone 'Asia/Beirut')::date), 'p', s.item, 'to', s.to_name, 'qty', s.qty, 'price', app.usd(s.amount_cents), 'profit', app.usd(s.profit_cents)) order by s.at), '[]')
                from public.pos_sales s where v_role = 'owner' or (s.at at time zone 'Asia/Beirut')::date >= month_start));
  end if;

  -- wallet balances (Wallet.gs walletMap_) and insurance (Insurance.gs insBoot_); trainers: their own clients, no claims
  out := out || jsonb_build_object('wallet', (select coalesce(jsonb_object_agg(c2.legacy_id, app.usd(w.bal)), '{}') from
      (select client_id, sum(amount_cents) bal from public.wallet_ledger group by 1 having sum(amount_cents) <> 0) w join public.clients c2 on c2.id = w.client_id
      where not trainer or w.client_id = any(ids)));
  if trainer then
    out := out || jsonb_build_object('ins', jsonb_build_object('clients', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', c2.name, 'insurer', i.insurer) order by i.created_at), '[]')
      from public.insurance_clients i join public.clients c2 on c2.id = i.client_id where i.client_id = any(ids)), 'claims', '[]'::jsonb));
  else
    out := out || jsonb_build_object('ins', jsonb_build_object(
      'clients', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', c2.name, 'insurer', i.insurer, 'member', coalesce(i.member_number, ''), 'notes', coalesce(i.notes, ''),
                    'rate', coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric)) order by i.created_at), '[]')
                    from public.insurance_clients i join public.clients c2 on c2.id = i.client_id),
      'claims', (select coalesce(jsonb_agg(jsonb_build_object('id', k.legacy_id, 'cid', c2.legacy_id, 'name', c2.name, 'insurer', k.insurer, 'month', to_char(k.month, 'YYYY-MM'),
                    'sessions', k.sessions, 'amount', app.usd(k.amount_cents),
                    'pkgs', coalesce((select string_agg(p.legacy_id, ', ' order by x.o) from unnest(k.package_ids) with ordinality x(id, o) join public.packages p on p.id = x.id), ''),
                    'submitted', app.ymd(k.submitted), 'expected', app.ymd(k.expected), 'ref', coalesce(k.reference, ''), 'status', k.status, 'paidOn', app.ymd(k.paid_on),
                    'paidAmount', app.usd(k.paid_cents)) order by k.legacy_id), '[]')
                  from public.insurance_claims k join public.clients c2 on c2.id = k.client_id)));
  end if;
  return out || jsonb_build_object('notices', app.notices_json(st.id, null));
end $$;

-- physio intake as the staff app shows it (App.gs appIntakeObj_)
create or replace function app.intake_json(i public.physio_intake) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('date', app.ymd(i.day), 'cid', c.legacy_id, 'by', coalesce(i.by_staff, ''), 'area', coalesce(i.body_area, ''), 'complaint', coalesce(i.complaint, ''),
    'pain', coalesce(to_jsonb(i.pain_now), '""'::jsonb), 'flags', coalesce(i.red_flags, ''), 'dx', coalesce(i.impression, ''), 'plan', coalesce(i.plan, ''), 'data', i.form)
    from public.clients c where c.id = i.client_id
$$;

-- owner analytics: sessions from ownerBack days ago to the day before the staff window
create or replace function public.api_app_history(p jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb := app.caller(); today date := app_today();
begin
  if c->>'role' not in ('owner', 'assistant', 'trainer') then raise exception 'auth'; end if;
  if c->>'role' <> 'owner' then raise exception 'not allowed'; end if;
  return jsonb_build_object('sessions', app.boot_sess_json(today - app.setting_int('{windows,ownerBack}', 800), today - app.setting_int('{windows,staffBack}', 70) - 1));
end $$;

-- ---------------------------------------------------------------------
-- CLIENT BOOT (and guests)
-- ---------------------------------------------------------------------
-- physio slots on the physio's calendar (Client.gs clSlots_): 60 minutes, minus calendar busy times, the physio's sessions, pending visit requests
create or replace function app.physio_slots() returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare today date := app_today(); days int := app.setting_int('{windows,physioDays}', 14); notice int := app.setting_int('{windows,physioNoticeH}', 12);
  until date := today + days + 1; phys text := app.fixed_trainer('Physio'); blocked jsonb := coalesce(app.setting('{hours,blocked}'), '[]');
  d date; t text; a timestamptz; out jsonb := '[]';
begin
  create temp table if not exists _busy (bs timestamptz, be timestamptz) on commit drop; truncate _busy;
  insert into _busy select start_at, end_at from public.calendar_busy where not all_day and end_at > app.at(today, '00:00') and start_at < app.at(until, '00:00');
  insert into _busy select app.at(s.day, s.hm::time), app.at(s.day, s.hm::time) + interval '1 hour'
    from app.boot_sess(today - app.setting_int('{windows,clientBack}', 45), today + greatest(app.setting_int('{windows,ahead}', 35), days)) s
   where s.trainer = phys and s.status <> 'Cancelled' and s.day between today and until;
  insert into _busy select app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time), app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time) + interval '1 hour'
    from public.client_requests q where q.type = 'Physio visit' and q.status = 'New' and q.slot ~ '^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}';
  for i in 0 .. days loop
    d := today + i;
    if blocked ? app.ymd(d) then continue; end if;
    for t in select x #>> '{}' from jsonb_array_elements(coalesce(app.setting(array['hours', 'physio', extract(dow from d)::text]), '[]')) x loop
      a := app.at(d, t::time);
      if a - now() < make_interval(hours => notice) then continue; end if;
      if exists (select 1 from _busy where _busy.bs < a + interval '1 hour' and _busy.be > a) then continue; end if;
      out := out || jsonb_build_object('d', app.ymd(d), 't', t);
    end loop;
  end loop;
  return out;
end $$;

create or replace function public.api_app_cl_boot(p jsonb default '{}'::jsonb) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c jsonb := app.caller(); v_role text := c->>'role'; v_email text; today date := app_today(); nowms bigint := app.ms(now());
  back int := app.setting_int('{windows,clientBack}', 45); fwd int := greatest(app.setting_int('{windows,ahead}', 35), app.setting_int('{windows,physioDays}', 14));
  join_h int := app.setting_int('{windows,joinMinH}', 48); join_days int := app.setting_int('{windows,joinDays}', 10);
  seats int := least(coalesce((app.setting('{services,1:3,cap}'))::text::int, 3), 3); blocked jsonb := coalesce(app.setting('{hours,blocked}'), '[]');
  ids uuid[]; g public.clients; a public.clients; acc jsonb; accounts jsonb := '[]'; ins public.insurance_clients; out jsonb; trial jsonb;
  p13 public.packages; can_join int; open jsonb; grid jsonb; d date; dow int; h text; v_o jsonb; ss_n int; ss_full boolean; ss_tr text; photo text;
  center jsonb := app.setting('{center}'); offers jsonb := app.setting('{offers}');
begin
  if v_role not in ('client', 'guest') then raise exception 'signin'; end if;
  v_email := lower((app.me()).email);
  select array_agg(x.id order by app.cnum(x.legacy_id), x.legacy_id) into ids from public.clients x
   where x.kind = 'client' and x.deleted_at is null and (lower(x.email) = v_email or lower(x.parent_email) = v_email);

  out := jsonb_build_object('today', app.ymd(today), 'now', nowms, 'email', v_email, 'review', center->'review', 'wa', center->'wa', 'friend', center->'friend',
    'physio', jsonb_build_object('price', offers->'physioPrice', 'was', offers->'physioWas'));

  -- ---------- guest ----------
  if ids is null then
    select * into g from public.clients x where x.kind = 'guest' and x.deleted_at is null and lower(x.email) = v_email order by x.created_at desc limit 1;
    if g.id is null then raise exception 'signin'; end if;
    select jsonb_build_object('date', app.ymd(l.trial_date), 'time', coalesce(l.trial_time, ''), 'status', l.status) into trial
      from public.leads l where l.id = g.lead_id and l.trial_date is not null and l.status ~ 'Pending|Confirmed';
    acc := jsonb_build_object('cid', g.legacy_id, 'name', g.name, 'first', split_part(g.name, ' ', 1), 'full', false, 'guest', true, 'pkgs', '[]'::jsonb,
      'upcoming', '[]'::jsonb, 'past', '[]'::jsonb, 'requests', '[]'::jsonb, 'goal', app.goal_json(g.id));
    select storage_path into photo from public.client_photos where client_id = g.id;
    if photo is not null then acc := acc || jsonb_build_object('photo', photo); end if;
    return out || jsonb_build_object('guest', jsonb_build_object('id', g.legacy_id, 'phone', coalesce(g.phone, ''), 'trial', trial, 'asked', g.guest_asked,
        'slots', case when trial is null then app.trial_days() else '[]'::jsonb end, 'packages', app.shop_types()),
      'slots', '[]'::jsonb, 'shop', '[]'::jsonb, 'accounts', jsonb_build_array(acc), 'brand', app.brand(), 'cfg', public.public_cfg(),
      'notices', app.notices_json(null, array[g.id]));
  end if;

  -- ---------- client: the sessions window, once ----------
  create temp table if not exists _s on commit drop as select * from app.boot_sess(today, today) limit 0;
  truncate _s; insert into _s select * from app.boot_sess(today - back, today + fwd);
  -- clients per trainer and hour, for trainers with a max per hour (same rule as trainerLoad_)
  create temp table if not exists _load (trainer text, day date, h int, n int) on commit drop; truncate _load;
  insert into _load select s.trainer, s.day, split_part(s.hm, ':', 1)::int, sum(s.n) from _s s
   where app.trainer_cap(s.trainer) > 0 and s.tab in ('1:1', '1:2', '1:3') and s.status <> 'Cancelled' group by 1, 2, 3;

  for a in select * from public.clients x where x.id = any(ids) order by app.cnum(x.legacy_id), x.legacy_id loop
    create temp table if not exists _pk (pr public.packages, ph text, ord int) on commit drop; truncate _pk;
    insert into _pk select x, app.cl_phase(x, today), row_number() over (order by coalesce(app.ymd(x.start_date), ''), x.legacy_id)
      from public.packages x where x.client_id = a.id;
    create temp table if not exists _my (o jsonb, at bigint, att text, pkg text, tab text, day date, ord int, lid text, slot int) on commit drop; truncate _my;
    insert into _my select jsonb_build_object('id', s.legacy_id, 'ref', s.k || '|' || s.legacy_id, 'tab', s.tab, 'date', app.ymd(s.day), 'start', s.hm, 'end', s.hm_end, 'trainer', s.trainer,
        'i', sc.slot, 'pkg', p.legacy_id, 'att', coalesce(nullif(sc.att, ''), case when s.status = 'Cancelled' then 'Cancelled' else '' end), 'group', s.n, 'at', s.at_ms),
        s.at_ms, coalesce(nullif(sc.att, ''), case when s.status = 'Cancelled' then 'Cancelled' else '' end), p.legacy_id, s.tab, s.day, s.ord, s.legacy_id, sc.slot
      from _s s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id where p.client_id = a.id;
    create temp table if not exists _rq (q public.client_requests) on commit drop; truncate _rq;
    insert into _rq select q from public.client_requests q where q.client_id = a.id order by q.created_at desc, q.legacy_id desc limit 30;

    acc := jsonb_build_object('cid', a.legacy_id, 'name', btrim(a.name), 'first', split_part(btrim(a.name), ' ', 1),
      'full', exists (select 1 from _pk where ph in ('current', 'future')),
      'pkgs', (select coalesce(jsonb_agg(jsonb_build_object('id', (x.pr).legacy_id, 'label', regexp_replace(regexp_replace((x.pr).type_name, '\s*\(\$[^)]*\)', ''), '\s*\(Free\)', ' (free)', 'i'),
                 'kind', (x.pr).kind, 'total', (x.pr).passes, 'used', (x.pr).used, 'left', greatest(0, (x.pr).passes - (x.pr).used), 'start', app.ymd((x.pr).start_date), 'end', app.ymd(app.cl_end(x.pr)),
                 'status', btrim((x.pr).status), 'phase', x.ph, 'due', app.usd(greatest(0, (x.pr).price_cents - (x.pr).paid_cents)), 'price', app.usd((x.pr).price_cents)) order by x.ord), '[]') from _pk x),
      'upcoming', (select coalesce(jsonb_agg(o order by at, ord, lid, slot), '[]') from _my where att = '' and at > nowms - 3600000),
      'past', (select coalesce(jsonb_agg(o order by at desc, ord desc, lid desc, slot desc), '[]') from _my where day >= today - 30 and (att <> '' or at <= nowms - 3600000) and day <= today),
      'requests', (select coalesce(jsonb_agg(app.req_json(x.q) order by (x.q).created_at desc, (x.q).legacy_id desc), '[]') from _rq x),
      'goal', app.goal_json(a.id));

    if (acc->>'full')::boolean then
      -- freeze: once per package, current or future
      acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(case when e->>'phase' = 'past' then e else e || jsonb_build_object(
               'canFreeze', not exists (select 1 from _rq x where (x.q).type = 'Freeze' and (x.q).status <> 'Declined' and (x.q).package_id = (select id from public.packages where legacy_id = e->>'id')),
               'frozen', exists (select 1 from _rq x where (x.q).type = 'Freeze' and (x.q).status <> 'Declined' and (x.q).package_id = (select id from public.packages where legacy_id = e->>'id'))) end order by n), '[]')
             from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));
      acc := acc || jsonb_build_object('offers', (select coalesce(jsonb_object_agg(k, v - 'pkgId'), '{}') from jsonb_each(app.offers(a.id)) x(k, v)));
      acc := acc || jsonb_build_object('physio', jsonb_build_object(
        'show', exists (select 1 from _pk where ph in ('current', 'future') and (pr).kind in ('1:1', '1:2', '1:3')) and not exists (select 1 from _pk where ph in ('current', 'future') and (pr).kind = 'Prehab'),
        'recent', exists (select 1 from _my where tab in ('Physio', 'Prehab') and day >= today - 28 and att !~* 'cancel'),
        'pending', exists (select 1 from _rq x where (x.q).type = 'Physio visit' and (x.q).status = 'New')));
      -- open 1:3 spots: 48h+ ahead, free chair, trainer under their cap, passes left
      select (x.pr).* into p13 from _pk x where x.ph = 'current' and (x.pr).kind = '1:3' and (x.pr).passes - (x.pr).used > 0 order by x.ord limit 1;
      open := '[]';
      if p13.id is not null then
        can_join := greatest(0, p13.passes - p13.used) - (select count(*) from _my where att = '' and at > nowms - 3600000 and pkg = p13.legacy_id);
        acc := acc || jsonb_build_object('canJoin', can_join);
        if can_join > 0 then
          select coalesce(jsonb_agg(jsonb_build_object('id', s.legacy_id, 'date', app.ymd(s.day), 'start', s.hm, 'trainer', s.trainer, 'spots', seats - s.n, 'at', s.at_ms) order by s.at_ms, s.ord, s.legacy_id), '[]') into open
            from _s s
           where s.tab = '1:3' and s.status <> 'Cancelled' and s.n < seats and s.at_ms - nowms >= join_h * 3600000::bigint and s.day <= today + join_days
             and not exists (select 1 from public.session_clients sc join public.packages p on p.id = sc.package_id where sc.session_id = s.id and p.client_id = a.id)
             and not (app.trainer_cap(s.trainer) > 0 and coalesce((select n from _load l where l.trainer = s.trainer and l.day = s.day and l.h = split_part(s.hm, ':', 1)::int), 0) >= app.trainer_cap(s.trainer))
             and not coalesce(s.day > app.cl_end(p13), false);
        end if;
        -- the semi private calendar (Client.gs clGrid_)
        grid := '[]';
        for i in 1 .. join_days loop
          d := today + i; dow := extract(dow from d)::int;
          if dow = 0 or blocked ? app.ymd(d) or coalesce(d > app.cl_end(p13), false) then continue; end if;
          for h in select distinct x.hm from (
                select s.hm from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day < today and extract(dow from s.day) = dow group by s.hm having count(*) >= 2
                union select s.hm from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day = d) x order by 1 loop
            if exists (select 1 from _s s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id
                        where s.status <> 'Cancelled' and s.day = d and s.hm = h and p.client_id = a.id and sc.att !~* 'cancel') then continue; end if;
            v_o := null;
            select e into v_o from jsonb_array_elements(open) e where e->>'date' = app.ymd(d) and e->>'start' = h limit 1;
            if v_o is not null then grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', v_o->'trainer', 'spots', v_o->'spots', 'state', 'instant'); continue; end if;
            select count(*), bool_and(s.n >= seats), (array_agg(s.trainer order by s.ord, s.legacy_id))[1] into ss_n, ss_full, ss_tr
              from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day = d and s.hm = h;
            if ss_n > 0 and ss_full then grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', ss_tr, 'state', 'full'); continue; end if;
            grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', coalesce(ss_tr, ''), 'state', 'request');
          end loop;
        end loop;
        acc := acc || jsonb_build_object('grid', grid);
      end if;
      acc := acc || jsonb_build_object('open', open);
    end if;

    -- insured clients never see money owed (Insurance.gs insClientBoot_)
    select * into ins from public.insurance_clients where client_id = a.id;
    if ins.client_id is not null then
      acc := acc || jsonb_build_object('insurer', ins.insurer);
      acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(e || jsonb_build_object('due', 0, 'ins', ins.insurer) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));
    end if;
    select storage_path into photo from public.client_photos where client_id = a.id;
    if photo is not null then acc := acc || jsonb_build_object('photo', photo); end if;
    accounts := accounts || acc;
  end loop;

  return out || jsonb_build_object('accounts', accounts, 'slots', app.physio_slots(),
    'shop', (select coalesce(jsonb_agg(jsonb_build_object('n', i.item, 'price', app.usd(i.price_cents), 'left', greatest(0, i.stock)) order by i.created_at), '[]') from public.inventory i where i.price_cents > 0),
    'packages', app.shop_types(), 'brand', app.brand(), 'cfg', public.public_cfg(), 'notices', app.notices_json(null, ids));
end $$;

-- ---------------------------------------------------------------------
-- who may call: signed in people only (each function checks the role inside)
-- ---------------------------------------------------------------------
revoke execute on function public.api_app_boot(jsonb), public.api_app_history(jsonb), public.api_app_cl_boot(jsonb) from public, anon;
grant execute on function public.api_app_boot(jsonb), public.api_app_history(jsonb), public.api_app_cl_boot(jsonb) to authenticated;
revoke execute on function app.usd(bigint), app.ymd(date), app.stamp_dmy(timestamptz), app.ms(timestamptz), app.cnum(text), app.hour_of(text),
  app.boot_sess(date, date), app.boot_sess_json(date, date, text), app.cl_end(public.packages), app.cl_phase(public.packages, date), app.req_json(public.client_requests),
  app.goal_json(uuid), app.notices_json(text, uuid[]), app.shop_types(), app.brand(), app.trial_days(), app.intake_json(public.physio_intake), app.physio_slots()
  from public, anon, authenticated;
