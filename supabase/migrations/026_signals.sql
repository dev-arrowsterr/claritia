-- Signals sweep: claritia-intel checks each visit with an account once it has gone quiet, and again if it grows.
alter table public.sessions add column if not exists signaled_at timestamptz;
create index if not exists sessions_to_signal on public.sessions (ended_at) where account_id is not null and not internal and not is_bot;
