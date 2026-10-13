"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown } from "../Icons";

export type Option<T extends string | number> = { value: T; label: string };

/**
 * The app's own dropdown, so menus look the same on every computer. The menu opens in a layer above the
 * page, so tables and scrolling panels never cut it off.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
  ariaLabel,
  placeholder = "Choose…",
  autoOpen = false,
  onClose,
  disabled = false,
  plainPlaceholder = false,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  autoOpen?: boolean;
  onClose?: () => void;
  disabled?: boolean;
  /** Show the placeholder in normal text, for a menu that works like a button. */
  plainPlaceholder?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value);

  const close = (focus = true) => {
    setOpen(false);
    onClose?.();
    if (focus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      const r = button.current!.getBoundingClientRect();
      const height = Math.min(280, options.length * 32 + 8);
      const up = r.bottom + height + 8 > window.innerHeight && r.top > height + 8;
      setPos({ left: r.left, top: up ? r.top - height - 4 : r.bottom + 4, width: Math.max(r.width, 160), up });
    };
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  });

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pickAt = (i: number) => {
    const o = options[i];
    if (!o) return;
    close();
    if (o.value !== value) onChange(o.value);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus={autoOpen}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          } else if (open) {
            if (e.key === "Escape" || e.key === "Tab") close(e.key === "Escape");
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(options.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pickAt(active);
            }
          }
        }}
        className={`inline-flex items-center justify-between gap-2 text-left ${className}`}
      >
        <span className={`truncate ${current || plainPlaceholder ? "" : "text-faint"}`}>{current?.label ?? placeholder}</span>
        <ChevronsUpDown size={13} className="shrink-0 text-faint" />
      </button>
      {open && pos
        ? createPortal(
            <ul
              ref={menu}
              role="listbox"
              aria-label={ariaLabel}
              style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: 280 }}
              className="z-[100] overflow-y-auto border border-line bg-panel p-1 text-[13px] shadow-pop"
            >
              {options.map((o, i) => (
                <li
                  key={String(o.value)}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickAt(i)}
                  className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 whitespace-nowrap ${i === active ? "bg-hover" : ""}`}
                >
                  <span className="flex-1">{o.label}</span>
                  {o.value === value ? <Check size={13} className="text-brand" /> : <span className="w-[13px]" />}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}
