-- 0016 Session order like the sheet (applied live 30 Oct 2026).
-- Apps Script returns sessions in tab order, then sheet row order. Old tabs have rows out of ID order,
-- so app_history (owner Numbers, older sessions) differed. Order by sessions.sheet_row, then legacy_id.
CREATE OR REPLACE FUNCTION app.boot_sess_json(p_from date, p_to date, p_trainer text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.legacy_id, 'ref', s.k || '|' || s.legacy_id, 'tab', s.tab, 'date', app.ymd(s.day), 'start', s.hm, 'end', s.hm_end,
           'trainer', s.trainer, 'room', s.room, 'status', s.status, 'pay', s.pay,
           'clients', (select jsonb_agg(jsonb_build_object('slot', sc.slot, 'pkg', p.legacy_id, 'name', sc.name, 'att', sc.att, 'flag', sc.pass, 'reminded', false, 'note', '', 'cid', c.legacy_id) order by sc.slot)
                         from public.session_clients sc join public.packages p on p.id = sc.package_id join public.clients c on c.id = p.client_id where sc.session_id = s.id))
         order by s.ord, ss.sheet_row nulls last, s.legacy_id), '[]'::jsonb)
    from app.boot_sess(p_from, p_to) s join public.sessions ss on ss.id = s.id
   where p_trainer is null or s.trainer = p_trainer
$function$;
