"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui";

// The app's own pop-up questions, in place of the browser's prompt, confirm and alert boxes.
// Call askText, askConfirm or tell from anywhere; <DialogHost /> (mounted once) shows them.

type Request =
  | { kind: "text"; title: string; initial: string; placeholder?: string; ok: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; body?: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "tell"; title: string; body?: string; resolve: () => void };

let show: ((r: Request) => void) | null = null;
const queue: Request[] = [];
const send = (r: Request) => (show ? show(r) : queue.push(r));

export const askText = (title: string, opts: { initial?: string; placeholder?: string; ok?: string } = {}) =>
  new Promise<string | null>((resolve) => send({ kind: "text", title, initial: opts.initial ?? "", placeholder: opts.placeholder, ok: opts.ok ?? "Save", resolve }));

export const askConfirm = (title: string, opts: { body?: string; ok?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => send({ kind: "confirm", title, body: opts.body, ok: opts.ok ?? "Continue", danger: opts.danger ?? false, resolve }));

export const tell = (title: string, body?: string) => new Promise<void>((resolve) => send({ kind: "tell", title, body, resolve }));

export function DialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    show = (r) => {
      setReq(r);
      if (r.kind === "text") setText(r.initial);
    };
    const waiting = queue.shift();
    if (waiting) show(waiting);
    return () => {
      show = null;
    };
  }, []);

  if (!req) return null;
  const finish = (answer: boolean) => {
    if (req.kind === "text") req.resolve(answer && text.trim() ? text.trim() : null);
    else if (req.kind === "confirm") req.resolve(answer);
    else req.resolve();
    const next = queue.shift() ?? null;
    setReq(next);
    if (next?.kind === "text") setText(next.initial);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-ink/20 px-4 pt-[15vh]"
      onMouseDown={() => finish(false)}
      onKeyDown={(e) => e.key === "Escape" && finish(false)}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        className="w-full max-w-md overflow-hidden frame bg-panel shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <div className="space-y-3 p-5">
          <h2 className="text-[15px] font-medium">{req.title}</h2>
          {"body" in req && req.body ? <p className="text-[13px] leading-relaxed text-muted">{req.body}</p> : null}
          {req.kind === "text" ? (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={req.placeholder}
              maxLength={120}
              className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] outline-none focus:border-ink"
            />
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line bg-canvas px-5 py-3">
          {req.kind !== "tell" ? (
            <Button type="button" variant="plain" onClick={() => finish(false)}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="submit"
            autoFocus={req.kind !== "text"}
            disabled={req.kind === "text" && !text.trim()}
            className={req.kind === "confirm" && req.danger ? "bg-red-600 hover:bg-red-700" : ""}
          >
            {req.kind === "tell" ? "OK" : req.ok}
          </Button>
        </div>
      </form>
    </div>
  );
}
