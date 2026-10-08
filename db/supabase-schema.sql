-- ============================================================
-- Waylen Travel — схема базы данных для заявок с лендинга
-- Выполнить целиком в Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  contact text not null,
  pet text,
  message text,
  source text default 'pets-landing',
  status text not null default 'new'  -- new / contacted / done
);

-- Индекс для быстрой сортировки по дате в личном кабинете/дашборде
create index if not exists leads_created_at_idx on public.leads (created_at desc);

-- Row Level Security: включаем, но не даём анонимному ключу ничего делать напрямую.
-- Запись происходит только через серверную функцию (api/submit-lead.js),
-- которая использует service_role ключ и обходит RLS — это безопасно,
-- потому что service_role ключ никогда не попадает в браузер.
alter table public.leads enable row level security;

-- Разрешаем анонимному ключу (используется прямо в браузере, на фронтенде)
-- только СОЗДАВАТЬ заявки — никакого чтения, изменения или удаления.
-- Именно поэтому этот ключ безопасно хранить прямо в коде сайта.
create policy "anon can insert leads" on public.leads
  for insert
  to anon
  with check (true);

