// Form submits (docs/identity.md 5.4). Only `submit` is heard, never input or keys. One field is read: the email.
// Every other field stays in the browser.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /e-?mail/i;

/** Fields that are never read, even when they match. */
export function neverRead(el: Element): boolean {
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  return (
    (el as HTMLInputElement).type === "password" ||
    /^cc-|new-password|one-time-code/.test(ac) ||
    !!el.closest("[data-clr-ignore]")
  );
}

function labelSaysEmail(el: HTMLInputElement): boolean {
  const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent || "") : [];
  return [...labels, el.getAttribute("aria-label") || "", el.placeholder || ""].some((t) => NAME_RE.test(t));
}

/** Finds the email in a form or container, in the order of docs/identity.md 5.4. Returns "" when there is none. */
export function findEmail(root: ParentNode): string {
  const inputs = Array.from(root.querySelectorAll("input")).filter((el) => !neverRead(el));
  const tries: ((el: HTMLInputElement) => boolean)[] = [
    (el) => el.type === "email",
    (el) => (el.getAttribute("autocomplete") || "").toLowerCase() === "email",
    (el) => NAME_RE.test(el.name) || NAME_RE.test(el.id),
    (el) => el.type === "text" && labelSaysEmail(el),
  ];
  for (const t of tries) {
    const el = inputs.find(t);
    if (el) {
      const v = el.value.trim();
      return v.length <= 254 && EMAIL_RE.test(v) ? v : "";
    }
  }
  return "";
}

/** The form's name for reports: its id or name, or `data-clr-form`. Never its contents. */
export function formName(el: Element | null): string {
  if (!el) return "";
  return (el.getAttribute("data-clr-form") || el.id || el.getAttribute("name") || "").slice(0, 100);
}

/** Listens for submits and `data-clr-form` button clicks. `send` gets the email and the form name. */
export function watchForms(d: Document, send: (email: string, form: string) => void): void {
  d.addEventListener(
    "submit",
    (e) => {
      const f = e.target as HTMLFormElement;
      if (!f || f.closest("[data-clr-ignore]")) return;
      const email = findEmail(f);
      if (email) send(email, formName(f));
    },
    true,
  );
  // Forms sent with fetch from a button click never fire submit. The button carries data-clr-form.
  d.addEventListener(
    "click",
    (e) => {
      const b = (e.target as Element)?.closest?.("[data-clr-form]");
      if (!b || b.closest("form")) return;
      let root: Element | null = b;
      for (let i = 0; i < 5 && root; i++, root = root.parentElement) {
        const email = findEmail(root);
        if (email) return send(email, formName(b));
      }
    },
    true,
  );
}
