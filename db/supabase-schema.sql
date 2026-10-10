create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  contact text not null,
  pet text,
  message text,
  source text default 'pets-landing',
  status text not null default 'new'
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);

alter table public.leads enable row level security;

create policy "anon can insert leads" on public.leads
  for insert
  to anon
  with check (true);
