-- Company match by IP (docs/m1-website-intelligence.md 7.1): each visitor's own IP is looked up, and a whole network
-- gets a company only when 3 different IPs in it agree. Until now one stand-in address per /24 was looked up and its
-- company given to everyone on that /24, which tags people on shared office and broadband blocks with the wrong company.

-- scope: 'ip' is one IP (key = HMAC of the IP), 'net' is a network's verdict (key = sha256 of the network),
-- 'legacy' is a row from the old stand-in lookups. Only 'net' rows set accounts for a whole network, so legacy rows
-- stop setting accounts now and age out of the 30-day cache.
alter table public.ip_cache add column if not exists scope text;
update public.ip_cache set scope = 'legacy' where scope is null;
alter table public.ip_cache alter column scope set default 'ip';
alter table public.ip_cache alter column scope set not null;
alter table public.ip_cache drop constraint if exists ip_cache_scope_check;
alter table public.ip_cache add constraint ip_cache_scope_check check (scope in ('ip', 'net', 'legacy'));
create index if not exists ip_cache_net on public.ip_cache (net, scope, fetched_at desc);

-- The account from the visit's own IP, kept beside the network's, so re-resolving a visit later keeps it.
alter table public.sessions add column if not exists ip_account_id uuid;
