-- 0017 Recurring expenses log themselves (same rule as Apps Script recAutoLog, 31 Oct 2026).
-- Daily job: every active recurring expense that is due (rent on the 1st) is logged as an expense by "Auto",
-- then last_logged moves. Catches up missed periods (max 24 per item per run), never past end_day.
create or replace function app.job_rec_autolog() returns int
language plpgsql security definer set search_path to 'public' as $$
declare r public.recurring_expenses; n int; due date; guard int; added int := 0; today date := app_today();
begin
  for r in select * from public.recurring_expenses where active and first_day is not null order by sheet_row nulls last, legacy_id loop
    n := case r.every when 'Monthly' then 1 when 'Every 3 months' then 3 when 'Every 6 months' then 6 when 'Yearly' then 12 end;
    continue when n is null;
    due := case when r.last_logged is null then r.first_day else (r.last_logged + make_interval(months => n))::date end;
    guard := 0;
    while due <= today and (r.end_day is null or due <= r.end_day) and guard < 24 loop
      insert into public.expenses (legacy_id, day, what, category, amount_cents, by_who, recurring_id)
      values (app.next_legacy('EXP', 'public.expenses', 6), due, r.what, r.category, r.amount_cents, 'Auto', r.id);
      update public.recurring_expenses set last_logged = due where id = r.id;
      added := added + 1; guard := guard + 1;
      due := (due + make_interval(months => n))::date;
    end loop;
  end loop;
  return added;
end $$;
revoke all on function app.job_rec_autolog() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'wellbe-rec-autolog';
-- 04:05 UTC = 06:05 Beirut in winter (07:05 in summer); the job is idempotent, the hour does not matter.
select cron.schedule('wellbe-rec-autolog', '5 4 * * *', 'select app.job_rec_autolog()');
