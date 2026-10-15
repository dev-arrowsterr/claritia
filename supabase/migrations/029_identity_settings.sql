-- Settings › Identity (docs/identity.md Part 13): owners set their own and partner domains. The identify secrets are
-- written by /api/identity-secret, which seals them.
create or replace function public.set_identity_domains(p_ws uuid, p_own text[], p_partner text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can change this';
  end if;
  if cardinality(p_own) > 20 or cardinality(p_partner) > 200 then
    raise exception 'Too many domains';
  end if;
  insert into identity_settings (workspace_id, own_domains, partner_domains, updated_at)
  values (p_ws, coalesce(p_own, '{}'), coalesce(p_partner, '{}'), now())
  on conflict (workspace_id) do update set own_domains = excluded.own_domains, partner_domains = excluded.partner_domains, updated_at = now();
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'identity.domains', p_ws::text);
end;
$$;
revoke execute on function public.set_identity_domains(uuid, text[], text[]) from public, anon;
grant execute on function public.set_identity_domains(uuid, text[], text[]) to authenticated;
