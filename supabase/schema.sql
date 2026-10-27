-- IMPORTANT: Run this in a NEW Supabase project or review carefully before applying to an existing DB.
create extension if not exists pgcrypto;

do $$ begin
  create type public.appointment_status as enum ('waiting','serving','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_kind as enum ('scheduled','live');
exception when duplicate_object then null; end $$;

create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Працівник',
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_link_codes (
  code text primary key,
  chat_id text not null,
  telegram_user_id text,
  telegram_username text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists telegram_link_codes_expiry on public.telegram_link_codes(expires_at);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  queue_number integer not null,
  full_name text not null,
  phone text not null,
  telegram_username text,
  telegram_chat_id text,
  service text not null check (service in ('ID-картка','Закордонний паспорт','Реєстрація місця проживання','Зняття з реєстрації місця проживання','Вклеювання фото','Довідки','Консультація')),
  visit_date date not null,
  booking_type public.booking_kind not null,
  appointment_time time,
  notes text,
  status public.appointment_status not null default 'waiting',
  telegram_reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_type_time_ck check ((booking_type='scheduled' and appointment_time is not null) or (booking_type='live' and appointment_time is null))
);
create unique index if not exists appointments_scheduled_slot_unique on public.appointments(visit_date, appointment_time) where booking_type='scheduled' and status <> 'cancelled';
create unique index if not exists appointments_queue_number_unique on public.appointments(visit_date, queue_number);
create index if not exists appointments_queue_day_idx on public.appointments(visit_date, status, queue_number);

alter table public.staff enable row level security;
alter table public.appointments enable row level security;
alter table public.telegram_link_codes enable row level security;

-- Public display intentionally exposes no names, phone numbers, Telegram identifiers, comments, or service details.
create or replace view public.public_queue as
 select queue_number, visit_date, status, booking_type, appointment_time, created_at
 from public.appointments
 where status <> 'cancelled';
grant select on public.public_queue to anon, authenticated;
grant select on public.appointments to authenticated;
grant select on public.staff to authenticated;

 drop policy if exists "staff can read own staff record" on public.staff;
create policy "staff can read own staff record" on public.staff for select to authenticated using (user_id = auth.uid());
drop policy if exists "staff can read appointments" on public.appointments;
create policy "staff can read appointments" on public.appointments for select to authenticated using (exists(select 1 from public.staff s where s.user_id=auth.uid()));
-- No direct browser insert/update/delete; writes go through checked Edge Functions.
revoke insert, update, delete on public.appointments from anon, authenticated;
revoke all on public.telegram_link_codes from anon, authenticated;

-- Helper verifies office day/time. Each appointment slot occupies 20 minutes (conservative within requested 10–20 min range).
create or replace function public.office_closing_time(p_date date) returns time
language sql immutable as $$ select case when extract(isodow from p_date)=5 then time '15:45' else time '17:00' end $$;

create or replace function public.get_available_slots(p_date date)
returns table(slot_time text)
language plpgsql security definer set search_path=public as $$
declare v_mins integer := 20; v_end time; v_now timestamp := now() at time zone 'Europe/Kyiv'; v_start timestamp; v_stop timestamp; v_t timestamp;
begin
  if p_date is null or p_date < (now() at time zone 'Europe/Kyiv')::date or extract(isodow from p_date) not between 1 and 5 then return; end if;
  v_end := public.office_closing_time(p_date);
  for v_start,v_stop in select p_date + time '08:00', p_date + time '13:00' - make_interval(mins=>v_mins)
    union all select p_date + time '13:45', p_date + v_end - make_interval(mins=>v_mins)
  loop
    v_t := v_start;
    while v_t <= v_stop loop
      if (p_date > v_now::date or v_t > v_now) and not exists (
        select 1 from public.appointments a where a.visit_date=p_date and a.booking_type='scheduled' and a.appointment_time=v_t::time and a.status <> 'cancelled'
      ) then slot_time := to_char(v_t,'HH24:MI'); return next; end if;
      v_t := v_t + make_interval(mins=>v_mins);
    end loop;
  end loop;
end $$;
grant execute on function public.get_available_slots(date) to anon, authenticated;

-- Atomic booking: serializes queue number allocation per date and consumes Telegram pairing code in the same transaction.
create or replace function public.create_appointment(
  p_full_name text, p_phone text, p_telegram_code text, p_telegram_username text, p_service text,
  p_visit_date date, p_booking_type text, p_appointment_time text, p_notes text
) returns table(id uuid, queue_number integer, visit_date date, booking_type text, appointment_time text, service text, telegram_chat_id text)
language plpgsql security definer set search_path=public as $$
declare v_queue integer; v_time time; v_chat_id text := null; v_code text; v_code_username text := null;
  v_today date := (now() at time zone 'Europe/Kyiv')::date;
  v_clock time := (now() at time zone 'Europe/Kyiv')::time;
  v_close time;
begin
  if p_full_name is null or length(trim(p_full_name)) < 3 or length(p_full_name)>150 then raise exception 'Вкажіть коректне ПІБ.'; end if;
  if p_phone is null or length(trim(p_phone)) < 7 or length(p_phone)>30 then raise exception 'Вкажіть коректний телефон.'; end if;
  if p_service not in ('ID-картка','Закордонний паспорт','Реєстрація місця проживання','Зняття з реєстрації місця проживання','Вклеювання фото','Довідки','Консультація') then raise exception 'Невідома послуга.'; end if;
  if p_visit_date < v_today then raise exception 'Не можна записатися на минулу дату.'; end if;
  if extract(isodow from p_visit_date) not between 1 and 5 then raise exception 'Запис доступний лише у робочі дні.'; end if;
  v_close := public.office_closing_time(p_visit_date);
  if p_booking_type = 'scheduled' then
    if p_appointment_time is null or p_appointment_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Оберіть час зі списку.'; end if;
    v_time := p_appointment_time::time;
    if not exists(select 1 from public.get_available_slots(p_visit_date) s where s.slot_time=to_char(v_time,'HH24:MI')) then raise exception 'Цей час уже зайнятий або недоступний. Оновіть список вільних годин.'; end if;
  elsif p_booking_type = 'live' then
    if p_visit_date <> v_today then raise exception 'Жива черга доступна лише на сьогодні.'; end if;
    if not ((v_clock >= time '08:00' and v_clock < time '13:00') or (v_clock >= time '13:45' and v_clock < v_close)) then raise exception 'Жива черга доступна лише в години прийому.'; end if;
    v_time := null;
  else raise exception 'Невідомий формат запису.'; end if;

  if p_telegram_code is not null and length(trim(p_telegram_code))>0 then
    v_code := upper(trim(p_telegram_code));
    select c.chat_id, c.telegram_username into v_chat_id, v_code_username from public.telegram_link_codes c where c.code=v_code and c.expires_at>now() and c.consumed_at is null for update;
    if v_chat_id is null then raise exception 'Код Telegram не знайдено або він прострочений. Надішліть боту /start для нового коду.'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_visit_date::text));
  select coalesce(max(a.queue_number),0)+1 into v_queue from public.appointments a where a.visit_date=p_visit_date;
  insert into public.appointments(queue_number,full_name,phone,telegram_username,telegram_chat_id,service,visit_date,booking_type,appointment_time,notes)
    values(v_queue,trim(p_full_name),trim(p_phone),coalesce(nullif(trim(coalesce(p_telegram_username,'')),''),v_code_username),v_chat_id,p_service,p_visit_date,p_booking_type,v_time,nullif(trim(coalesce(p_notes,'')),''))
    returning appointments.id, appointments.queue_number, appointments.visit_date, appointments.booking_type::text,
      case when appointments.appointment_time is null then null else to_char(appointments.appointment_time,'HH24:MI') end,
      appointments.service, appointments.telegram_chat_id
    into id,queue_number,visit_date,booking_type,appointment_time,service,telegram_chat_id;
  if v_code is not null then update public.telegram_link_codes set consumed_at=now() where code=v_code; end if;
  return next;
end $$;
revoke all on function public.create_appointment(text,text,text,text,text,date,text,text,text) from public, anon, authenticated;
grant execute on function public.create_appointment(text,text,text,text,text,date,text,text,text) to service_role;

-- Record update timestamp trigger.
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists appointments_touch_updated_at on public.appointments;
create trigger appointments_touch_updated_at before update on public.appointments for each row execute function public.touch_updated_at();
