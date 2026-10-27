-- =====================================================================
-- WELLBE on Supabase: 0012 nutrition v2 (owner's approved rules, 27 Oct 2026)
--
--  * Questionnaire v2 (server defined, EN + Lebanese Arabic): sport goal, bed time, cooking skill, household,
--    variety, meal-prep day and time, food styles. Body composition (InBody) upload removed.
--  * FREE calculator for everyone signed in (clients and guests): same targets and method as Nutrition.gs nutCalc_,
--    Mifflin St Jeor only. tone / health / sport = maintenance; sport = fat 25%. Water = 1 L per 30 kg, rounded up
--    to 0.25 L. Any health flag or under 18: no numbers, "our team will set your numbers".
--  * PAID plan = a separate 3 week nutrition subscription (public.nutrition_cycles), not tied to training packages.
--    LOCKED while settings nutrition.paid_open = false: clients see "coming soon". Test access without payment:
--    clients marked as nutrition testers by the owner, and clients whose email is an active staff member's email.
--    One plan per cycle. Weigh-ins and target changes only update the projection (no automatic replans).
--  * The AI writes the meals in the edge function nutrition-worker (functions/nutrition-worker), the code checks them.
--    Unflagged plans that pass the checks are shown at once. Flagged clients, or plans that failed the checks twice,
--    go to the OWNER only. For flagged clients the 21 days start when the owner approves.
--  * Reminders: per client schedule stored and served here. Push delivery is NOT built yet (no FCM): see DEPLOY.md.
--  * Grocery list ticks per client, per plan, per week.
-- Old action names stay: app_cl_nut (client), app_nut_list / app_nut_get / app_nut_decide (staff).
-- New: app_nut_cycle, app_nut_settings (owner). Worker door: wb_nut_claim / wb_nut_save / wb_nut_finish / wb_nut_error
-- (service role only). Run app.api_sync() at the end (done below).
-- =====================================================================

-- ---------------------------------------------------------------------
-- settings (the owner opens the paid plan with: update public.settings set value = jsonb_set(value, '{paid_open}', 'true') where key = 'nutrition';
-- or from the staff app)
-- ---------------------------------------------------------------------
insert into public.settings (key, value, notes)
values ('nutrition', '{"paid_open": false, "cycle_days": 21, "ai_errors_max": 3, "runs_max": 16}'::jsonb,
        'Nutrition v2: paid_open false = the paid 3 week plan shows "coming soon" to clients (testers can use it).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------
create table if not exists public.nutrition_cycles (            -- one 3 week nutrition subscription
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  source text not null check (source in ('test', 'payment')),   -- payment: later, from a payment provider (or the owner by hand)
  status text not null default 'waiting' check (status in ('waiting', 'active', 'cancelled')),
  days int not null default 21 check (days between 1 and 60),
  starts_on date, ends_on date,                                  -- ends_on = starts_on + days (the plan is open while today < ends_on)
  granted_by text, note text, payment_ref text,
  created_at timestamptz not null default now(),
  check ((starts_on is null) = (ends_on is null))
);
create index if not exists nutrition_cycles_client on public.nutrition_cycles (client_id, created_at desc);

create table if not exists public.nutrition_testers (           -- clients the owner lets try the paid plan without paying
  client_id uuid primary key references public.clients(id) on delete cascade,
  added_by text, note text, added_at timestamptz not null default now()
);
create table if not exists public.nutrition_reminders (         -- the client's own reminder settings (push delivery: later)
  client_id uuid primary key references public.clients(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb, muted boolean not null default false, snooze_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.nutrition_plans add column if not exists engine text not null default 'v1';
alter table public.nutrition_plans add column if not exists cycle_id uuid references public.nutrition_cycles(id) on delete set null;
alter table public.nutrition_plans add column if not exists review text;          -- auto | owner
alter table public.nutrition_plans add column if not exists review_reason text;
alter table public.nutrition_plans add column if not exists job text not null default 'write';   -- write | recheck (owner edit)
alter table public.nutrition_plans add column if not exists draft jsonb;           -- the worker's progress between runs
alter table public.nutrition_plans add column if not exists checks jsonb;          -- {passed, problems, at}
alter table public.nutrition_plans add column if not exists lease_until timestamptz;
alter table public.nutrition_plans add column if not exists runs int not null default 0;
do $$ begin
  alter table public.nutrition_plans add constraint nutrition_plans_engine check (engine in ('v1', 'v2'));
  alter table public.nutrition_plans add constraint nutrition_plans_review check (review is null or review in ('auto', 'owner'));
  alter table public.nutrition_plans add constraint nutrition_plans_job check (job in ('write', 'recheck'));
exception when duplicate_object then null; end $$;
create index if not exists nutrition_plans_cycle on public.nutrition_plans (cycle_id);

create table if not exists public.nutrition_grocery_ticks (     -- ticked items on the weekly grocery lists
  client_id uuid not null references public.clients(id) on delete cascade,
  plan_id uuid not null references public.nutrition_plans(id) on delete cascade,
  week int not null check (week between 1 and 3),
  item_key text not null check (length(item_key) between 1 and 120),
  at timestamptz not null default now(),
  primary key (client_id, plan_id, week, item_key)
);

-- ---------------------------------------------------------------------
-- who sees what (Row Level Security on every new table)
-- ---------------------------------------------------------------------
alter table public.nutrition_cycles enable row level security;
alter table public.nutrition_testers enable row level security;
alter table public.nutrition_reminders enable row level security;
alter table public.nutrition_grocery_ticks enable row level security;
drop policy if exists ncyc_read on public.nutrition_cycles;
drop policy if exists ncyc_owner on public.nutrition_cycles;
create policy ncyc_read on public.nutrition_cycles for select using (app.can_see_client(client_id));
create policy ncyc_owner on public.nutrition_cycles for all using (app.is_owner()) with check (app.is_owner());
drop policy if exists ntest_owner on public.nutrition_testers;
create policy ntest_owner on public.nutrition_testers for all using (app.is_owner()) with check (app.is_owner());
drop policy if exists nrem_read on public.nutrition_reminders;
drop policy if exists nrem_write on public.nutrition_reminders;
create policy nrem_read on public.nutrition_reminders for select using (app.can_see_client(client_id));
create policy nrem_write on public.nutrition_reminders for all using (app.is_mine(client_id) or app.is_owner()) with check (app.is_mine(client_id) or app.is_owner());
drop policy if exists ntick_read on public.nutrition_grocery_ticks;
drop policy if exists ntick_write on public.nutrition_grocery_ticks;
create policy ntick_read on public.nutrition_grocery_ticks for select using (app.can_see_client(client_id));
create policy ntick_write on public.nutrition_grocery_ticks for all using (app.is_mine(client_id)) with check (app.is_mine(client_id));

-- ---------------------------------------------------------------------
-- the questionnaire (sent to the phone; step 1 body numbers stay on the body screen)
-- ---------------------------------------------------------------------
create or replace function app.nut_questions() returns jsonb language sql immutable as $$ select '[{"step":1,"t":{"en":"Your goal","ar":"هدفك"},"q":[{"k":"goal","type":"one","t":{"en":"What do you want most?","ar":"شو بدك أكتر شي؟"},"opts":[{"v":"lose","en":"Lose fat","ar":"خسارة دهون"},{"v":"tone","en":"Keep my weight, get toned","ar":"شد الجسم مع الحفاظ على الوزن"},{"v":"gain","en":"Build muscle and gain weight","ar":"بناء عضل وزيادة وزن"},{"v":"sport","en":"Sport performance","ar":"أداء رياضي أفضل"},{"v":"health","en":"Eat healthier, no weight goal","ar":"أكل صحي أكتر، بلا هدف وزن"}]},{"k":"why","type":"text","max":200,"t":{"en":"Why now? (one sentence)","ar":"ليش هلق؟ (جملة وحدة)"}},{"k":"pace","type":"one","t":{"en":"Which pace suits you?","ar":"أي سرعة بتناسبك؟"},"opts":[{"v":"slow","en":"Steady and easy to keep","ar":"ثابتة وسهلة"},{"v":"fast","en":"Faster, I am very motivated","ar":"أسرع، أنا متحمس كتير"}],"show_if":{"goal":["lose","gain"]}},{"k":"event","type":"text","max":80,"t":{"en":"Any date you are aiming for? (wedding, summer, trip)","ar":"في تاريخ معين؟ (عرس، صيف، سفر)"}}]},{"step":2,"t":{"en":"Your day","ar":"نهارك"},"q":[{"k":"job","type":"one","t":{"en":"Your work day is mostly","ar":"شغلك بالنهار"},"opts":[{"v":"desk","en":"Sitting (desk, car)","ar":"قاعد (مكتب، سيارة)"},{"v":"mixed","en":"On my feet part of the day","ar":"واقف جزء من النهار"},{"v":"active","en":"Physical work, moving all day","ar":"شغل جسدي طول النهار"}]},{"k":"train_days","type":"one","t":{"en":"Training days per week (Wellbe + other)","ar":"كم يوم تمرين بالأسبوع"},"opts":[{"v":"1","en":"1","ar":"1"},{"v":"2","en":"2","ar":"2"},{"v":"3","en":"3","ar":"3"},{"v":"4","en":"4","ar":"4"},{"v":"5","en":"5+","ar":"5+"}]},{"k":"train_time","type":"one","t":{"en":"You usually train","ar":"عادة بتتمرن"},"opts":[{"v":"am","en":"Morning","ar":"الصبح"},{"v":"mid","en":"Midday","ar":"الضهر"},{"v":"pm","en":"Evening","ar":"المسا"}]},{"k":"wake","type":"time","t":{"en":"You wake up at","ar":"بتفيق الساعة"}},{"k":"bed","type":"time","t":{"en":"You go to bed at","ar":"بتنام الساعة"}},{"k":"sleep","type":"one","t":{"en":"Hours of sleep","ar":"ساعات النوم"},"opts":[{"v":"5","en":"Under 6","ar":"أقل من 6"},{"v":"6","en":"6 to 7","ar":"6 لـ 7"},{"v":"8","en":"7 to 8+","ar":"7 لـ 8+"}]}]},{"step":3,"t":{"en":"How you eat","ar":"كيف بتاكل"},"q":[{"k":"meals","type":"one","t":{"en":"Meals per day that suit you","ar":"كم وجبة بالنهار بتناسبك"},"opts":[{"v":"2","en":"2 meals","ar":"وجبتين"},{"v":"3","en":"3 meals","ar":"3 وجبات"},{"v":"3s","en":"3 meals + 1 snack","ar":"3 وجبات + سناك"},{"v":"4s","en":"3 meals + 2 snacks","ar":"3 وجبات + سناكين"}]},{"k":"breakfast","type":"one","t":{"en":"Breakfast","ar":"الترويقة"},"opts":[{"v":"yes","en":"I eat breakfast","ar":"بترويق"},{"v":"late","en":"Late, around noon","ar":"متأخر، عالضهر"},{"v":"no","en":"I skip it","ar":"ما بترويق"}]},{"k":"cook","type":"one","t":{"en":"Who cooks your food?","ar":"مين بيطبخ أكلك؟"},"opts":[{"v":"me","en":"Me","ar":"أنا"},{"v":"family","en":"Family / home cooking","ar":"البيت / العيلة"},{"v":"out","en":"Mostly delivery or eating out","ar":"دليفري أو برا"}]},{"k":"skill","type":"one","t":{"en":"Your cooking skills","ar":"مهارتك بالطبخ"},"opts":[{"v":"beginner","en":"Basic, keep it very simple","ar":"أساسية، خليها بسيطة كتير"},{"v":"ok","en":"I can follow a recipe","ar":"بقدر اتبع وصفة"},{"v":"good","en":"I cook well","ar":"بطبخ منيح"}]},{"k":"cook_time","type":"one","t":{"en":"Time to prepare food per day","ar":"وقت التحضير باليوم"},"opts":[{"v":"10","en":"10 min or less","ar":"10 دقايق أو أقل"},{"v":"30","en":"About 30 min","ar":"حوالي نص ساعة"},{"v":"60","en":"I like cooking","ar":"بحب الطبخ"}]},{"k":"out","type":"one","t":{"en":"Delivery / eating out per week","ar":"دليفري أو أكل برا بالأسبوع"},"opts":[{"v":"0","en":"Rarely","ar":"نادراً"},{"v":"2","en":"1 to 2 times","ar":"مرة لمرتين"},{"v":"4","en":"3 to 5 times","ar":"3 لـ 5 مرات"},{"v":"7","en":"Almost daily","ar":"تقريباً كل يوم"}]},{"k":"budget","type":"one","t":{"en":"Food budget","ar":"ميزانية الأكل"},"opts":[{"v":"low","en":"Tight, keep it cheap","ar":"محدودة"},{"v":"mid","en":"Normal","ar":"عادية"},{"v":"high","en":"Not an issue","ar":"مش مشكلة"}]},{"k":"household","type":"one","t":{"en":"How many people eat at home with you?","ar":"كم شخص بياكلوا معك بالبيت؟"},"note":{"en":"Dishes will suit the family. Your plan and grocery list stay sized for you only.","ar":"الأطباق بتناسب العيلة. خطتك ولائحة المشتريات بتضل على قياسك انت بس."},"opts":[{"v":"1","en":"Just me","ar":"أنا بس"},{"v":"2","en":"2 people","ar":"شخصين"},{"v":"4","en":"3 to 4 people","ar":"3 لـ 4 أشخاص"},{"v":"5","en":"5 or more","ar":"5 أو أكتر"}]},{"k":"variety","type":"one","t":{"en":"How much variety do you want?","ar":"قديش بدك تنويع؟"},"opts":[{"v":"same","en":"The same day all week (easiest)","ar":"نفس النهار كل الأسبوع (الأسهل)"},{"v":"two","en":"2 days that alternate","ar":"نهارين بيتبدلوا"},{"v":"four","en":"3 to 4 days that rotate","ar":"3 لـ 4 أيام بيدوروا"},{"v":"seven","en":"A different menu every day","ar":"منيو مختلف كل يوم"}]},{"k":"prep_day","type":"one","t":{"en":"Your weekly meal-prep day (for a reminder)","ar":"نهار تحضير الأكل بالأسبوع (للتذكير)"},"opts":[{"v":"mon","en":"Monday","ar":"الاثنين"},{"v":"tue","en":"Tuesday","ar":"الثلاثا"},{"v":"wed","en":"Wednesday","ar":"الأربعا"},{"v":"thu","en":"Thursday","ar":"الخميس"},{"v":"fri","en":"Friday","ar":"الجمعة"},{"v":"sat","en":"Saturday","ar":"السبت"},{"v":"sun","en":"Sunday","ar":"الأحد"}]},{"k":"prep_time","type":"time","t":{"en":"Meal-prep time","ar":"ساعة التحضير"}}]},{"step":4,"t":{"en":"What you eat now","ar":"شو بتاكل هلق"},"q":[{"k":"now_day","type":"text","max":400,"t":{"en":"Describe a normal day of eating (what and roughly when)","ar":"خبرنا عن نهار عادي من الأكل"}},{"k":"often","type":"many","t":{"en":"Things you eat a lot of","ar":"أكلات بتاكلها كتير"},"opts":[{"v":"bread","en":"Bread / man2oushe","ar":"خبز / منقوشة"},{"v":"rice","en":"Rice","ar":"رز"},{"v":"pasta","en":"Pasta","ar":"معكرونة"},{"v":"sweets","en":"Sweets / chocolate","ar":"حلو / شوكولا"},{"v":"chips","en":"Chips / snacks","ar":"شيبس / سناكات"},{"v":"fastfood","en":"Fast food","ar":"فاست فود"},{"v":"fruit","en":"Fruit","ar":"فواكه"},{"v":"dairy","en":"Labneh / cheese / laban","ar":"لبنة / جبنة / لبن"},{"v":"chicken","en":"Chicken","ar":"دجاج"},{"v":"meat","en":"Red meat","ar":"لحمة"},{"v":"fish","en":"Fish","ar":"سمك"},{"v":"eggs","en":"Eggs","ar":"بيض"}]},{"k":"love","type":"many","t":{"en":"Lebanese dishes you love","ar":"أكلات لبنانية بتحبها"},"opts":[{"v":"tabbouleh","en":"Tabbouleh / fattoush","ar":"تبولة / فتوش"},{"v":"mjadra","en":"Mjadra","ar":"مجدرة"},{"v":"loubieh","en":"Loubieh / bamieh / fasoulia","ar":"لوبية / بامية / فاصوليا"},{"v":"kibbeh","en":"Kibbeh","ar":"كبة"},{"v":"shawarma","en":"Shawarma / taouk","ar":"شاورما / طاووق"},{"v":"grills","en":"Mashawi","ar":"مشاوي"},{"v":"foul","en":"Foul / hummus / balila","ar":"فول / حمص / بليلة"},{"v":"mloukhieh","en":"Mloukhieh","ar":"ملوخية"},{"v":"mehshi","en":"Mehshi / warak enab","ar":"محشي / ورق عنب"},{"v":"manakish","en":"Manakish","ar":"مناقيش"},{"v":"fatteh","en":"Fatteh","ar":"فتة"},{"v":"samke","en":"Samke harra / sayadieh","ar":"سمكة حرة / صيادية"}]},{"k":"style","type":"many","t":{"en":"Food styles you like","ar":"نوع الأكل اللي بتحبه"},"opts":[{"v":"lebanese","en":"Lebanese home dishes","ar":"أكل بيتي لبناني"},{"v":"intl","en":"Simple international dishes","ar":"أطباق عالمية بسيطة"},{"v":"protein","en":"High-protein fitness style","ar":"أكل رياضي غني بالبروتين"},{"v":"budget","en":"Budget basics","ar":"أساسيات اقتصادية"},{"v":"fasting","en":"Fasting-friendly (Ramadan, Lent)","ar":"مناسب للصيام (رمضان، الصوم)"}]},{"k":"love_other","type":"text","max":150,"t":{"en":"Other foods you love","ar":"أكلات تانية بتحبها"}},{"k":"dislike","type":"text","max":150,"t":{"en":"Foods you do not eat or dislike","ar":"أكلات ما بتاكلها أو ما بتحبها"}}]},{"step":5,"t":{"en":"Allergies and rules","ar":"حساسية وقواعد"},"q":[{"k":"allergy","type":"many","t":{"en":"Allergies or intolerances","ar":"حساسية أو عدم تحمل"},"opts":[{"v":"none","en":"None","ar":"ولا شي"},{"v":"lactose","en":"Lactose","ar":"لاكتوز"},{"v":"gluten","en":"Gluten","ar":"غلوتين"},{"v":"nuts","en":"Nuts","ar":"مكسرات"},{"v":"peanut","en":"Peanuts","ar":"فول سوداني"},{"v":"eggs","en":"Eggs","ar":"بيض"},{"v":"seafood","en":"Fish / seafood","ar":"سمك / بحريات"},{"v":"sesame","en":"Sesame / tahini","ar":"سمسم / طحينة"},{"v":"soy","en":"Soy","ar":"صويا"}]},{"k":"allergy_other","type":"text","max":100,"t":{"en":"Other allergy","ar":"حساسية تانية"}},{"k":"rules","type":"many","t":{"en":"Food rules you follow","ar":"قواعد بتتبعها"},"opts":[{"v":"halal","en":"Halal","ar":"حلال"},{"v":"nopork","en":"No pork","ar":"بلا خنزير"},{"v":"vegetarian","en":"Vegetarian","ar":"نباتي"},{"v":"vegan","en":"Vegan","ar":"نباتي صرف"},{"v":"ramadan","en":"I fast in Ramadan","ar":"بصوم رمضان"},{"v":"lent","en":"I fast in Lent","ar":"بصوم الصوم الكبير"}]},{"k":"digest","type":"many","t":{"en":"Digestion","ar":"الهضم"},"opts":[{"v":"ok","en":"All good","ar":"تمام"},{"v":"bloat","en":"Bloating","ar":"نفخة"},{"v":"reflux","en":"Reflux / heartburn","ar":"حرقة"},{"v":"ibs","en":"IBS / sensitive stomach","ar":"قولون حساس"},{"v":"const","en":"Constipation","ar":"إمساك"}]}]},{"step":6,"t":{"en":"Drinks and habits","ar":"مشروبات وعادات"},"q":[{"k":"coffee","type":"one","t":{"en":"Coffee per day","ar":"قهوة باليوم"},"opts":[{"v":"0","en":"None","ar":"ولا شي"},{"v":"2","en":"1 to 2","ar":"1 لـ 2"},{"v":"4","en":"3+","ar":"3+"}]},{"k":"sugar_drinks","type":"one","t":{"en":"Soft drinks / juice / sweet coffee","ar":"مشروبات غازية / عصير / قهوة محلاية"},"opts":[{"v":"0","en":"Rarely","ar":"نادراً"},{"v":"1","en":"Once a day","ar":"مرة باليوم"},{"v":"3","en":"Several a day","ar":"كذا مرة"}]},{"k":"alcohol","type":"one","t":{"en":"Alcohol","ar":"كحول"},"opts":[{"v":"0","en":"Never","ar":"أبداً"},{"v":"1","en":"Weekends","ar":"ويكند"},{"v":"3","en":"Several times a week","ar":"كذا مرة بالأسبوع"}]},{"k":"water","type":"one","t":{"en":"Water per day","ar":"مي باليوم"},"opts":[{"v":"1","en":"Under 1 L","ar":"أقل من ليتر"},{"v":"2","en":"1 to 2 L","ar":"1 لـ 2 ليتر"},{"v":"3","en":"2 L+","ar":"أكتر من 2"}]},{"k":"cravings","type":"one","t":{"en":"When do cravings hit?","ar":"إيمتى بتجيك الشهوة للأكل؟"},"opts":[{"v":"none","en":"Not really","ar":"مش كتير"},{"v":"afternoon","en":"Afternoon","ar":"بعد الضهر"},{"v":"night","en":"Late night","ar":"آخر الليل"},{"v":"stress","en":"When stressed","ar":"لما كون متوتر"}]},{"k":"weekend","type":"one","t":{"en":"Weekends","ar":"الويكند"},"opts":[{"v":"same","en":"Same as weekdays","ar":"متل باقي الأيام"},{"v":"family","en":"Big family lunches","ar":"غدا عيلة كبير"},{"v":"out","en":"Out with friends","ar":"طلعات مع رفقات"}]},{"k":"supps","type":"many","t":{"en":"Supplements you take","ar":"مكملات بتاخدها"},"opts":[{"v":"none","en":"None","ar":"ولا شي"},{"v":"whey","en":"Whey protein","ar":"بروتين واي"},{"v":"creatine","en":"Creatine","ar":"كرياتين"},{"v":"multi","en":"Multivitamin","ar":"فيتامينات"},{"v":"omega","en":"Omega 3","ar":"أوميغا 3"},{"v":"vitd","en":"Vitamin D","ar":"فيتامين د"}]}]},{"step":7,"t":{"en":"Your health","ar":"صحتك"},"q":[{"k":"health","type":"many","t":{"en":"Does any of this apply to you?","ar":"شي من هول بينطبق عليك؟"},"opts":[{"v":"none","en":"None of these","ar":"ولا شي"},{"v":"pregnant","en":"Pregnant or breastfeeding","ar":"حامل أو عم رضع"},{"v":"diabetes","en":"Diabetes or pre-diabetes","ar":"سكري"},{"v":"kidney","en":"Kidney problems","ar":"مشاكل كلى"},{"v":"liver","en":"Liver problems","ar":"مشاكل كبد"},{"v":"thyroid","en":"Thyroid problems","ar":"مشاكل غدة"},{"v":"meds","en":"Medication that changes appetite","ar":"دوا بيغير الشهية"},{"v":"ed","en":"Past eating disorder","ar":"اضطراب أكل سابقاً"}]}],"note":{"en":"Yes or no only, no details needed. If any of these apply, our team sets your numbers and checks your plan personally, to keep you safe.","ar":"بس نعم أو لا، بلا تفاصيل. إذا شي من هول بينطبق عليك، فريقنا بيحدد أرقامك وبيشيك خطتك شخصياً، لسلامتك."}}]'::jsonb $$;

-- ---------------------------------------------------------------------
-- THE NUMBERS (code, never AI). Same targets and method as Nutrition.gs nutCalc_, Mifflin St Jeor only.
-- ---------------------------------------------------------------------
-- water: at least 1 L per 30 kg of body weight, rounded UP to the next 0.25 L
create or replace function app.nut_water(w float8) returns float8 language sql immutable as $$
  select case when coalesce(w, 0) > 0 then ceil(w / 30 * 4 - 1e-9) / 4 else 0 end
$$;
-- all the numbers, flags or not (the paid plan of a flagged client uses them, the owner checks them)
create or replace function app.nut_numbers(prof jsonb, today date) returns jsonb language plpgsql immutable as $$
declare ans jsonb := coalesce(prof->'ans', '{}'); out jsonb := '{"ok":false}'; w float8 := app.n0(prof->'weight'); h float8 := app.n0(prof->'height');
  age float8 := app.n0(prof->'age'); sx text := coalesce(prof->>'sex', ''); goal text := coalesce(ans->>'goal', ''); maint boolean;
  hm float8; target float8; bmr float8; tdee float8; dir text; pace text; rate float8; kcal float8; fl float8; prot float8; fat float8; carb float8;
  fatpct float8; floorhit boolean := false; safe float8;
begin
  if not (w > 25) or not (h > 100) or not (age > 0) or sx = '' then
    return out || jsonb_build_object('missing', true, 'msg', 'Add your weight, height, birth year and sex first.', 'msg_ar', 'زيد وزنك، طولك، سنة ميلادك والجنس أول.');
  end if;
  maint := goal in ('tone', 'health', 'sport');                       -- keep the weight: maintenance calories
  hm := h / 100; target := case when maint then w else coalesce(nullif(app.n0(prof->'target'), 0), w) end;
  out := out || jsonb_build_object('bmi', app.jr(w / (hm * hm) * 10) / 10, 'goal', goal);
  if target / (hm * hm) < 18.5 then
    safe := ceil(18.5::float8 * hm * hm);
    return out || jsonb_build_object('blocked', true, 'safeMin', safe,
      'msg', 'This target is under a healthy weight for your height. The closest healthy target is ' || app.fnum(safe) || ' kg.',
      'msg_ar', 'هيدا الهدف أقل من الوزن الصحي لطولك. أقرب هدف صحي هو ' || app.fnum(safe) || ' كيلو.');
  end if;
  bmr := 10 * w + 6.25::float8 * h - 5 * age + case when sx = 'M' then 5 else -161 end;
  tdee := bmr * app.nut_factor(ans);
  dir := case when target - w < -0.5 then 'lose' when target - w > 0.5 then 'gain' else 'keep' end;
  pace := case when ans->>'pace' = 'fast' then 'fast' else 'slow' end;
  rate := case dir when 'lose' then (case pace when 'fast' then 0.0075 else 0.005 end)::float8 * w
                   when 'gain' then (case pace when 'fast' then 0.005 else 0.0025 end)::float8 * w else 0 end;
  kcal := tdee + (case when dir = 'lose' then -1 else 1 end) * rate * 7700 / 7;
  fl := greatest(case when sx = 'M' then 1500 else 1200 end, bmr * 1.0::float8);
  if dir = 'lose' and kcal < fl then kcal := fl; rate := greatest(0, (tdee - kcal) * 7 / 7700); floorhit := true; end if;
  kcal := app.jr(kcal / 10) * 10;
  fatpct := case when goal = 'sport' then 0.25 else 0.28 end;
  prot := app.jr(2 * target / 5) * 5; fat := app.jr(kcal * fatpct / 9); carb := app.jr((kcal - prot * 4 - fat * 9) / 4 / 5) * 5;
  if carb < 60 then fat := app.jr(kcal * 0.25::float8 / 9); carb := greatest(40, app.jr((kcal - prot * 4 - fat * 9) / 4 / 5) * 5); end if;
  if floorhit then out := out || '{"floorHit":true}'; end if;
  return out || jsonb_build_object('ok', true, 'dir', dir, 'bmr', app.jr(bmr), 'tdee', app.jr(tdee), 'kcal', kcal, 'p', prot, 'f', fat, 'c', carb,
    'fatPct', fatpct, 'sport', goal = 'sport', 'rateKg', app.jr(rate * 100) / 100, 'method', 'Mifflin St Jeor', 'weight', w, 'target', target,
    'water_l', app.nut_water(w),
    'projection', app.nut_project(w, target, rate, dir, today, coalesce(nullif(app.n0(ans->'train_days'), 0), 3)));
end $$;
-- what the client sees (the free calculator): any health flag or under 18 = no numbers, the team sets them
create or replace function app.nut_calc(prof jsonb, today date) returns jsonb language plpgsql immutable as $$
declare flags jsonb := app.nut_flags(app.n0(prof->'age')::int, coalesce(prof->'ans', '{}')); n jsonb := app.nut_numbers(prof, today);
begin
  if app.truthy(n->'missing') then return n || jsonb_build_object('flags', flags); end if;
  if jsonb_array_length(flags) > 0 then
    return jsonb_build_object('ok', false, 'coach', true, 'flags', flags,
      'msg', 'Our team will set your numbers with you personally, to keep you safe.', 'msg_ar', 'فريقنا رح يحدد أرقامك معك شخصياً، لسلامتك.');
  end if;
  return n || jsonb_build_object('flags', flags, 'coach', false, 'check', false);
end $$;
-- body numbers for the calculator (no body fat any more: Mifflin only)
create or replace function app.nut_profile(cu uuid, it jsonb, today date) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare body jsonb := app.wo_body(cu); lastw record; w float8; birth int;
begin
  select day, weight_kg::float8 as kg into lastw from public.nutrition_weighins where client_id = cu order by day desc, seq desc limit 1;
  w := case when lastw.day is not null and (coalesce(body->>'date', '') = '' or lastw.day::text >= body->>'date') then lastw.kg else (body->>'weight')::float8 end;
  birth := (body->>'birth')::int;
  return jsonb_build_object('weight', coalesce(w, 0), 'height', body->'height', 'age', case when birth <> 0 then extract(year from today)::int - birth else 0 end,
    'sex', body->'sex', 'target', it->'target', 'pace', it->'answers'->'pace', 'ans', it->'answers');
end $$;
-- no automatic replans any more (weigh-ins and target changes only update the projection)
create or replace function app.nut_auto_replan(cu uuid, it jsonb, why text) returns text language sql immutable as $$ select ''::text $$;

-- ---------------------------------------------------------------------
-- paid access: the lock, testers, the 3 week cycle
-- ---------------------------------------------------------------------
create or replace function app.nut_open() returns boolean language sql stable as $$
  select coalesce((app.setting('{nutrition,paid_open}') #>> '{}')::boolean, false)
$$;
create or replace function app.nut_is_tester(cu uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.nutrition_testers t where t.client_id = cu)
      or exists (select 1 from public.clients c join public.staff s on s.active and coalesce(s.email, '') <> '' and lower(s.email) = lower(c.email) where c.id = cu)
$$;
create or replace function app.nut_cycle_last(cu uuid) returns public.nutrition_cycles language sql stable security definer set search_path = public as $$
  select * from public.nutrition_cycles where client_id = cu order by created_at desc, id desc limit 1
$$;
-- none | waiting (starts when the owner approves the plan) | active | ended
create or replace function app.nut_cycle_state(c public.nutrition_cycles, today date) returns text language sql stable as $$
  select case when c.id is null then 'none' when c.status = 'cancelled' then 'ended' when c.starts_on is null then 'waiting'
              when today >= c.ends_on then 'ended' when today < c.starts_on then 'waiting' else 'active' end
$$;
create or replace function app.nut_cycle_open(cyc uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select app.nut_cycle_state(c, app_today()) = 'active' from public.nutrition_cycles c where c.id = cyc), false)
$$;
create or replace function app.nut_cycle_obj(c public.nutrition_cycles, today date) returns jsonb language sql stable as $$
  select case when c.id is null then null else jsonb_build_object('state', app.nut_cycle_state(c, today), 'source', c.source, 'days', c.days,
    'start', c.starts_on, 'end', c.ends_on,
    'day', case when c.starts_on is not null and today >= c.starts_on then least(c.days, today - c.starts_on + 1) end,
    'days_left', case when c.ends_on is not null then greatest(0, c.ends_on - today) end) end
$$;
-- a new cycle: active from today, or waiting for the owner's approval when the client has a health flag
create or replace function app.nut_new_cycle(cu uuid, src text, who text, flagged boolean, note text) returns public.nutrition_cycles language plpgsql security definer set search_path = public as $$
declare c public.nutrition_cycles; d int := coalesce(app.setting_int('{nutrition,cycle_days}', 21), 21);
begin
  insert into public.nutrition_cycles (client_id, source, status, days, starts_on, ends_on, granted_by, note)
  values (cu, src, case when flagged then 'waiting' else 'active' end, d,
          case when flagged then null else app_today() end, case when flagged then null else app_today() + d end, who, nullif(note, ''))
  returning * into c;
  return c;
end $$;
create or replace function app.nut_start_cycle(cyc uuid) returns void language sql security definer set search_path = public as $$
  update public.nutrition_cycles set status = 'active', starts_on = app_today(), ends_on = app_today() + days where id = cyc and starts_on is null and status = 'waiting'
$$;
-- the client's access to the paid plan
--   state: coming_soon (locked) | none (open, no cycle) | waiting | active | ended
create or replace function app.nut_access(cu uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare open boolean := app.nut_open(); tester boolean := app.nut_is_tester(cu); c public.nutrition_cycles := app.nut_cycle_last(cu); st text;
begin
  st := app.nut_cycle_state(c, app_today());
  if st not in ('waiting', 'active') and not (open or tester) then st := 'coming_soon'; end if;
  return jsonb_build_object('open', open, 'tester', tester, 'state', st, 'cycle', app.nut_cycle_obj(c, app_today()),
    'can_start', tester and st in ('none', 'ended'), 'desk', app.desk_name());
end $$;
-- WhatsApp to the owner only (sent by the outbox worker once its keys are set)
create or replace function app.nut_tell_owner(msg text) returns void language sql security definer set search_path = public as $$
  insert into public.outbox (channel, to_staff, body) select 'whatsapp', id, msg from public.staff where active and role = 'owner'
$$;

-- ---------------------------------------------------------------------
-- reminders: defaults from the answers and the plan, the client's own changes on top. Push delivery comes later.
-- prefs: {meal:{on, times:{"0":"08:00",...}}, water:{on, every_h}, prep:{on, day, time}, quiet:{from, to}}
-- ---------------------------------------------------------------------
create or replace function app.nut_hm(v text, fb text) returns time language sql immutable as $$
  select (case when coalesce(v, '') ~ '^([01]\d|2[0-3]):[0-5]\d$' then v else fb end)::time
$$;
create or replace function app.nut_in_window(t time, a time, b time) returns boolean language sql immutable as $$
  select case when a < b then t >= a and t < b when a > b then t >= a or t < b else true end
$$;
create or replace function app.nut_reminders(cu uuid, ans jsonb, plan jsonb, active boolean) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r public.nutrition_reminders; pr jsonb; wake time; bed time; qf time; qt time; items jsonb := '[]'; t time; k int := 0; every int; i int; mt jsonb; m jsonb;
  dn jsonb := '{"mon":["Monday","الاثنين"],"tue":["Tuesday","الثلاثا"],"wed":["Wednesday","الأربعا"],"thu":["Thursday","الخميس"],"fri":["Friday","الجمعة"],"sat":["Saturday","السبت"],"sun":["Sunday","الأحد"]}';
  pday text; ptime time; paused boolean; a int; b int; gm int;
begin
  select * into r from public.nutrition_reminders where client_id = cu;
  pr := coalesce(r.prefs, '{}');
  -- the day window: wake to bed (fallback 08:00 to 22:00); quiet hours outside it unless the client set their own
  wake := app.nut_hm(case when coalesce(ans->>'wake', '') <> '' and coalesce(ans->>'bed', '') <> '' then ans->>'wake' end, '08:00');
  bed := app.nut_hm(case when coalesce(ans->>'wake', '') <> '' and coalesce(ans->>'bed', '') <> '' then ans->>'bed' end, '22:00');
  qf := app.nut_hm(pr->'quiet'->>'from', bed::text); qt := app.nut_hm(pr->'quiet'->>'to', wake::text);
  -- meals: each planned eating time
  if coalesce((pr->'meal'->>'on')::boolean, true) and jsonb_typeof(plan->'eating_times') = 'array' then
    for m, i in select x, o - 1 from jsonb_array_elements(plan->'eating_times') with ordinality e(x, o) loop
      t := app.nut_hm(pr->'meal'->'times'->>(i::text), m->>'time');
      items := items || jsonb_build_array(jsonb_build_object('kind', 'meal', 'slot', m->>'slot', 'index', i, 'time', to_char(t, 'HH24:MI'), 'days', 'daily',
        'label', jsonb_build_object('en', 'Time for your ' || coalesce(m->>'slot', 'meal'), 'ar', 'وقت ' || case m->>'slot' when 'breakfast' then 'الترويقة' when 'lunch' then 'الغدا' when 'dinner' then 'العشا' else 'السناك' end)));
    end loop;
  end if;
  -- water: every 2 hours (the client can choose 1 to 4) inside the day window
  if coalesce((pr->'water'->>'on')::boolean, true) then
    every := greatest(1, least(4, coalesce(nullif(app.n0(pr->'water'->'every_h'), 0), 2)::int));
    a := extract(hour from wake)::int * 60 + extract(minute from wake)::int; b := extract(hour from bed)::int * 60 + extract(minute from bed)::int;
    if b <= a then b := b + 1440; end if;                                 -- bed after midnight
    for gm in select g from generate_series(a, b - 1, every * 60) g loop
      items := items || jsonb_build_array(jsonb_build_object('kind', 'water', 'time', to_char(make_time((gm % 1440) / 60, (gm % 1440) % 60, 0), 'HH24:MI'), 'days', 'daily',
        'label', jsonb_build_object('en', 'Drink a glass of water', 'ar', 'اشرب كباية مي')));
    end loop;
  end if;
  -- weekly meal prep
  pday := coalesce(nullif(pr->'prep'->>'day', ''), ans->>'prep_day');
  if coalesce((pr->'prep'->>'on')::boolean, true) and dn ? coalesce(pday, '') then
    ptime := app.nut_hm(coalesce(pr->'prep'->>'time', ans->>'prep_time'), '10:00');
    items := items || jsonb_build_array(jsonb_build_object('kind', 'prep', 'time', to_char(ptime, 'HH24:MI'), 'days', pday,
      'label', jsonb_build_object('en', 'Meal prep for the week (' || (dn->pday->>0) || ')', 'ar', 'تحضير أكل الأسبوع (' || (dn->pday->>1) || ')')));
  end if;
  -- quiet hours: nothing rings inside them
  select coalesce(jsonb_agg(x order by x->>'time', x->>'kind'), '[]') into items from jsonb_array_elements(items) x
   where not app.nut_in_window((x->>'time')::time, qf, qt) or qf = qt;
  paused := coalesce(r.muted, false) or coalesce(r.snooze_until > now(), false);
  return jsonb_build_object('active', active, 'delivery', 'pending', 'muted', coalesce(r.muted, false), 'snooze_until', r.snooze_until, 'paused', paused,
    'window', jsonb_build_object('from', to_char(wake, 'HH24:MI'), 'to', to_char(bed, 'HH24:MI')),
    'quiet', jsonb_build_object('from', to_char(qf, 'HH24:MI'), 'to', to_char(qt, 'HH24:MI')),
    'items', case when active then items else '[]'::jsonb end, 'prefs', pr);
end $$;

-- ---------------------------------------------------------------------
-- the client's screen (every op answers with it)
-- ---------------------------------------------------------------------
create or replace function app.nut_client_plan(pl public.nutrition_plans, cstate text) returns jsonb language sql stable security definer set search_path = public as $$
  select case when pl.id is null then null else
    jsonb_build_object('id', pl.legacy_id, 'status', pl.status, 'created', app.stamp(pl.created_at), 'note', coalesce(pl.coach_note, ''),
      'state', case when pl.status = 'Approved' and cstate = 'active' then 'ready' when pl.status = 'Approved' then 'locked'
                    when pl.status = 'Declined' then 'declined' else 'preparing' end,
      'msg', case when pl.status = 'Declined' then jsonb_build_object('en', 'Our team will contact you about your plan.', 'ar', 'فريقنا رح يتواصل معك بخصوص خطتك.')
                  when pl.status not in ('Approved') then jsonb_build_object('en', 'Your plan is being prepared by our team.', 'ar', 'فريقنا عم يحضّر خطتك.') end)
    || case when pl.status = 'Approved' and cstate = 'active' then jsonb_build_object('data', pl.plan, 'macros', pl.macros,
         'ticks', (select coalesce(jsonb_object_agg(week::text, keys), '{}') from (select week, jsonb_agg(item_key order by item_key) keys from public.nutrition_grocery_ticks t
                    where t.plan_id = pl.id and t.client_id = pl.client_id group by week) z)) else '{}'::jsonb end end
$$;
create or replace function app.nut_screen(cu uuid, it jsonb, today date, with_questions boolean) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare prof jsonb := app.nut_profile(cu, it, today); acc jsonb := app.nut_access(cu); c public.nutrition_cycles := app.nut_cycle_last(cu); cst text; pl public.nutrition_plans; calc jsonb; out jsonb;
begin
  cst := app.nut_cycle_state(c, today);
  if c.id is not null then
    select * into pl from public.nutrition_plans where client_id = cu and engine = 'v2' and cycle_id = c.id and status <> 'Replaced' order by created_at desc, legacy_id desc limit 1;
  end if;
  calc := app.nut_calc(prof, today);
  out := jsonb_build_object('v', 2, 'answers', it->'answers', 'step', it->'step', 'done', it->'done', 'target', it->'target', 'flags', it->'flags',
    'body', jsonb_build_object('weight', prof->'weight', 'height', prof->'height', 'age', prof->'age', 'sex', prof->'sex'),
    'calc', calc, 'paid', cst in ('active', 'waiting'),
    'weighins', (select coalesce(jsonb_agg(x order by i), '[]') from jsonb_array_elements(app.nut_weighins(cu)) with ordinality t(x, i) where i > jsonb_array_length(app.nut_weighins(cu)) - 26),
    'nut', acc || jsonb_build_object('disclaimer', jsonb_build_object('en', 'General guidance for healthy eating, not medical treatment. If you have a health condition or take medication, follow your doctor''s advice.',
                                                                    'ar', 'إرشادات عامة للأكل الصحي، مش علاج طبي. إذا عندك حالة صحية أو بتاخد دوا، اتبع نصيحة طبيبك.')),
    'plan', app.nut_client_plan(pl, cst),
    'reminders', app.nut_reminders(cu, it->'answers', case when pl.status = 'Approved' and cst = 'active' then pl.plan end, coalesce(cst = 'active' and pl.status = 'Approved', false)),
    'upsell', '');
  if with_questions then out := out || jsonb_build_object('questions', app.nut_questions()); end if;
  return out;
end $$;

-- action app_cl_nut { cid, op } (old name kept)
--   intake_get | get | calc        the screen (intake_get adds the questions)
--   intake_save {answers, step, done}
--   body {weight, height, birth, sex, target}           (no body composition any more)
--   weigh {kg}                                           (updates the projection only)
--   generate                                             (paid plan: needs an open cycle, or a tester starts a test cycle)
--   tick {plan, week, item, on}                          (grocery list; 'key' is taken by the API door)
--   reminders {prefs?, mute?, snooze_min?}               (0 = stop snoozing)
--   upload                                               (removed: InBody)
create or replace function public.api_app_cl_nut(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; op text := coalesce(nullif(p->>'op', ''), 'intake_get');
  today date := app_today(); it jsonb; out jsonb := '{}'; qs jsonb := app.nut_questions(); q record; v jsonb; ok_v jsonb; miss text[]; w float8; h float8; y float8; sx text; tg float8;
  yr int := extract(year from app_today())::int; kg float8; prof jsonb; nums jsonb; flags jsonb; acc jsonb; c public.nutrition_cycles; cst text; lid text; st text; nm text;
  stop boolean; pl public.nutrition_plans; wk int; key text; pr jsonb; snooze float8;
begin
  me := app.need_client(cu);
  it := app.nut_intake(cu);
  nm := (select name from public.clients where id = cu);
  if op = 'intake_save' then
    for q in select x as qq from jsonb_array_elements(qs) s, jsonb_array_elements(s->'q') x loop
      continue when not (coalesce(p->'answers', '{}'::jsonb) ? (q.qq->>'k'));
      v := p->'answers'->(q.qq->>'k');
      if q.qq->>'type' = 'many' then
        select coalesce(jsonb_agg(o->'v'), '[]') into ok_v from jsonb_array_elements(q.qq->'opts') o;
        select coalesce(jsonb_agg(x order by i), '[]') into v from jsonb_array_elements(app.arr(v)) with ordinality t(x, i) where ok_v @> jsonb_build_array(x) and i <= 20;
        if jsonb_array_length(v) > 1 then select coalesce(jsonb_agg(x order by i), '[]') into v from jsonb_array_elements(v) with ordinality t(x, i) where x <> '"none"'::jsonb; end if;
      elsif q.qq->>'type' = 'one' then
        continue when jsonb_typeof(v) <> 'string' or not exists (select 1 from jsonb_array_elements(q.qq->'opts') o where o->>'v' = v #>> '{}');
      elsif q.qq->>'type' = 'time' then
        v := to_jsonb(case when jsonb_typeof(v) = 'string' and v #>> '{}' ~ '^([01]\d|2[0-3]):[0-5]\d$' then v #>> '{}' else '' end);
      else
        v := to_jsonb(app.clean_json(v, coalesce((q.qq->>'max')::int, 200)));
      end if;
      it := jsonb_set(it, array['answers', q.qq->>'k'], v);
    end loop;
    it := it || jsonb_build_object('step', greatest((it->>'step')::int, least(jsonb_array_length(qs), app.n0(p->'step'))::int));
    if app.truthy(p->'done') then
      select array_agg(k order by i) into miss from unnest(array['goal', 'job', 'train_days', 'meals', 'allergy', 'health']) with ordinality u(k, i)
       where it->'answers'->k is null or jsonb_typeof(it->'answers'->k) = 'null' or it->'answers'->k in ('""'::jsonb, '[]'::jsonb);
      if miss is not null then raise exception 'A few answers are missing: %', array_to_string(miss, ', '); end if;
      it := it || jsonb_build_object('done', true, 'ver', (it->>'ver')::int + 1);
    end if;
    it := it || jsonb_build_object('flags', app.nut_flags((app.nut_profile(cu, it, today)->>'age')::int, it->'answers'));
    perform app.nut_save_intake(cu, it);
  elsif op = 'body' then
    w := app.n0(p->'weight'); h := app.n0(p->'height'); y := app.n0(p->'birth'); sx := case when p->>'sex' in ('M', 'F') then p->>'sex' else '' end; tg := app.n0(p->'target');
    if w <> 0 and (w < 25 or w > 300) then raise exception 'Check your weight (kg)'; end if;
    if h <> 0 and (h < 100 or h > 230) then raise exception 'Check your height (cm)'; end if;
    if y <> 0 and (y < 1920 or y > yr - 8) then raise exception 'Check your birth year'; end if;
    if tg <> 0 and (tg < 30 or tg > 250) then raise exception 'Check your target weight (kg)'; end if;
    if w <> 0 or h <> 0 or y <> 0 or sx <> '' then
      insert into public.client_body (day, client_id, weight_kg, height_cm, birth_year, sex, by_who) values (today, cu, nullif(w, 0), nullif(h, 0), nullif(y, 0)::int, nullif(sx, ''), 'client app');
    end if;
    if tg <> 0 then it := it || jsonb_build_object('target', tg); end if;
    it := it || jsonb_build_object('flags', app.nut_flags((app.nut_profile(cu, it, today)->>'age')::int, it->'answers'));
    perform app.nut_save_intake(cu, it);                      -- a new target only moves the projection (no new plan)
  elsif op = 'upload' then
    raise exception 'The body composition upload was removed. Type your weight and height instead.';
  elsif op = 'weigh' then
    kg := app.n0(p->'kg');
    if kg < 25 or kg > 300 then raise exception 'Check the weight (kg)'; end if;
    insert into public.nutrition_weighins (day, client_id, weight_kg, by_who) values (today, cu, kg, 'client app');   -- projection only
  elsif op = 'generate' then
    acc := app.nut_access(cu);
    if acc->>'state' = 'coming_soon' then raise exception 'Your full nutrition plan is coming soon.'; end if;
    if not coalesce((it->>'done')::boolean, false) then raise exception 'Finish the questionnaire first.'; end if;
    prof := app.nut_profile(cu, it, today); nums := app.nut_numbers(prof, today);
    flags := app.nut_flags(app.n0(prof->'age')::int, it->'answers');
    if app.truthy(nums->'missing') or app.truthy(nums->'blocked') then raise exception '%', nums->>'msg'; end if;
    perform pg_advisory_xact_lock(hashtext('nut:' || cu::text));
    c := app.nut_cycle_last(cu); cst := app.nut_cycle_state(c, today);
    if cst not in ('active', 'waiting') then
      if not app.truthy(acc->'tester') then raise exception 'Your 3-week nutrition plan starts with %. Message them to start.', app.desk_name(); end if;
      c := app.nut_new_cycle(cu, 'test', 'client app (tester)', jsonb_array_length(flags) > 0, 'test access');
    end if;
    if exists (select 1 from public.nutrition_plans where cycle_id = c.id and status <> 'Replaced') then
      raise exception 'Your plan for this cycle is ready or being prepared. A new plan comes with your next 3-week cycle.';
    end if;
    stop := exists (select 1 from jsonb_array_elements_text(flags) f where f in ('minor', 'pregnant', 'ed', 'kidney'));
    st := case when stop then 'Coach review' else 'Queued' end;
    lid := app.next_legacy('NP', 'public.nutrition_plans', 4);
    insert into public.nutrition_plans (legacy_id, client_id, status, macros, intake_version, weight_at_plan, target, by_who, engine, cycle_id, review, review_reason)
    values (lid, cu, st, nums, (it->>'ver')::int, nullif(app.n0(nums->'weight'), 0), nullif(app.n0(nums->'target'), 0), 'client app', 'v2', c.id,
            case when jsonb_array_length(flags) > 0 then 'owner' else 'auto' end,
            case when jsonb_array_length(flags) > 0 then 'Health answers: ' || (select string_agg(x, ', ' order by i) from jsonb_array_elements_text(flags) with ordinality t(x, i)) end);
    if stop then
      perform app.nut_tell_owner('Nutrition: ' || nm || ' asked for a plan. Health answers (' || (select string_agg(x, ', ' order by i) from jsonb_array_elements_text(flags) with ordinality t(x, i))
        || '): set their numbers in the staff app (Nutrition plans, Regenerate) or build it with them. Plan ' || lid);
    end if;
    out := out || jsonb_build_object('status', st);
  elsif op = 'tick' then
    select * into pl from public.nutrition_plans where client_id = cu and legacy_id = coalesce(p->>'plan', '') and engine = 'v2';
    if pl.id is null or pl.status <> 'Approved' or not app.nut_cycle_open(pl.cycle_id) then raise exception 'This grocery list is closed.'; end if;
    wk := app.n0(p->'week')::int; key := left(app.clean(p->'item', 120), 120);
    if wk < 1 or wk > 3 or key = '' then raise exception 'Bad item'; end if;
    if app.truthy(p->'on') then
      insert into public.nutrition_grocery_ticks (client_id, plan_id, week, item_key) values (cu, pl.id, wk, key) on conflict do nothing;
    else
      delete from public.nutrition_grocery_ticks where client_id = cu and plan_id = pl.id and week = wk and item_key = key;
    end if;
  elsif op = 'reminders' then
    pr := coalesce((select prefs from public.nutrition_reminders where client_id = cu), '{}');
    if jsonb_typeof(p->'prefs') = 'object' then
      -- only known keys, times as HH:MM
      pr := jsonb_strip_nulls(jsonb_build_object(
        'meal', case when jsonb_typeof(p->'prefs'->'meal') = 'object' then jsonb_strip_nulls(jsonb_build_object('on', case when jsonb_typeof(p->'prefs'->'meal'->'on') = 'boolean' then p->'prefs'->'meal'->'on' end,
                  'times', (select jsonb_object_agg(k, x) from jsonb_each(case when jsonb_typeof(p->'prefs'->'meal'->'times') = 'object' then p->'prefs'->'meal'->'times' else '{}' end) e(k, x)
                             where k ~ '^[0-4]$' and x #>> '{}' ~ '^([01]\d|2[0-3]):[0-5]\d$'))) else pr->'meal' end,
        'water', case when jsonb_typeof(p->'prefs'->'water') = 'object' then jsonb_strip_nulls(jsonb_build_object('on', case when jsonb_typeof(p->'prefs'->'water'->'on') = 'boolean' then p->'prefs'->'water'->'on' end,
                  'every_h', case when app.n0(p->'prefs'->'water'->'every_h') between 1 and 4 then to_jsonb(app.n0(p->'prefs'->'water'->'every_h')::int) end)) else pr->'water' end,
        'prep', case when jsonb_typeof(p->'prefs'->'prep') = 'object' then jsonb_strip_nulls(jsonb_build_object('on', case when jsonb_typeof(p->'prefs'->'prep'->'on') = 'boolean' then p->'prefs'->'prep'->'on' end,
                  'day', case when p->'prefs'->'prep'->>'day' in ('mon','tue','wed','thu','fri','sat','sun') then p->'prefs'->'prep'->'day' end,
                  'time', case when p->'prefs'->'prep'->>'time' ~ '^([01]\d|2[0-3]):[0-5]\d$' then p->'prefs'->'prep'->'time' end)) else pr->'prep' end,
        'quiet', case when jsonb_typeof(p->'prefs'->'quiet') = 'object' and p->'prefs'->'quiet'->>'from' ~ '^([01]\d|2[0-3]):[0-5]\d$' and p->'prefs'->'quiet'->>'to' ~ '^([01]\d|2[0-3]):[0-5]\d$'
                      then jsonb_build_object('from', p->'prefs'->'quiet'->'from', 'to', p->'prefs'->'quiet'->'to')
                      when p->'prefs' ? 'quiet' then null else pr->'quiet' end));
    end if;
    snooze := app.js_num(p->'snooze_min');
    insert into public.nutrition_reminders (client_id, prefs, muted, snooze_until, updated_at)
    values (cu, pr, coalesce(case when jsonb_typeof(p->'mute') = 'boolean' then (p->>'mute')::boolean end, false),
            case when snooze > 0 then now() + make_interval(mins => least(snooze, 7 * 24 * 60)::int) end, now())
    on conflict (client_id) do update set prefs = excluded.prefs,
      muted = case when jsonb_typeof(p->'mute') = 'boolean' then (p->>'mute')::boolean else nutrition_reminders.muted end,
      snooze_until = case when snooze is null then nutrition_reminders.snooze_until when snooze > 0 then excluded.snooze_until else null end,
      updated_at = now();
  elsif op not in ('intake_get', 'get', 'calc') then
    raise exception 'Unknown action';
  end if;
  return out || app.nut_screen(cu, app.nut_intake(cu), today, op = 'intake_get');
end $$;

-- ---------------------------------------------------------------------
-- STAFF: the owner reviews (flagged clients, plans that failed the checks twice). Old action names kept.
-- ---------------------------------------------------------------------
-- app_nut_list { all? }: the owner's queue. Other staff get an empty list (plans no longer wait for coaches).
create or replace function public.api_app_nut_list(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); r public.nutrition_plans; out jsonb := '[]'; m jsonb;
begin
  if me->>'role' not in ('owner', 'system') then return jsonb_build_object('plans', '[]'::jsonb, 'owner_only', true); end if;
  for r in select * from public.nutrition_plans order by created_at desc, legacy_id desc loop
    continue when r.status !~ 'Pending|Coach review|Failed' and not app.truthy(p->'all');
    m := coalesce(r.macros, '{}');
    out := out || jsonb_build_array(jsonb_build_object('id', r.legacy_id, 'cid', app.legacy(r.client_id), 'name', (select name from public.clients where id = r.client_id),
      'status', r.status, 'created', app.stamp(r.created_at), 'error', coalesce(r.error, ''), 'engine', r.engine, 'reason', coalesce(r.review_reason, ''),
      'passed', coalesce((r.checks->>'passed')::boolean, null))
      || jsonb_strip_nulls(jsonb_build_object('kcal', m->'kcal', 'p', m->'p', 'c', m->'c', 'f', m->'f')));
    exit when jsonb_array_length(out) >= 100;
  end loop;
  return jsonb_build_object('plans', out, 'settings', coalesce(app.setting('{nutrition}'), '{}'));
end $$;

-- app_nut_get { cid, id? }: staff who see the client read it; only the owner decides
create or replace function public.api_app_nut_get(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', '')));
  it jsonb; prof jsonb; r public.nutrition_plans; today date := app_today(); c public.nutrition_cycles;
begin
  if cu is null then raise exception 'Client not found'; end if;
  if not app.nut_can_see(me, cu) then raise exception 'This client is not one of yours'; end if;
  it := app.nut_intake(cu); prof := app.nut_profile(cu, it, today); c := app.nut_cycle_last(cu);
  if app.truthy(p->'id') then select * into r from public.nutrition_plans where client_id = cu and legacy_id = p->>'id';
  else select * into r from public.nutrition_plans where client_id = cu and status <> 'Replaced' order by created_at desc, legacy_id desc limit 1; end if;
  return jsonb_strip_nulls(jsonb_build_object('cid', cid, 'name', (select name from public.clients where id = cu))) || jsonb_build_object('answers', it->'answers', 'flags', it->'flags', 'target', it->'target',
    'body', jsonb_build_object('weight', prof->'weight', 'height', prof->'height', 'age', prof->'age', 'sex', prof->'sex'),
    'calc', app.nut_numbers(prof, today),
    'plan', case when r.id is null then null else app.nut_plan_obj(r) || jsonb_build_object('engine', r.engine, 'review', r.review, 'reason', coalesce(r.review_reason, ''), 'checks', r.checks) end,
    'weighins', (select coalesce(jsonb_agg(x order by i), '[]') from jsonb_array_elements(app.nut_weighins(cu)) with ordinality t(x, i) where i > jsonb_array_length(app.nut_weighins(cu)) - 26),
    'paid', app.nut_cycle_state(c, today) in ('active', 'waiting'), 'cycle', app.nut_cycle_obj(c, today), 'tester', app.nut_is_tester(cu),
    'can_decide', me->>'role' in ('owner', 'system'), 'settings', coalesce(app.setting('{nutrition}'), '{}'), 'questions', app.nut_questions());
end $$;

-- app_nut_decide { cid, id, act: approve | decline | note | regen | fix, note, kcal/p/c/f (regen), plan (fix) }: OWNER only
create or replace function public.api_app_nut_decide(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner']); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); r public.nutrition_plans;
  act text := coalesce(p->>'act', ''); note text := app.clean(p->'note', 500); jnote text := app.clean_json(p->'note', 500); m jsonb; k text; v float8; it jsonb; lid text;
begin
  select * into r from public.nutrition_plans where client_id = cu and legacy_id = coalesce(p->>'id', '') for update;
  if r.id is null then raise exception 'Plan not found, refresh'; end if;
  if act = 'approve' then
    if r.status <> 'Pending' then raise exception 'Only a plan waiting for you can be approved (this one is %).', r.status; end if;
    if r.plan is null then raise exception 'This plan has no meals yet'; end if;
    update public.nutrition_plans set status = 'Approved', by_who = me->>'name', decided_at = now(), coach_note = coalesce(nullif(note, ''), coach_note), lease_until = null where id = r.id;
    if r.engine = 'v2' then perform app.nut_start_cycle(r.cycle_id); end if;     -- flagged clients: the 21 days start now
    perform app.nut_close_req(r.legacy_id, me->>'name', 'Done');
  elsif act = 'decline' then
    update public.nutrition_plans set status = 'Declined', by_who = me->>'name', decided_at = now(), coach_note = note, lease_until = null where id = r.id;
    perform app.nut_close_req(r.legacy_id, me->>'name', 'Declined');
  elsif act = 'note' then
    update public.nutrition_plans set coach_note = note where id = r.id;
  elsif act = 'regen' then
    if r.engine <> 'v2' then raise exception 'This is an old plan from the Apps Script. Start a new 3-week cycle for this client instead.'; end if;
    m := coalesce(r.macros, '{}');
    foreach k in array array['kcal', 'p', 'c', 'f'] loop
      v := app.js_num(p->k);
      if v > 0 then m := m || jsonb_build_object(k, app.jr(v), 'override', true); end if;
    end loop;
    if coalesce((m->>'kcal')::float8, 0) < 900 then raise exception 'Calories too low'; end if;
    it := app.nut_intake(cu);
    if note <> '' then it := jsonb_set(it, '{answers,coach_note}', to_jsonb(jnote)); perform app.nut_save_intake(cu, it); end if;
    update public.nutrition_plans set status = 'Replaced', lease_until = null where id = r.id;
    lid := app.next_legacy('NP', 'public.nutrition_plans', 4);
    insert into public.nutrition_plans (legacy_id, client_id, status, macros, intake_version, weight_at_plan, target, by_who, engine, cycle_id, review, review_reason)
    values (lid, cu, 'Queued', m, (it->>'ver')::int, r.weight_at_plan, r.target, me->>'name', 'v2', r.cycle_id, 'owner', 'Rewritten by ' || (me->>'name'));
    return jsonb_build_object('id', lid, 'status', 'Queued');
  elsif act = 'fix' then
    -- the owner's edited plan: checked again by the worker in code (no AI), then back here to approve
    if r.engine <> 'v2' then raise exception 'Only new plans can be edited'; end if;
    if jsonb_typeof(p->'plan') <> 'object' or jsonb_typeof(p->'plan'->'days') <> 'array' or jsonb_array_length(p->'plan'->'days') = 0 then raise exception 'Send the edited plan with its days'; end if;
    if pg_column_size(p->'plan') > 400000 then raise exception 'Plan too long'; end if;
    update public.nutrition_plans set status = 'Queued', job = 'recheck', draft = jsonb_build_object('fixed', p->'plan'), review = 'owner',
      review_reason = 'Edited by ' || (me->>'name'), coach_note = coalesce(nullif(note, ''), coach_note), lease_until = null, runs = 0 where id = r.id;
  else
    raise exception 'Unknown action';
  end if;
  return jsonb_build_object('id', r.legacy_id, 'status', (select status from public.nutrition_plans where id = r.id));
end $$;

-- app_nut_cycle { cid, act: grant | end | tester_on | tester_off, source: test | payment, note }: OWNER only
create or replace function public.api_app_nut_cycle(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner']); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); act text := coalesce(p->>'act', '');
  c public.nutrition_cycles; src text := case when p->>'source' = 'payment' then 'payment' else 'test' end; it jsonb; flags jsonb;
begin
  if cu is null then raise exception 'Client not found'; end if;
  perform pg_advisory_xact_lock(hashtext('nut:' || cu::text));
  c := app.nut_cycle_last(cu);
  if act = 'grant' then
    if app.nut_cycle_state(c, app_today()) in ('active', 'waiting') then raise exception 'This client already has an open 3-week cycle.'; end if;
    it := app.nut_intake(cu);
    flags := app.nut_flags((app.nut_profile(cu, it, app_today())->>'age')::int, it->'answers');
    c := app.nut_new_cycle(cu, src, me->>'name', jsonb_array_length(flags) > 0, app.clean(p->'note', 200));
    if src = 'test' then insert into public.nutrition_testers (client_id, added_by, note) values (cu, me->>'name', 'test cycle') on conflict do nothing; end if;
  elsif act = 'end' then
    if c.id is null then raise exception 'No cycle to end'; end if;
    update public.nutrition_cycles set status = 'cancelled', ends_on = case when starts_on is null then null else least(ends_on, greatest(starts_on, app_today())) end where id = c.id;
  elsif act = 'tester_on' then
    insert into public.nutrition_testers (client_id, added_by, note) values (cu, me->>'name', app.clean(p->'note', 200)) on conflict do nothing;
  elsif act = 'tester_off' then
    delete from public.nutrition_testers where client_id = cu;
  else
    raise exception 'Unknown action';
  end if;
  c := app.nut_cycle_last(cu);
  return jsonb_build_object('cycle', app.nut_cycle_obj(c, app_today()), 'tester', app.nut_is_tester(cu));
end $$;

-- app_nut_settings { paid_open? }: OWNER only. Opens or locks the paid plan for every client.
create or replace function public.api_app_nut_settings(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner']);
begin
  if jsonb_typeof(p->'paid_open') = 'boolean' then
    update public.settings set value = jsonb_set(value, '{paid_open}', p->'paid_open'), updated_at = now() where key = 'nutrition';
  end if;
  return jsonb_build_object('settings', app.setting('{nutrition}'));
end $$;

-- ---------------------------------------------------------------------
-- WORKER DOOR (edge function nutrition-worker, service role only). Never through the API.
-- ---------------------------------------------------------------------
drop function if exists public.wb_nut_claim(int);
-- takes one v2 plan to write (Queued, or Writing with an expired lease). Old Apps Script plans (v1) are never taken.
create or replace function public.wb_nut_claim(p_lease_s int default 240, p_recheck_only boolean default false) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.nutrition_plans; it jsonb; prof jsonb; mx int := coalesce(app.setting_int('{nutrition,runs_max}', 16), 16);
begin
  select * into r from public.nutrition_plans where engine = 'v2' and status in ('Queued', 'Writing') and (lease_until is null or lease_until < now())
     and (not p_recheck_only or job = 'recheck')                   -- no AI key yet: only the owner's edits are checked
   order by created_at, legacy_id limit 1 for update skip locked;
  if r.id is null then return null; end if;
  if r.runs >= mx then
    update public.nutrition_plans set status = 'Failed', error = 'Stopped after ' || r.runs || ' runs', lease_until = null where id = r.id;
    perform app.nut_tell_owner('Nutrition: the plan ' || r.legacy_id || ' could not be written. Open it in the staff app.');
    return jsonb_build_object('id', r.id, 'skip', true);
  end if;
  update public.nutrition_plans set status = 'Writing', writing_since = coalesce(writing_since, now()), lease_until = now() + make_interval(secs => greatest(30, p_lease_s)), runs = runs + 1
   where id = r.id;
  it := app.nut_intake(r.client_id); prof := app.nut_profile(r.client_id, it, app_today());
  return jsonb_build_object('id', r.id, 'legacy', r.legacy_id, 'macros', r.macros, 'answers', it->'answers', 'flags', app.nut_flags(app.n0(prof->'age')::int, it->'answers'),
    'draft', r.draft, 'job', r.job, 'attempts', r.attempts, 'review', r.review);
end $$;
-- progress between runs (one AI call per run)
create or replace function public.wb_nut_save(p_id uuid, p_draft jsonb) returns boolean language sql volatile security definer set search_path = public as $$
  update public.nutrition_plans set draft = p_draft, lease_until = null where id = p_id and status = 'Writing' returning true
$$;
-- the finished plan: shown at once when it passed and the client has no health flag, else to the owner
create or replace function public.wb_nut_finish(p_id uuid, p_plan jsonb, p_problems jsonb) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.nutrition_plans; it jsonb; flags jsonb; passed boolean := jsonb_array_length(coalesce(p_problems, '[]')) = 0; st text; why text[] := '{}'; nm text;
begin
  select * into r from public.nutrition_plans where id = p_id for update;
  if r.id is null or r.status <> 'Writing' then return jsonb_build_object('ignored', true); end if;   -- replaced or declined meanwhile
  it := app.nut_intake(r.client_id);
  flags := app.nut_flags((app.nut_profile(r.client_id, it, app_today())->>'age')::int, it->'answers');
  if jsonb_array_length(flags) > 0 then why := why || ('Health answers: ' || (select string_agg(x, ', ' order by i) from jsonb_array_elements_text(flags) with ordinality t(x, i))); end if;
  if not passed then why := why || ('Did not pass the code checks after a retry (' || jsonb_array_length(p_problems) || ' problems)'::text); end if;
  if r.review = 'owner' and jsonb_array_length(flags) = 0 and passed then why := why || coalesce(r.review_reason, 'Sent back to you'); end if;
  st := case when passed and coalesce(r.review, 'auto') = 'auto' and jsonb_array_length(flags) = 0 then 'Approved' else 'Pending' end;
  update public.nutrition_plans set plan = p_plan, status = st, draft = null, lease_until = null, error = null,
    checks = jsonb_build_object('passed', passed, 'problems', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(coalesce(p_problems, '[]')) x limit 50) z), 'at', now()),
    review = case when st = 'Approved' then 'auto' else 'owner' end,
    review_reason = case when st = 'Approved' then null else array_to_string(why, '. ') end,
    by_who = case when st = 'Approved' then 'auto check' else by_who end, decided_at = case when st = 'Approved' then now() else decided_at end
   where id = r.id;
  if st = 'Approved' then perform app.nut_start_cycle(r.cycle_id); end if;          -- normally already running
  if st = 'Pending' then
    nm := (select name from public.clients where id = r.client_id);
    perform app.nut_tell_owner('Nutrition plan to check for ' || nm || ': ' || array_to_string(why, '. ') || '. Open Nutrition plans in the staff app. Plan ' || r.legacy_id);
  end if;
  return jsonb_build_object('status', st, 'passed', passed);
end $$;
-- an AI error (or no answer): try again at the next run; after nutrition.ai_errors_max it is Failed and goes to the owner
create or replace function public.wb_nut_error(p_id uuid, p_error text) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.nutrition_plans; mx int := coalesce(app.setting_int('{nutrition,ai_errors_max}', 3), 3);
begin
  select * into r from public.nutrition_plans where id = p_id for update;
  if r.id is null or r.status <> 'Writing' then return jsonb_build_object('ignored', true); end if;
  if r.attempts + 1 >= mx then
    update public.nutrition_plans set status = 'Failed', attempts = r.attempts + 1, error = left(p_error, 500), lease_until = null, review = 'owner', review_reason = 'The AI could not write it' where id = r.id;
    perform app.nut_tell_owner('Nutrition: the AI could not write plan ' || r.legacy_id || ' (' || left(p_error, 120) || '). Regenerate it in the staff app.');
    return jsonb_build_object('status', 'Failed');
  end if;
  update public.nutrition_plans set status = 'Queued', attempts = r.attempts + 1, error = 'Try ' || (r.attempts + 1) || ' failed: ' || left(p_error, 400), lease_until = null where id = r.id;
  return jsonb_build_object('status', 'Queued');
end $$;
revoke execute on function public.wb_nut_claim(int, boolean), public.wb_nut_save(uuid, jsonb), public.wb_nut_finish(uuid, jsonb, jsonb), public.wb_nut_error(uuid, text) from public, anon, authenticated;
grant execute on function public.wb_nut_claim(int, boolean), public.wb_nut_save(uuid, jsonb), public.wb_nut_finish(uuid, jsonb, jsonb), public.wb_nut_error(uuid, text) to service_role;

-- clients read a plan only while it is approved AND its 3 weeks are running (old Apps Script plans: as before)
drop policy if exists nplan_read on public.nutrition_plans;
create policy nplan_read on public.nutrition_plans for select using (app.staff_sees_client(client_id)
  or (app.is_mine(client_id) and status = 'Approved' and (engine = 'v1' or app.nut_cycle_open(cycle_id))));

-- the new API functions join the door (0008 does it itself when it runs after this file, as in the local tests)
do $$ begin if to_regprocedure('app.api_sync()') is not null then perform app.api_sync(); end if; end $$;
