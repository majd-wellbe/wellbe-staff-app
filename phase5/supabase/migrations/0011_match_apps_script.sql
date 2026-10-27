-- =====================================================================
-- WELLBE on Supabase: 0011 match the Apps Script on kept sheet values
-- 0010 keeps the original statuses: a 1:1 / Physio / Prehab / Osteo / Madero session row can now say 'Early Cancel'
-- (and new marks write it, like the sheet), and packages keep empty status / empty Effective Expiry.
-- Where a function compared the raw session status with 'Cancelled', it now uses the same rule as App.gs appSessObj_:
--   cancelled = row status is 'Cancelled' OR every client in it has a cancel mark (Early / Late Cancel).
-- Changes (each copies the Apps Script line named):
--  app.sess_cancelled (new)  App.gs 458-459 appSessObj_: allCancel / s.status = 'Cancelled'
--  app.trainer_sees          App.gs 277 appTrainerSees_: s.status !== 'Cancelled' (derived status)
--  public.api_app_notes      App.gs 277 (via appNotes_ line 792): same rule
--  app.ops_physio_free       Client.gs 380 clSlots_: s.status === 'Cancelled' (derived status)
--  app.trained_on            Levels.gs 88 / RunGame.gs 419 (game XP and boost): s.status === 'Cancelled' (derived status)
--  public.client_join        Client.gs 459: end = Effective || Extended || Default expiry (was Effective || Default);
--                            Client.gs 466: booked sessions skip s.status === 'Cancelled' (derived status)
--  app.set_att               App.gs 518 appSetAtt_ (single client tabs): status = 'Done' for Present, else the mark itself,
--                            so an Early Cancel now writes 'Early Cancel' (was 'Cancelled')
-- Already the same, not changed: package phase (App.gs 300 / Client.gs 220, 723), freeze end (Client.gs 612),
-- package dates (App.gs 640), offers start (Client.gs 328), default Present (App.gs 989), boot session status (App.gs 458).
-- Safe to run again. Run `select app.api_sync();` after it.
-- =====================================================================

create or replace function app.sess_cancelled(p_status text, p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_status = 'Cancelled'
      or coalesce((select bool_and(sc.att ~ 'Cancel') from public.session_clients sc where sc.session_id = p_session), false)
$$;

CREATE OR REPLACE FUNCTION app.trainer_sees(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.sessions s join public.session_clients sc on sc.session_id = s.id
     where sc.client_id = cid and s.trainer = app.my_trainer() and not app.sess_cancelled(s.status, s.id)
       and s.day between app_today() - app.setting_int('{windows,trainerSee}', 60) and app_today() + app.setting_int('{windows,ahead}', 35))
$function$;

CREATE OR REPLACE FUNCTION public.api_app_notes(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cl uuid := app.ops_cid(p->>'cid'); tr_ok boolean;
begin
  if me->>'role' = 'trainer' then
    select exists (select 1 from public.sessions s join public.session_clients sc on sc.session_id = s.id
                    where sc.client_id = cl and s.trainer = me->>'trainer' and not app.sess_cancelled(s.status, s.id)
                      and s.day between app_today() - app.setting_int('{windows,trainerSee}', 60) and app_today() + app.setting_int('{windows,ahead}', 35)) into tr_ok;
    if not tr_ok then raise exception 'This client is not one of yours'; end if;
  end if;
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  insert into public.client_notes (client_id, always_show, program, updated_by, updated_at)
  values (cl, left(coalesce(p->>'always', ''), 500), left(coalesce(p->>'program', ''), 2000), me->>'name', now())
  on conflict (client_id) do update set always_show = excluded.always_show, program = excluded.program, updated_by = excluded.updated_by, updated_at = now();
  if coalesce(p->>'note', '') <> '' then
    insert into public.session_notes (day, session_id, client_id, by_staff, note)
    values (coalesce(app.ops_ymd(left(coalesce(p->>'date', ''), 10)), app_today()), app.ops_sess(p->>'sid'), cl, coalesce(nullif(me->>'trainer', ''), me->>'name'), left(p->>'note', 1000));
  end if;
  return '{}';
end $function$;

CREATE OR REPLACE FUNCTION app.ops_physio_free(p_day date, p_time text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare today date := app_today(); days int := app.setting_int('{windows,physioDays}', 14); nh int := app.setting_int('{windows,physioNoticeH}', 12);
  until date := today + days + 1; a timestamptz; who text := app.fixed_trainer('Physio');
begin
  if p_day is null or p_time !~ '^\d{2}:\d{2}$' or p_day < today or p_day > today + days then return false; end if;
  if not coalesce(app.setting(array['hours', 'physio', extract(dow from p_day)::int::text]) ? p_time, false) then return false; end if;
  if coalesce(app.setting('{hours,blocked}') ? p_day::text, false) then return false; end if;
  a := app.at(p_day, p_time::time);
  if a - now() < make_interval(hours => nh) then return false; end if;
  if exists (select 1 from public.sessions s where s.trainer = who and not app.sess_cancelled(s.status, s.id) and s.day between today and until
               and app.at(s.day, s.start_time) < a + interval '1 hour' and app.at(s.day, s.start_time) + interval '1 hour' > a) then return false; end if;
  if exists (select 1 from public.client_requests q where q.type = 'Physio visit' and q.status = 'New' and q.slot ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$'
               and app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time) < a + interval '1 hour'
               and app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time) + interval '1 hour' > a) then return false; end if;
  if exists (select 1 from public.calendar_busy b where not b.all_day and b.start_at < a + interval '1 hour' and b.end_at > a) then return false; end if;   -- the physio's Google Calendar (synced by Supabase.gs)
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.client_join(p_client uuid, p_day date, p_time time without time zone, p_trainer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me jsonb := app.need_client(p_client); tr text := app.trainer_name(p_trainer); min_h int := app.setting_int('{windows,joinMinH}', 48);
  join_days int := app.setting_int('{windows,joinDays}', 10); ahead int := app.setting_int('{windows,ahead}', 35); desk text := app.desk_name();
  pick record; res jsonb;
begin
  if app.at(p_day, p_time) - now() < make_interval(hours => min_h) then raise exception 'Less than % hours away: message % to add you.', min_h, desk; end if;
  if not exists (select 1 from public.sessions s where s.kind = '1:3' and s.day = p_day and s.start_time = p_time and s.trainer = tr
                   and s.status not ilike '%cancel%' and (select count(*) from public.session_clients where session_id = s.id) < 3) then
    raise exception 'This spot was just taken. Pick another one.';
  end if;
  -- the 1:3 package that covers that day with a pass left that is not already booked
  if not exists (select 1 from public.packages p where p.client_id = p_client and p.status = 'Active' and app.kind_of(p.type_name) = '1:3'
                   and not (p.start_date > p_day) and not (coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date) is not null and p_day > coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date))
                   and p.passes - p.used > 0) then
    raise exception 'No group sessions left on your package. Message % to renew.', desk;
  end if;
  select p.id, (select name from public.clients where id = p.client_id) as name into pick
    from public.packages p
   where p.client_id = p_client and p.status = 'Active' and app.kind_of(p.type_name) = '1:3'
     and not (p.start_date > p_day) and not (coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date) is not null and p_day > coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date))
     and p.passes - p.used - (select count(*) from public.session_clients sc join public.sessions s on s.id = sc.session_id
                               where sc.package_id = p.id and sc.att = '' and not app.sess_cancelled(s.status, s.id)
                                 and s.day between app_today() - 1 and app_today() + greatest(ahead, join_days) + 1
                                 and app.at(s.day, s.start_time) > now() - interval '1 hour') > 0
   order by p.legacy_id limit 1;
  if pick.id is null then raise exception 'Every session left on your package is already booked. Cancel one, or message % to renew.', desk; end if;
  res := app.book_into('1:3', p_day, p_time, tr, pick.id, pick.name);
  perform app.client_log(p_client, pick.name, 'Joined a spot', '1:3 with ' || tr, p_day || ' ' || to_char(p_time, 'HH24:MI') || ' · ' || (res->>'id'), pick.id, 'New', '{}');
  return jsonb_build_object('id', res->>'id', 'session', res->'session');
