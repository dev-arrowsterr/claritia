"use client";

// Settings › Team (supabase/migrations/044_crm.sql). People join by signing in with the invited email, as in
// Omniscient.

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
