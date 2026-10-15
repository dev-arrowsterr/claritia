"use client";

// A panel that slides in from the right, for forms and wizards over a list.

import { useEffect } from "react";
import { Button } from "../ui";

export function SidePanel({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector('[role="listbox"]') && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-[80] bg-ink/10" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-label={title} className={`fixed inset-y-0 right-0 z-[81] flex w-full flex-col border-l border-line bg-panel ${wide ? "max-w-[760px]" : "max-w-[480px]"}`}>
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <h2 className="truncate text-[15px] font-medium">{title}</h2>
          <Button variant="ghost" className="ml-auto h-7 px-2.5" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer ? <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-canvas px-5 py-3">{footer}</div> : null}
      </aside>
    </>
  );
}

