"use client";

// Settings › Team and Settings › Sending domains (supabase/migrations/039_crm.sql). People join by signing in with
// the invited email, as in Omniscient. Domains are checked once the send pipeline is in.

import { useState } from "react";
import { Plus, Trash } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Avatar, Badge, Button, CardHead, ErrorNote, errorText, Loading, must, Panel, Td, Th, timeAgo, useLoad, type Role, type ViewProps } from "../ui";

type Member = {
  user_id: string | null;
  email: string;
  role: string;
  joined_at: string;
  pending: boolean;
  invite_id: string | null;
};

export function TeamPanel({ sb, ws, role, session }: Pick<ViewProps, "sb" | "ws" | "session"> & { role: Role }) {
  const team = useLoad(async () => must(await sb.rpc("team", { p_ws: ws.id })) as Member[], ws.id);
  const [error, setError] = useState("");
  const owner = role === "owner";
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      team.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const invite = () =>
    act(async () => {
      const email = await askText("Invite a teammate", {
        placeholder: "name@company.com",
        ok: "Invite",
      });
      if (email) must(await sb.rpc("invite_member", { p_ws: ws.id, p_email: email }));
    });
  const remove = (m: Member) =>
    act(async () => {
      if (
        !(await askConfirm(m.pending ? `Cancel the invite for ${m.email}?` : `Remove ${m.email}?`, {
          ok: m.pending ? "Cancel invite" : "Remove",
          danger: true,
        }))
      )
        return;
      if (m.pending) must(await sb.rpc("cancel_invite", { p_id: m.invite_id }));
      else must(await sb.rpc("member_remove", { p_ws: ws.id, p_user: m.user_id }));
    });
  return (
    <Panel>
      <CardHead label="Team" count={team.data?.filter((m) => !m.pending).length}>
        {owner ? (
          <Button variant="ghost" className="h-7 px-2.5" onClick={invite}>
            <Plus size={13} />
            Invite
          </Button>
        ) : null}
      </CardHead>
      <ErrorNote message={error || team.error} />
      {!team.data ? (
        team.error ? null : (
          <Loading />
        )
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Since</Th>
              <Th className="w-12">{""}</Th>
            </tr>
          </thead>
          <tbody>
            {team.data.map((m) => (
              <tr key={m.invite_id ?? m.user_id}>
                <Td>
                  <span className="flex items-center gap-2.5">
                    <Avatar label={m.email} />
                    <span className="truncate">{m.email}</span>
                    {m.user_id === session.user.id ? <span className="text-[12px] text-faint">you</span> : null}
                  </span>
                </Td>
                <Td>{m.pending ? <Badge tone="amber">Invited</Badge> : <Badge tone={m.role === "owner" ? "brand" : "gray"}>{m.role}</Badge>}</Td>
                <Td className="font-mono text-[12px] text-muted">{timeAgo(m.joined_at)}</Td>
                <Td className="text-right">
                  {owner && m.role !== "owner" ? (
                    <button
                      type="button"
                      aria-label={m.pending ? "Cancel invite" : "Remove"}
                      title={m.pending ? "Cancel invite" : "Remove"}
                      onClick={() => remove(m)}
                      className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger"
                    >
                      <Trash size={13} />
                    </button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

type Domain = {
  id: string;
  domain: string;
  status: "unverified" | "verified" | "failed";
  checked_at: string | null;
  created_at: string;
};
const DOMAIN_TONE = {
  unverified: "amber",
  verified: "green",
  failed: "red",
} as const;

export function DomainsPanel({ sb, ws, role }: Pick<ViewProps, "sb" | "ws"> & { role: Role }) {
  const list = useLoad(
    async () =>
      must(await sb.from("sending_domains").select("id, domain, status, checked_at, created_at").eq("workspace_id", ws.id).order("created_at")) as Domain[],
    ws.id,
  );
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const owner = role === "owner";
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      list.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const add = () =>
    act(async () => {
      const domain = await askText("Add a sending domain", {
        placeholder: "mail.example.com",
        ok: "Add",
      });
      if (domain) must(await sb.rpc("sending_domain_add", { p_ws: ws.id, p_domain: domain }));
    });
  const remove = (ids: string[]) =>
    act(async () => {
      const n = ids.length;
      if (!(await askConfirm(n === 1 ? `Remove ${list.data?.find((d) => d.id === ids[0])?.domain}?` : `Remove ${n} domains?`, { ok: "Remove", danger: true })))
        return;
      must(await sb.rpc("sending_domains_delete", { p_ws: ws.id, p_ids: ids }));
      setPicked(new Set());
    });
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  return (
    <Panel>
      <CardHead label="Sending domains" count={list.data?.length}>
        {owner && picked.size ? (
          <Button variant="danger" className="h-7 px-2.5" onClick={() => remove([...picked])}>
            <Trash size={13} />
            Remove {picked.size}
          </Button>
        ) : null}
        {owner ? (
          <Button variant="ghost" className="h-7 px-2.5" onClick={add}>
            <Plus size={13} />
            Add domain
          </Button>
        ) : null}
      </CardHead>
      <ErrorNote message={error || list.error} />
      {!list.data ? (
        list.error ? null : (
          <Loading />
        )
      ) : !list.data.length ? (
        <p className="px-4 py-3 text-[13px] text-faint">—</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {owner ? <Th className="w-10">{""}</Th> : null}
              <Th>Domain</Th>
              <Th>Status</Th>
              <Th>Added</Th>
              <Th className="w-12">{""}</Th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id}>
                {owner ? (
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Pick ${d.domain}`}
                      checked={picked.has(d.id)}
                      onChange={() => toggle(d.id)}
                      className="size-3.5 accent-ink"
                    />
                  </Td>
                ) : null}
                <Td className="font-mono text-[12.5px]">{d.domain}</Td>
                <Td>
                  <Badge tone={DOMAIN_TONE[d.status]}>{d.status}</Badge>
                </Td>
                <Td className="font-mono text-[12px] text-muted">{timeAgo(d.created_at)}</Td>
                <Td className="text-right">
                  {owner ? (
                    <button
                      type="button"
                      aria-label="Remove"
                      title="Remove"
                      onClick={() => remove([d.id])}
                      className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger"
                    >
                      <Trash size={13} />
                    </button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
