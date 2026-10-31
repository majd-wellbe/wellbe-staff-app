-- app_pkg_delete { pkg, why }: owner and Romy (30 Oct 2026). Never erases history: the package is marked Cancelled
-- (hidden from booking, freeze and late payments) with a note. Refused while sessions from today on are booked on it.
create or replace function public.api_app_pkg_delete(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); k public.packages; n int; d0 date;
begin
  select * into k from public.packages where id = app.ops_pkg(p->>'pkg') for update;
  if k.id is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  if k.status ilike '%cancel%' then return jsonb_build_object('already', true); end if;
  select count(*), min(s.day) into n, d0 from public.session_clients sc join public.sessions s on s.id = sc.session_id
   where sc.package_id = k.id and s.day >= app_today() and s.status not in ('Cancelled', 'Early Cancel') and sc.att <> 'Early Cancel';
  if n > 0 then
    raise exception '% still booked on this package (%). Move or cancel them first.',
      case when n = 1 then '1 session is' else n || ' sessions are' end, app.ymd(d0) || case when n > 1 then ' and more' else '' end;
  end if;
  update public.packages set status = 'Cancelled',
    note = app.append_note(note, 'Deleted ' || app.ddmm() || ' (' || (me->>'name') || ')' || case when coalesce(p->>'why', '') <> '' then ': ' || left(p->>'why', 120) else '' end)
   where id = k.id;
  return jsonb_build_object('deleted', p->>'pkg');
end $$;
revoke execute on function public.api_app_pkg_delete(jsonb) from public, anon;
grant execute on function public.api_app_pkg_delete(jsonb) to authenticated;
insert into app.api_actions (action, fn, needs, enabled) values ('app_pkg_delete', 'api_app_pkg_delete', 'staff', true)
  on conflict (action) do update set fn = excluded.fn, needs = excluded.needs, enabled = true;
