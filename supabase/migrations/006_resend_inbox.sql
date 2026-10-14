-- Test inboxes receive mail through Resend. Its email id is kept, so an email posted twice is saved once.
alter table public.inbox_messages add column if not exists external_id text;
create unique index if not exists inbox_messages_external on public.inbox_messages (external_id);
