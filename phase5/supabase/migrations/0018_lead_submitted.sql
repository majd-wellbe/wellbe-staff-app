-- 0018 Lead "submitted" like the sheet (applied live 2 Nov 2026).
-- Since 25 Oct the trial form writes the Submitted cell as a date only (30/10/2026); Apps Script returns the display value.
-- Supabase returned "30/10/2026 00:00:00". Now: date only when the stored time is exactly midnight.
-- Patches api_app_boot in place (it is long; only this expression changes). Safe to re-run.
do $$ declare d text := pg_get_functiondef('public.api_app_boot'::regproc);
  o text := $o$'submitted', to_char(l.submitted_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI:SS'))$o$;
  n text := $n$'submitted', to_char(l.submitted_at at time zone 'Asia/Beirut', case when (l.submitted_at at time zone 'Asia/Beirut')::time = '00:00' then 'DD/MM/YYYY' else 'DD/MM/YYYY HH24:MI:SS' end))$n$;
begin
  if position(n in d) > 0 then return; end if;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then raise exception '0018: expected exactly 1 match in api_app_boot'; end if;
  execute replace(d, o, n);
end $$;
