-- 0021: an expense can be paid in parts (owner rule, 18 Nov 2026).
--   Each expense keeps "paid so far". Every change of that number is kept as a payment with its date.
--   The Numbers page counts an expense by what was paid, in the month it was paid (the screens add the payments up).
--   Default: an expense is fully paid on its own date (all expenses before this, recurring ones, the Meta Ads task).
-- No new actions: app_expense also takes { paid } when adding, and { id, paid } to change "paid so far".

alter table public.expenses add column if not exists paid_cents integer;

create table if not exists public.expense_payments (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  day date not null,
  amount_cents integer not null,
  by_who text,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists expense_payments_expense on public.expense_payments (expense_id);
alter table public.expense_payments enable row level security;
drop policy if exists expp_desk on public.expense_payments;
create policy expp_desk on public.expense_payments for all using (app.is_desk()) with check (app.is_desk());

-- every expense that exists today: fully paid on its own date
insert into public.expense_payments (expense_id, day, amount_cents, by_who)
select e.id, e.day, e.amount_cents, e.by_who from public.expenses e
where e.paid_cents is null and e.amount_cents > 0 and not exists (select 1 from public.expense_payments y where y.expense_id = e.id);
update public.expenses set paid_cents = amount_cents where paid_cents is null;

-- any new expense, whoever adds it: paid in full on its date unless "paid so far" is given
create or replace function app.expense_paid_default() returns trigger language plpgsql as $$
begin
  new.paid_cents := least(greatest(coalesce(new.paid_cents, new.amount_cents), 0), new.amount_cents);
  return new;
end $$;
create or replace function app.expense_paid_first() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.paid_cents > 0 then
    insert into public.expense_payments (expense_id, day, amount_cents, by_who) values (new.id, new.day, new.paid_cents, new.by_who);
  end if;
  return null;
end $$;
drop trigger if exists expense_paid_default on public.expenses;
create trigger expense_paid_default before insert on public.expenses for each row execute function app.expense_paid_default();
drop trigger if exists expense_paid_first on public.expenses;
create trigger expense_paid_first after insert on public.expenses for each row execute function app.expense_paid_first();

-- the payments of one expense, oldest first: [{ d, amt }]
create or replace function app.exp_pays(p_expense uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('d', app.ymd(y.day), 'amt', app.usd(y.amount_cents)) order by y.day, y.created_at), '[]'::jsonb)
  from public.expense_payments y where y.expense_id = p_expense
$$;
revoke all on function app.exp_pays(uuid) from public, anon, authenticated;

-- app_expense: add { d, what, cat, amt, paid?, recId? }  or change "paid so far" { id, paid }
create or replace function public.api_app_expense(p jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me jsonb := app.need(array['owner', 'assistant']); amt numeric := app.ops_num(p->'amt'); lid text; rec uuid;
  e public.expenses; np int; diff int; y public.expense_payments; today date := app_today(); paid int;
begin
  -- change "paid so far" on an expense
  if coalesce(p->>'id', '') <> '' then
    select * into e from public.expenses where legacy_id = upper(btrim(p->>'id')) for update;
    if e.id is null then raise exception 'Expense % not found', p->>'id'; end if;
    if app.ops_num(p->'paid') is null then raise exception 'Paid amount missing'; end if;
    np := round(app.ops_num(p->'paid') * 100);
    if np < 0 then raise exception 'Paid amount missing'; end if;
    if np > e.amount_cents then raise exception 'Paid so far can''t be more than the expense ($%)', app.jsnum(e.amount_cents / 100.0); end if;
    diff := np - coalesce(e.paid_cents, 0);
    if diff > 0 then
      insert into public.expense_payments (expense_id, day, amount_cents, by_who) values (e.id, today, diff, me->>'name');
    elsif diff < 0 then
      -- a correction downwards: take it off the latest payments first
      diff := -diff;
      for y in select * from public.expense_payments where expense_id = e.id order by day desc, created_at desc loop
        exit when diff <= 0;
        if y.amount_cents <= diff then delete from public.expense_payments where id = y.id; diff := diff - y.amount_cents;
        else update public.expense_payments set amount_cents = amount_cents - diff where id = y.id; diff := 0; end if;
      end loop;
    end if;
    update public.expenses set paid_cents = np where id = e.id;
    return jsonb_build_object('id', e.legacy_id, 'paid', app.usd(np), 'pays', app.exp_pays(e.id));
  end if;

  if not coalesce(amt > 0, false) or coalesce(p->>'what', '') = '' then raise exception 'What and amount needed'; end if;
  if app.ops_ymd(p->>'d') is null then raise exception 'Pick a valid day'; end if;
  if p ? 'paid' and jsonb_typeof(p->'paid') <> 'null' and coalesce(p->>'paid', '') <> '' then
    paid := round(app.ops_num(p->'paid') * 100);
    if paid is null or paid < 0 then raise exception 'Paid amount missing'; end if;
    if paid > round(amt * 100) then raise exception 'Paid so far can''t be more than the expense'; end if;
  end if;
  lid := app.next_legacy('EXP', 'public.expenses', 6);
  select id into rec from public.recurring_expenses where legacy_id = nullif(p->>'recId', '');
  insert into public.expenses (legacy_id, day, what, category, amount_cents, paid_cents, by_who, recurring_id)
  values (lid, (p->>'d')::date, app.ops_clean(p->>'what', 120), app.ops_clean(p->>'cat', 40), round(amt * 100), paid, me->>'name', rec);
  if rec is not null then update public.recurring_expenses set last_logged = (p->>'d')::date where id = rec; end if;
  return jsonb_build_object('id', lid);
end $$;

-- staff boot: each expense also carries id, paid and its payments; the desk also sees older expenses that are not fully paid or were paid on lately
do $$
declare d text; n int;
begin
  select pg_get_functiondef('public.api_app_boot(jsonb)'::regprocedure) into d;
  if position('app.exp_pays' in d) = 0 then
    n := (length(d) - length(replace(d, $a$'amt', app.usd(e.amount_cents)) order by e.created_at)$a$, ''))) / length($a$'amt', app.usd(e.amount_cents)) order by e.created_at)$a$);
    if n <> 1 then raise exception '0021: expense line found % times in api_app_boot', n; end if;
    d := replace(d, $a$'amt', app.usd(e.amount_cents)) order by e.created_at)$a$,
      $a$'amt', app.usd(e.amount_cents), 'id', e.legacy_id, 'paid', app.usd(e.paid_cents), 'pays', app.exp_pays(e.id)) order by e.created_at)$a$);
    n := (length(d) - length(replace(d, $a$from public.expenses e where v_role = 'owner' or e.day >= month_start - 31)$a$, ''))) / length($a$from public.expenses e where v_role = 'owner' or e.day >= month_start - 31)$a$);
    if n <> 1 then raise exception '0021: expense filter found % times in api_app_boot', n; end if;
    d := replace(d, $a$from public.expenses e where v_role = 'owner' or e.day >= month_start - 31)$a$,
      $a$from public.expenses e where v_role = 'owner' or e.day >= month_start - 31 or e.paid_cents < e.amount_cents
                       or exists (select 1 from public.expense_payments y where y.expense_id = e.id and y.day >= month_start - 31))$a$);
    execute d;
  end if;
end $$;

select app.api_sync();
