-- 0022 Exception seat (21 Nov 2026): a 1:3 semi-private session can take a 4th client, only when staff (owner / Romy) press
-- "Exception +1" on that one session. Clients booking from their app still see 3 seats (the join list is unchanged).
alter table public.session_clients drop constraint if exists session_clients_slot_check;
alter table public.session_clients add constraint session_clients_slot_check check (slot between 0 and 3);
alter table public.sessions add column if not exists extra int not null default 0;
alter table public.sessions drop constraint if exists sessions_extra_check;
alter table public.sessions add constraint sessions_extra_check check (extra between 0 and 1);

-- booking: the free seat search counts the exception seat; the trainer's hourly limit is skipped when the client goes into a session opened with +1
CREATE OR REPLACE FUNCTION app.book_into(p_kind text, p_day date, p_time time without time zone, p_trainer text, p_pkg uuid, p_name text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare fixed text := app.fixed_trainer(p_kind); tr text; s record; free int; sid uuid; lid text; cid uuid; seats int;
begin
  if p_pkg is null then raise exception 'No package for this client: sell one first'; end if;
  perform app.kind_ok(p_kind, p_pkg);
  if (fixed is null or fixed = '') and not exists (
       select 1 from public.sessions x where x.kind = p_kind and x.day = p_day and x.start_time = p_time and x.status not ilike '%cancel%'
          and x.extra > 0 and x.trainer = app.trainer_name(p_trainer)
          and (select count(*) from public.session_clients where session_id = x.id) < app.slots_of(p_kind) + x.extra) then
    perform app.cap_check(p_trainer, p_day, p_time, 1);
  end if;
  tr := coalesce(nullif(fixed, ''), app.trainer_name(p_trainer));
  select client_id into cid from public.packages where id = p_pkg;
  perform pg_advisory_xact_lock(hashtext('slot:' || p_kind || p_day || p_time));
  for s in select * from public.sessions x where x.kind = p_kind and x.day = p_day and x.start_time = p_time and x.status not ilike '%cancel%'
             and (coalesce(fixed, '') <> '' or x.trainer = tr) order by x.legacy_id, x.id loop
    if exists (select 1 from public.session_clients where session_id = s.id and package_id = p_pkg) then
      return jsonb_build_object('id', s.legacy_id, 'session', s.id, 'joined', true);
    end if;
    if app.slots_of(p_kind) = 1 then continue; end if;
    seats := app.slots_of(p_kind) + coalesce(s.extra, 0);
    select min(g) into free from generate_series(0, seats - 1) g where not exists (select 1 from public.session_clients where session_id = s.id and slot = g);
    if free is not null then
      insert into public.session_clients (session_id, slot, package_id, client_id, name) values (s.id, free, p_pkg, cid, left(coalesce(p_name, ''), 80));
      return jsonb_build_object('id', s.legacy_id, 'session', s.id, 'joined', true);
    end if;
  end loop;
  lid := app.next_legacy(app.prefix_of(p_kind), 'public.sessions', 4);
  insert into public.sessions (legacy_id, kind, day, start_time, end_time, trainer, room, status, pay_source)
  values (lid, p_kind, p_day, p_time, p_time + interval '1 hour', tr, coalesce(app.setting(array['services', p_kind, 'room']) #>> '{}', ''), 'Scheduled',
          case when p_kind in ('Physio', 'Prehab') then 'Client Direct' else '' end)
  returning id into sid;
  insert into public.session_clients (session_id, slot, package_id, client_id, name) values (sid, 0, p_pkg, cid, left(coalesce(p_name, ''), 80));
  return jsonb_build_object('id', lid, 'session', sid, 'joined', false);
end $function$;

-- staff boot: each session says if it has the exception seat
CREATE OR REPLACE FUNCTION app.boot_sess_json(p_from date, p_to date, p_trainer text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.legacy_id, 'ref', s.k || '|' || s.legacy_id, 'tab', s.tab, 'date', app.ymd(s.day), 'start', s.hm, 'end', s.hm_end,
           'trainer', s.trainer, 'room', s.room, 'status', s.status, 'pay', s.pay, 'extra', ss.extra,
           'clients', (select jsonb_agg(jsonb_build_object('slot', sc.slot, 'pkg', p.legacy_id, 'name', sc.name, 'att', sc.att, 'flag', sc.pass, 'reminded', false, 'note', '', 'cid', c.legacy_id) order by sc.slot)
                         from public.session_clients sc join public.packages p on p.id = sc.package_id join public.clients c on c.id = p.client_id where sc.session_id = s.id))
         order by s.ord, ss.sheet_row nulls last, s.legacy_id), '[]'::jsonb)
    from app.boot_sess(p_from, p_to) s join public.sessions ss on ss.id = s.id
   where p_trainer is null or s.trainer = p_trainer
$function$;

-- action app_sess_extra { ref, id, on }: open (on=true) or close the exception seat on one 1:3 session (owner / front desk)
create or replace function public.api_app_sess_extra(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); s public.sessions := app.sess_find(p); want boolean := app.truthy(p->'on'); n int;
begin
  perform 1 from public.sessions where id = s.id for update;
  if s.kind <> '1:3' then raise exception 'Only a 1:3 semi-private session can take an extra client'; end if;
  if s.status ilike '%cancel%' then raise exception 'This session is cancelled'; end if;
  select count(*) into n from public.session_clients where session_id = s.id;
  if not want and n > 3 then raise exception 'There are 4 clients in it: take one out first'; end if;
  if not want and exists (select 1 from public.session_clients where session_id = s.id and slot = 3) then
    -- 3 or fewer clients but one sits in the 4th seat: move it to the free one
    update public.session_clients set slot = (select min(g) from generate_series(0, 2) g where not exists (select 1 from public.session_clients where session_id = s.id and slot = g))
     where session_id = s.id and slot = 3;
  end if;
  update public.sessions set extra = case when want then 1 else 0 end,
    note = app.append_note(note, case when want then 'Exception: 4th seat opened by ' else '4th seat closed by ' end || (me->>'name') || ' ' || to_char(now() at time zone 'Asia/Beirut', 'DD/MM HH24:MI'))
   where id = s.id;
  return jsonb_build_object('extra', case when want then 1 else 0 end, 'clients', n);
end $$;
revoke execute on function public.api_app_sess_extra(jsonb) from public, anon, authenticated;
insert into app.api_actions (action, fn, needs, enabled) values ('app_sess_extra', 'api_app_sess_extra', 'staff', true)
  on conflict (action) do update set fn = excluded.fn, needs = excluded.needs, enabled = true;