end $function$;

CREATE OR REPLACE FUNCTION app.set_att(p_session uuid, p_slot integer, p_att text, p_by text, p_reason text DEFAULT ''::text, p_all boolean DEFAULT false, p_ping boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.sessions; c public.session_clients; flag text; deducts jsonb := '{"Present":1,"Done":1,"Late Cancel":1,"No Show":1}';
begin
  if p_att not in ('', 'Present', 'Late Cancel', 'No Show', 'Early Cancel') then raise exception 'Unknown attendance'; end if;
  select * into s from public.sessions where id = p_session for update;
  select * into c from public.session_clients where session_id = p_session and slot = p_slot;
  if c.package_id is null then raise exception 'No client in that spot'; end if;
  if s.kind = '1:2' and p_att = 'Early Cancel' then perform app.cancel_pair(s.id, p_slot, p_by, p_reason, p_all, p_ping); return c.package_id; end if;
  flag := case when p_att = '' then '' when deducts ? p_att then 'Y' else 'N' end;
  update public.session_clients set att = p_att, pass = flag where session_id = s.id and slot = p_slot;
  if s.kind = '1:2' and (p_att in ('Late Cancel', 'No Show')) and coalesce(p_reason, '') = '' then
    update public.sessions set note = app.append_note(note, btrim(c.name) || ': ' || p_att || ' via app, ' || p_by) where id = s.id;
  end if;
  if s.kind = '1:3' then        -- per client attendance: the row becomes Done once someone is marked
    if p_att <> '' and s.status in ('Scheduled', '') then update public.sessions set status = 'Done' where id = s.id; end if;
  elsif s.kind = '1:2' then     -- never Done before someone is Present (or both are marked)
    update public.sessions set status = app.session_status(s.id) where id = s.id;
  else                          -- one client: the status carries the attendance
    update public.sessions set status = case p_att when '' then 'Scheduled' when 'Present' then 'Done' else p_att end where id = s.id;
  end if;
  if p_att = 'Early Cancel' or coalesce(p_reason, '') <> '' then
    update public.sessions set note = app.append_note(note, c.name || ': ' || p_att || case when coalesce(p_reason, '') <> '' then ' (exception: ' || p_reason || ')' else '' end || ' via app, ' || p_by) where id = s.id;
  end if;
  return c.package_id;
end $function$;

CREATE OR REPLACE FUNCTION app.trained_on(p_client uuid, d1 date, d2 date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.session_clients sc join public.sessions s on s.id = sc.session_id
                  where sc.client_id = p_client and s.day between d1 and d2 and not app.sess_cancelled(s.status, s.id) and sc.att ~* 'present|done')
$function$;
