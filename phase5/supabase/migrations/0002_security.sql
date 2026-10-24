-- =====================================================================
-- WELLBE on Supabase: 0002 who sees what (Row Level Security)
--  owner      everything
--  assistant  all day to day data (clients, packages, sessions, leads, requests, money in and out),
--             but not the pay rules of the staff (payroll config)
--  trainer    only clients they trained in the last windows.trainerSee days or have booked
--             (incl. their medical notes); no prices, payments or pay of others
--  client     only their own rows, and their children's (parent email on the child row)
--  guest      only their own guest row and game / nutrition rows
-- Every table has RLS on. Anything not allowed below is denied.
-- Money and booking changes go through the functions in 0003 (security definer, role checked inside).
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles: one per Supabase auth user
-- ---------------------------------------------------------------------
create table public.profiles (
  user_id   uuid primary key,                                 -- auth.users.id
  email     text not null,
  role      text not null check (role in ('owner', 'assistant', 'trainer', 'client', 'guest')),
  staff_id  text references public.staff(id),
  created_at timestamptz not null default now(),
  check ((role in ('owner', 'assistant', 'trainer')) = (staff_id is not null))
);

-- ---------------------------------------------------------------------
-- helpers (security definer: they read past RLS, return only facts about the caller)
-- ---------------------------------------------------------------------
create or replace function app.setting(path text[]) returns jsonb language sql stable security definer set search_path = public as $$
  select s.value #> path[2:] from public.settings s where s.key = path[1]
$$;
create or replace function app.setting_int(path text[], fb int) returns int language sql stable as $$
  select coalesce((app.setting(path))::text::int, fb)
$$;
create or replace function app_today() returns date language sql stable as $$
  select (now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date
$$;
create or replace function app.me() returns public.profiles language sql stable security definer set search_path = public as $$
  select p from public.profiles p where p.user_id = auth.uid()
$$;
create or replace function app.my_role() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where user_id = auth.uid()), 'anon')
$$;
create or replace function app.my_staff() returns text language sql stable security definer set search_path = public as $$
  select staff_id from public.profiles where user_id = auth.uid()
$$;
create or replace function app.my_trainer() returns text language sql stable security definer set search_path = public as $$
  select s.trainer from public.profiles p join public.staff s on s.id = p.staff_id where p.user_id = auth.uid() and s.active
$$;
create or replace function app.is_owner() returns boolean language sql stable as $$ select app.my_role() = 'owner' $$;
create or replace function app.is_desk() returns boolean language sql stable as $$ select app.my_role() in ('owner', 'assistant') $$;
create or replace function app.is_staff() returns boolean language sql stable as $$ select app.my_role() in ('owner', 'assistant', 'trainer') $$;

-- client rows this login may act for: their own email, or a child whose parent email is theirs
create or replace function app.my_clients() returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.clients c, public.profiles p
   where p.user_id = auth.uid() and p.role in ('client', 'guest') and c.deleted_at is null
     and (lower(c.email) = lower(p.email) or lower(c.parent_email) = lower(p.email))
$$;
create or replace function app.is_mine(cid uuid) returns boolean language sql stable as $$
  select cid in (select app.my_clients())
$$;

-- trainer sees a client: trained them in the last trainerSee days, or booked with them up to `ahead` days (App.gs appTrainerSees_)
create or replace function app.trainer_sees(cid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions s join public.session_clients sc on sc.session_id = s.id
     where sc.client_id = cid and s.trainer = app.my_trainer() and s.status <> 'Cancelled'
       and s.day between app_today() - app.setting_int('{windows,trainerSee}', 60) and app_today() + app.setting_int('{windows,ahead}', 35))
$$;
-- the one rule most tables use
create or replace function app.can_see_client(cid uuid) returns boolean language sql stable as $$
  select case app.my_role()
    when 'owner' then true when 'assistant' then true
    when 'trainer' then app.trainer_sees(cid)
    when 'client' then app.is_mine(cid) when 'guest' then app.is_mine(cid)
    else false end
$$;
create or replace function app.staff_sees_client(cid uuid) returns boolean language sql stable as $$
  select app.is_desk() or (app.my_role() = 'trainer' and app.trainer_sees(cid))
$$;

-- ---------------------------------------------------------------------
-- RLS on, everywhere
-- ---------------------------------------------------------------------
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

