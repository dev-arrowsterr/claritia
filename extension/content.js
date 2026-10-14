// Claritia Recorder: the part that runs in the page. While the tab is recording, it turns clicks, typing, choices and
// Enter into steps: plain English for people, and one Playwright line each for Claritia to replay. In check mode the
// next click doesn't click: it records a check that the element shows. Passwords are never recorded, only the name of
// the secret that holds them (process.env.PASSWORD).
(() => {
  if (window.__claritiaRecorder) return;
  window.__claritiaRecorder = true;

  let recording = false;
  let mode = "record";
  const filled = new WeakMap();

  const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ")}'`;
  const say = (s) => `"${s.length > 50 ? `${s.slice(0, 47)}…` : s}"`;
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  const TEXT_INPUT = /^(text|email|password|search|tel|url|number|date|datetime-local|month|week|time)$/;
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "button" || (tag === "input" && /^(submit|button|reset)$/.test(type))) return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "select") return "combobox";
    if (tag === "textarea" || (tag === "input" && TEXT_INPUT.test(type))) return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    return null;
  }
  function labelOf(el) {
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    return "";
  }
  function nameOf(el, role) {
    const label = labelOf(el);
    if (label) return label;
    if (role === "textbox" || role === "combobox") return "";
    if (el.tagName === "INPUT") return clean(el.value);
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"));
    const t = clean(el.textContent) || clean(el.querySelector("img")?.getAttribute("alt")) || clean(el.getAttribute("title"));
    return t.length <= 80 ? t : "";
  }
  const all = () => [...document.querySelectorAll("body *")];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // ".nth(i)" when several elements match, so the line still points at this one.
  const pick = (matches, el, base) => {
    const i = matches.indexOf(el);
    return matches.length > 1 && i >= 0 ? `${base}.nth(${i})` : base;
  };

  /** The best Playwright locator for an element, and how it reads in a step. */
  function locate(el) {
    const testId = el.getAttribute("data-testid");
    if (testId) return { code: `page.getByTestId(${q(testId)})`, text: `the ${testId} element` };
    const role = roleOf(el);
    const name = role ? nameOf(el, role) : "";
    if (role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio") {
      const label = labelOf(el);
      if (label) {
        const same = all().filter((x) => roleOf(x) === role && labelOf(x) === label && visible(x));
        return { code: pick(same, el, `page.getByLabel(${q(label)}, { exact: true })`), text: `the ${say(label)} ${role === "textbox" || role === "combobox" ? "field" : role}` };
      }
      const ph = el.getAttribute("placeholder");
      if (ph) return { code: `page.getByPlaceholder(${q(ph)})`, text: `the ${say(ph)} field` };
    }
    if (role && name) {
      const same = all().filter((x) => roleOf(x) === role && nameOf(x, role) === name && visible(x));
      return { code: pick(same, el, `page.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`), text: `the ${say(name)} ${role === "textbox" ? "field" : role}` };
    }
    const own = clean(el.textContent);
    if (own && own.length <= 50) {
      const same = all().filter((x) => clean(x.textContent) === own && visible(x) && ![...x.children].some((c) => clean(c.textContent) === own));
      return { code: pick(same, el, `page.getByText(${q(own)}, { exact: true })`), text: say(own) };
    }
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return { code: `page.locator(${q(`#${el.id}`)})`, text: `the ${el.id} element` };
    const path = [];
    for (let n = el; n && n !== document.body && path.length < 4; n = n.parentElement) {
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      path.unshift(sibs.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${sibs.indexOf(n) + 1})` : n.tagName.toLowerCase());
    }
    return { code: `page.locator(${q(path.join(" > "))})`, text: `the ${el.tagName.toLowerCase()} element` };
  }

  function send(step) {
    try {
      chrome.runtime.sendMessage({ type: "step", step });
    } catch {
      // The extension was reloaded; this page's recorder is stale.
    }
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function recordFill(el) {
    const value = el.value;
    if (filled.get(el) === value) return;
    filled.set(el, value);
    const t = locate(el);
    const secret = el.type === "password";
    const arg = secret ? "process.env.PASSWORD" : q(value);
    send({ kind: "do", text: `Type ${secret ? "process.env.PASSWORD" : say(value)} into ${t.text}`, code: [`await ${t.code}.fill(${arg});`], key: t.code });
  }

  // Check mode: outline what's under the pointer.
  let outlined = null;
  const unoutline = () => {
    if (outlined) outlined.style.outline = outlined.__claritiaOutline ?? "";
    outlined = null;
  };
  document.addEventListener(
    "mouseover",
    (e) => {
      if (!recording || mode !== "check") return unoutline();
      unoutline();
      outlined = e.target;
      outlined.__claritiaOutline = outlined.style.outline;
      outlined.style.outline = "2px solid #266df0";
    },
    true,
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      if (mode === "check") {
        e.preventDefault();
        e.stopPropagation();
        unoutline();
        const target = el.closest("button, a, input, select, textarea, h1, h2, h3, h4, h5, h6, label, [role], [data-testid]") ?? el;
        const t = locate(target);
        send({ kind: "check", text: `${cap(t.text)} shows`, code: [`await expect(${t.code}).toBeVisible();`], checkDone: true });
        return;
      }
      // Typing, ticking and choosing are recorded from their own events.
      const control = el.closest("input, select, textarea, option");
      if (control) {
        const type = (control.getAttribute("type") || "").toLowerCase();
        if (control.tagName !== "INPUT" || !/^(submit|button|reset|image)$/.test(type)) return;
      }
      const label = el.closest("label");
      if (label && (label.control || label.querySelector("input, select, textarea"))) return;
      const target = el.closest("button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], input[type=submit], input[type=button], [data-testid]") ?? el;
      const t = locate(target);
      send({ kind: "do", text: `Click ${t.text}`, code: [`await ${t.code}.click();`] });
    },
    true,
  );

  document.addEventListener(
    "change",
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const role = roleOf(el);
      const t = locate(el);
      if (role === "checkbox" || role === "radio") {
        send({ kind: "do", text: `${el.checked ? "Tick" : "Untick"} ${t.text}`, code: [`await ${t.code}.${el.checked ? "check" : "uncheck"}();`] });
      } else if (el.tagName === "SELECT") {
        const opt = el.selectedOptions[0];
        const label = clean(opt?.textContent) || el.value;
        send({ kind: "do", text: `Choose ${say(label)} in ${t.text}`, code: [`await ${t.code}.selectOption(${q(label)});`] });
      } else if (role === "textbox") recordFill(el);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!recording || !e.isTrusted || e.key !== "Enter") return;
      const el = e.target;
      if (!(el instanceof Element) || roleOf(el) !== "textbox" || el.tagName === "TEXTAREA") return;
      recordFill(el);
      const t = locate(el);
      send({ kind: "do", text: `Press Enter in ${t.text}`, code: [`await ${t.code}.press('Enter');`] });
    },
    true,
  );

  function apply(state) {
    recording = !!state?.recording;
    mode = state?.mode ?? "record";
    if (!recording || mode !== "check") unoutline();
  }
  try {
    chrome.runtime.onMessage.addListener((m) => m?.type === "state" && apply(m.state));
    chrome.runtime.sendMessage({ type: "hello" }, (state) => apply(state));
  } catch {
    // Not in an extension (tests drive apply directly).
  }
  window.__claritiaApply = apply;
})();
