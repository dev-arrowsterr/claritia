"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useState } from "react";
import { Logo } from "../Logo";
import { Button, ErrorNote, errorText, postJson, type Workspace } from "./ui";

const ACK_MS = 4000;

/**
 * app.tryclaritia.com/extension: connects the Chrome recorder to this workspace in one click. Makes an API key named
 * "Chrome recorder" and hands it to the extension through the page (the extension only takes it from this site). If
 * the extension doesn't answer, the key is revoked again.
 */
export function ConnectExtension({ sb, session, ws }: { sb: SupabaseClient; session: Session; ws: Workspace }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  const connect = async () => {
    setState("busy");
    setError("");
    try {
      const { id, key } = await postJson<{ id: string; key: string }>(session, "/api/keys", { workspaceId: ws.id, name: "Chrome recorder" });
      const acked = await new Promise<boolean>((resolve) => {
        const onMessage = (e: MessageEvent) => {
          if (e.source !== window || e.origin !== window.location.origin || e.data?.type !== "claritia-recorder-connected") return;
          window.removeEventListener("message", onMessage);
          resolve(e.data.ok === true);
        };
        window.addEventListener("message", onMessage);
        window.postMessage({ type: "claritia-recorder-connect", key, app: window.location.origin }, window.location.origin);
        setTimeout(() => {
          window.removeEventListener("message", onMessage);
          resolve(false);
        }, ACK_MS);
      });
      if (!acked) {
        await sb.rpc("revoke_api_key", { p_key: id });
        throw new Error("The Claritia Recorder didn't answer. Check it's installed and turned on in chrome://extensions, reload this page, and try again.");
      }
      setState("done");
      setTimeout(() => window.close(), 1500);
    } catch (e) {
      setError(errorText(e));
      setState("idle");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex w-full max-w-md flex-col gap-4 border border-line bg-panel p-7">
        <Logo />
        <h1 className="text-[18px] font-medium">Connect the Claritia Recorder</h1>
        <p className="text-[13.5px] text-muted">
          {ws.name} · {session.user.email}
        </p>
        {state === "done" ? (
          <p className="text-[14px] font-medium">Connected. Open the recorder from Chrome&apos;s toolbar.</p>
        ) : (
          <Button onClick={connect} disabled={state === "busy"}>
            {state === "busy" ? "Connecting…" : "Connect Claritia Recorder"}
          </Button>
        )}
        <ErrorNote message={error} />
      </div>
    </main>
  );
}