-- the API roles see nothing until a policy says so; column grants hide money and pay
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant select on all tables in schema public to authenticated;     -- rows are still filtered by the policies below
revoke select on public.staff from authenticated;
grant select (id, name, name_ar, role, trainer, train, cap, active) on public.staff to authenticated;   -- no pay, email, phone
revoke select on public.packages from authenticated;
grant select (id, legacy_id, client_id, type_name, kind, passes, used, start_date, expiry_date, extended_expiry, effective_expiry, status, created_at)
  on public.packages to authenticated;                            -- prices and payments only through package_money below
revoke select on public.outbox, public.audit_log from authenticated;
revoke all on public.packages_v from authenticated;

-- ---------------------------------------------------------------------
-- policies
-- ---------------------------------------------------------------------
-- settings
create policy staff_read on public.staff for select using (app.my_role() <> 'anon' and (active or app.is_owner()));
create policy staff_write on public.staff for all using (app.is_owner()) with check (app.is_owner());
create policy types_read on public.package_types for select using (app.my_role() <> 'anon');
create policy types_write on public.package_types for all using (app.is_owner()) with check (app.is_owner());
create policy settings_read on public.settings for select using (
  app.is_staff() and (key <> 'pay' or app.is_owner())
  or (app.my_role() in ('client', 'guest') and key not in ('pay', 'lists', 'insurance', 'trial')));
create policy settings_write on public.settings for all using (app.is_owner()) with check (app.is_owner());

-- profiles
create policy profiles_self on public.profiles for select using (user_id = auth.uid() or app.is_owner());
create policy profiles_owner on public.profiles for all using (app.is_owner()) with check (app.is_owner());

-- clients and everything that belongs to one client
create policy clients_read on public.clients for select using (app.can_see_client(id));
create policy clients_desk on public.clients for all using (app.is_desk()) with check (app.is_desk());

-- staff only (medical and coaching notes), trainers for their clients
create policy notes_staff on public.client_notes for select using (app.staff_sees_client(client_id));
create policy notes_write on public.client_notes for all using (app.staff_sees_client(client_id)) with check (app.staff_sees_client(client_id));
create policy snotes_staff on public.session_notes for select using (app.staff_sees_client(client_id));
create policy snotes_write on public.session_notes for insert with check (app.staff_sees_client(client_id));
create policy intake_staff on public.physio_intake for select using (app.staff_sees_client(client_id));
create policy intake_write on public.physio_intake for insert with check (app.staff_sees_client(client_id));
create policy files_staff on public.client_files for select using (app.staff_sees_client(client_id));
create policy files_write on public.client_files for insert with check (app.staff_sees_client(client_id));

-- client and their coaches
create policy goals_read on public.client_goals for select using (app.can_see_client(client_id));
create policy goals_write on public.client_goals for all using (app.can_see_client(client_id)) with check (app.can_see_client(client_id));
create policy photos_read on public.client_photos for select using (app.can_see_client(client_id));
create policy photos_write on public.client_photos for all using (app.is_mine(client_id) or app.is_desk()) with check (app.is_mine(client_id) or app.is_desk());
create policy body_read on public.client_body for select using (app.can_see_client(client_id));
create policy body_write on public.client_body for insert with check (app.can_see_client(client_id));
create policy prog_read on public.wo_programs for select using (app.can_see_client(client_id));
create policy prog_write on public.wo_programs for all using (app.staff_sees_client(client_id)) with check (app.staff_sees_client(client_id));
create policy dec_read on public.wo_decisions for select using (app.can_see_client(client_id));
create policy dec_write on public.wo_decisions for all using (app.staff_sees_client(client_id)) with check (app.staff_sees_client(client_id));
create policy logs_read on public.wo_logs for select using (app.can_see_client(client_id));
create policy logs_write on public.wo_logs for insert with check (app.can_see_client(client_id));
create policy ex_read on public.wo_exercises for select using (app.is_staff());
create policy ex_write on public.wo_exercises for insert with check (app.is_staff());
create policy nin_read on public.nutrition_intake for select using (app.can_see_client(client_id));
create policy nin_write on public.nutrition_intake for all using (app.is_mine(client_id) or app.is_desk()) with check (app.is_mine(client_id) or app.is_desk());
-- clients only see APPROVED plans (coach approval rule); staff see all of their clients' plans
create policy nplan_read on public.nutrition_plans for select using (app.staff_sees_client(client_id) or (app.is_mine(client_id) and status = 'Approved'));
create policy nplan_write on public.nutrition_plans for update using (app.staff_sees_client(client_id)) with check (app.staff_sees_client(client_id));
create policy nweigh_read on public.nutrition_weighins for select using (app.can_see_client(client_id));
create policy nweigh_write on public.nutrition_weighins for insert with check (app.can_see_client(client_id));
create policy streak_read on public.streaks for select using (app.can_see_client(client_id));

