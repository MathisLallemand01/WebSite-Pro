create table if not exists public.reviews (
  id bigint generated always as identity primary key,
  name text not null,
  role text not null default 'Client',
  rating int not null check (rating between 1 and 5),
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists reviews_created_at_idx on public.reviews (created_at desc);
