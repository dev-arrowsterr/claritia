"use client";

import { useEffect, useRef, useState } from "react";
import { isUse, MAX_STEP_TEXT, stepId, type BlockRef, type Step } from "@/lib/testfile";
import { Box, Grip, Plus, X } from "../Icons";
import { Select } from "./Select";
import { Button } from "./ui";

const KIND_LOOK = {
  do: "text-body shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  check: "bg-brand-soft text-brand shadow-[inset_0_0_0_1px_var(--color-brand-line)]",
};

/**
 * Plain-English steps, one per row. Enter adds a step below, Backspace on an empty step removes it,
 * Alt+Up and Alt+Down move a step, and rows can be dragged by their handle.
 */
export function StepsEditor({ steps, onChange, blocks, allowUse }: { steps: Step[]; onChange: (s: Step[]) => void; blocks: BlockRef[]; allowUse: boolean }) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focus, setFocus] = useState<{ id: string; at: "start" | "end" } | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const blockName = new Map(blocks.map((b) => [b.id, b.name]));

  useEffect(() => {
    if (!focus) return;
    const el = inputs.current.get(focus.id);
    if (el) {
      el.focus();
      const at = focus.at === "end" ? el.value.length : 0;
      el.setSelectionRange(at, at);
    }
  }, [focus, steps]);

  const update = (i: number, next: Step) => onChange(steps.map((s, j) => (j === i ? next : s)));
  const insert = (i: number, step: Step) => {
    onChange([...steps.slice(0, i), step, ...steps.slice(i)]);
    setFocus({ id: step.id, at: "end" });
  };
  const remove = (i: number) => {
    const before = steps[i - 1] ?? steps[i + 1];
    onChange(steps.filter((_, j) => j !== i));
    if (before) setFocus({ id: before.id, at: "end" });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
    setFocus({ id: item!.id, at: "end" });
  };

  return (
    <div className="flex flex-col">
      {steps.length ? (
        <ol className="flex flex-col border border-line bg-panel">
          {steps.map((s, i) => (
            <li
              key={s.id}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over !== i) setDrag({ ...drag, over: i });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) move(drag.from, drag.over);
                setDrag(null);
              }}
              className={`group flex items-center gap-2 border-b border-line px-2 py-1.5 last:border-b-0 ${drag?.from === i ? "opacity-40" : ""} ${drag && drag.over === i && drag.from !== i ? (drag.from < i ? "shadow-[inset_0_-2px_0_var(--color-brand)]" : "shadow-[inset_0_2px_0_var(--color-brand)]") : ""}`}
            >
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", s.id);
                  setDrag({ from: i, over: i });
                }}
                onDragEnd={() => setDrag(null)}
                aria-hidden="true"
                className="cursor-grab p-1 text-faint hover:text-ink active:cursor-grabbing"
                title="Drag to move"
              >
                <Grip size={14} />
              </span>
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-faint tabular-nums">{i + 1}</span>
              {isUse(s) ? (
                <>
                  <span className="inline-flex h-6 w-[62px] shrink-0 items-center justify-center rounded-sm bg-violet-soft font-mono text-[10px] font-medium tracking-[0.08em] text-violet uppercase">Use</span>
                  <span className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1 text-[13.5px]">
                    <Box size={14} className="text-violet" />
                    <span className={blockName.has(s.block) ? "font-medium" : "text-danger"}>{blockName.get(s.block) ?? "Missing block"}</span>
                  </span>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => update(i, { ...s, kind: s.kind === "do" ? "check" : "do" })}
                    title={s.kind === "do" ? "Make this a check" : "Make this an action"}
                    className={`inline-flex h-6 w-[62px] shrink-0 items-center justify-center rounded-sm font-mono text-[10px] font-medium tracking-[0.08em] uppercase ${KIND_LOOK[s.kind]}`}
                  >
                    {s.kind === "do" ? "Do" : "Check"}
                  </button>
                  <input
                    ref={(el) => {
                      if (el) inputs.current.set(s.id, el);
                      else inputs.current.delete(s.id);
                    }}
                    value={s.text}
                    maxLength={MAX_STEP_TEXT}
                    aria-label={`Step ${i + 1}`}
                    placeholder={s.kind === "check" ? "The page says Order confirmed" : "Click Add to cart"}
                    onChange={(e) => update(i, { ...s, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        insert(i + 1, { id: stepId(), kind: "do", text: "" });
                      } else if (e.key === "Backspace" && !s.text) {
                        e.preventDefault();
                        remove(i);
                      } else if (e.altKey && e.key === "ArrowUp") {
                        e.preventDefault();
                        move(i, i - 1);
                      } else if (e.altKey && e.key === "ArrowDown") {
                        e.preventDefault();
                        move(i, i + 1);
                      } else if (e.key === "ArrowUp" && !e.altKey && steps[i - 1]) {
                        e.preventDefault();
                        setFocus({ id: steps[i - 1]!.id, at: "end" });
                      } else if (e.key === "ArrowDown" && !e.altKey && steps[i + 1]) {
                        e.preventDefault();
                        setFocus({ id: steps[i + 1]!.id, at: "end" });
                      }
                    }}
                    className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[13.5px] text-ink outline-none placeholder:text-faint focus:bg-canvas"
                  />
                </>
              )}
              <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => remove(i)} className="rounded-md p-1.5 text-faint opacity-60 hover:bg-hover hover:text-danger group-hover:opacity-100 focus:opacity-100">
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => insert(steps.length, { id: stepId(), kind: "do", text: "" })}>
          <Plus size={13} />
          Step
        </Button>
        <Button variant="ghost" onClick={() => insert(steps.length, { id: stepId(), kind: "check", text: "" })}>
          <Plus size={13} />
          Check
        </Button>
        {allowUse && blocks.length ? (
          <Select
            value=""
            options={blocks.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(id) => onChange([...steps, { id: stepId(), kind: "use", block: id }])}
            placeholder="Use a block"
            plainPlaceholder
            ariaLabel="Use a block"
            className="h-8 rounded-md border border-line bg-panel px-3 text-[13px] font-medium text-ink hover:border-line-strong hover:bg-canvas"
          />
        ) : null}
      </div>
    </div>
  );
}