-- packages (rows; money columns are not granted, see package_money)
create policy pkg_read on public.packages for select using (app.can_see_client(client_id));
create policy pkg_desk on public.packages for all using (app.is_desk()) with check (app.is_desk());
-- prices and payments: desk and the client themselves, never trainers
create or replace view public.package_money with (security_barrier = true) as
  select p.id, p.legacy_id, p.client_id, p.price_cents, p.paid_cents, greatest(0, p.price_cents - p.paid_cents) as due_cents,
         p.discount_pct, p.new_client, p.note
    from public.packages p
   where app.is_desk() or app.is_mine(p.client_id);
grant select on public.package_money to authenticated;

-- sessions: desk all; trainer their own sessions and sessions of clients they see; client sessions they are in
create or replace function app.in_my_session(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.session_clients sc where sc.session_id = sid and sc.client_id in (select app.my_clients()))
$$;
create or replace function app.my_trainer_session(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app.my_role() = 'trainer' and exists (select 1 from public.sessions s where s.id = sid and s.trainer = app.my_trainer())
$$;
grant execute on function app.in_my_session(uuid), app.my_trainer_session(uuid) to authenticated;
create policy sess_read on public.sessions for select using (
  app.is_desk() or (app.my_role() = 'trainer' and trainer = app.my_trainer()) or app.in_my_session(id));
create policy sess_desk on public.sessions for all using (app.is_desk()) with check (app.is_desk());
create policy sc_read on public.session_clients for select using (
  app.is_desk() or app.my_trainer_session(session_id) or app.is_mine(client_id));
create policy sc_desk on public.session_clients for all using (app.is_desk()) with check (app.is_desk());

-- leads, requests, notices
create policy leads_desk on public.leads for all using (app.is_desk()) with check (app.is_desk());
create policy req_read on public.client_requests for select using (app.is_desk() or app.is_mine(client_id));
create policy req_desk on public.client_requests for update using (app.is_desk()) with check (app.is_desk());
create policy notice_read on public.notices for select using (
  app.is_owner() or (for_staff is not null and for_staff = app.my_staff()) or (for_client is not null and app.is_mine(for_client)));
create policy notice_mark on public.notices for update using ((for_staff = app.my_staff()) or app.is_mine(for_client))
  with check ((for_staff = app.my_staff()) or app.is_mine(for_client));

-- game: own rows; desk can look; leaderboards come from app.leaderboard() in 0003
create policy gp_read on public.game_players for select using (app.is_mine(client_id) or app.is_desk());
create policy gr_read on public.game_runs for select using (app.is_mine(client_id) or app.is_desk());
create policy cl_read on public.coin_ledger for select using (app.is_mine(client_id) or app.is_desk());
create policy crl_read on public.credit_ledger for select using (app.is_mine(client_id) or app.is_desk());

-- money in and out
create policy wallet_read on public.wallet_ledger for select using (app.is_mine(client_id) or app.is_desk());
create policy wallet_desk on public.wallet_ledger for insert with check (app.is_desk());
create policy insc_desk on public.insurance_clients for all using (app.is_desk()) with check (app.is_desk());
create policy insk_desk on public.insurance_claims for all using (app.is_desk()) with check (app.is_desk());
create policy exp_desk on public.expenses for all using (app.is_desk()) with check (app.is_desk());
create policy rexp_desk on public.recurring_expenses for all using (app.is_desk()) with check (app.is_desk());
create policy inv_read on public.inventory for select using (app.my_role() <> 'anon');
create policy inv_desk on public.inventory for all using (app.is_desk()) with check (app.is_desk());
create policy pos_read on public.pos_sales for select using (app.is_desk() or app.is_mine(client_id));
create policy pos_desk on public.pos_sales for insert with check (app.is_desk());

-- accounts
create policy del_desk on public.deletion_requests for all using (app.is_desk()) with check (app.is_desk());
create policy audit_owner on public.audit_log for select using (app.is_owner());
create policy outbox_none on public.outbox for select using (false);

-- the owner can read staff pay; everyone else only their own (functions in 0003 use this)
create or replace function app.staff_pay(sid text) returns jsonb language sql stable security definer set search_path = public as $$
  select case when app.is_owner() or sid = app.my_staff() then (select pay from public.staff where id = sid) end
$$;
