// Claritia Recorder: keeps the recording (which tab, its steps, record or check mode) and saves it to Claritia.

import { addStep } from "./steps.js";

const DEFAULT_APP = "https://app.tryclaritia.com";
const empty = { recording: false, tabId: null, mode: "record", steps: [], origin: "" };

async function state() {
  const { rec } = await chrome.storage.session.get("rec");
  return rec ?? { ...empty };
}
async function setState(rec) {
  await chrome.storage.session.set({ rec });
  if (rec.tabId) chrome.tabs.sendMessage(rec.tabId, { type: "state", state: { recording: rec.recording, mode: rec.mode } }).catch(() => {});
  return rec;
}
async function settings() {
  const s = await chrome.storage.local.get(["key", "app"]);
  return { key: s.key ?? "", app: (s.app || DEFAULT_APP).replace(/\/+$/, "") };
}
async function api(path, init = {}, use) {
  const { key, app } = use ?? (await settings());
  const res = await fetch(`${app}/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Claritia answered ${res.status}.`);
  return data;
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    const rec = await state();
    switch (m?.type) {
      case "hello": // a page loaded: is this tab recording?
        return reply(sender.tab?.id === rec.tabId ? { recording: rec.recording, mode: rec.mode } : { recording: false });
      case "step": {
        if (!rec.recording || sender.tab?.id !== rec.tabId) return reply(null);
        const { checkDone, ...step } = m.step;
        return reply(await setState({ ...rec, steps: addStep(rec.steps, step), mode: checkDone ? "record" : rec.mode }));
      }
      case "get":
        return reply({ ...rec, settings: await settings() });
      case "start": {
        const tab = await chrome.tabs.get(m.tabId);
        const url = new URL(tab.url);
        const path = `${url.pathname}${url.search}` || "/";
        return reply(await setState({ recording: true, tabId: tab.id, mode: "record", origin: url.origin, steps: [{ kind: "do", text: `Go to ${path}`, code: [`await page.goto('${path.replace(/'/g, "\\'")}');`] }] }));
      }
      case "stop":
        return reply(await setState({ ...rec, recording: false, mode: "record" }));
      case "check":
        return reply(await setState({ ...rec, mode: rec.mode === "check" ? "record" : "check" }));
      case "delete":
        return reply(await setState({ ...rec, steps: rec.steps.filter((_, i) => i !== m.index) }));
      case "clear":
        return reply(await setState({ ...empty, tabId: rec.tabId }));
      case "saveSettings": {
        // Saved only once Claritia accepts the key.
        const next = { key: m.key.trim(), app: (m.app || DEFAULT_APP).trim().replace(/\/+$/, "") };
        const projects = await api("/projects", {}, next);
        await chrome.storage.local.set(next);
        return reply(projects);
      }
      case "projects":
        return reply(await api("/projects"));
      case "save": {
        const data = await api("/tests", {
          method: "POST",
          body: JSON.stringify({ project: m.project, name: m.name, use_case: m.useCase || undefined, steps: rec.steps.map(({ kind, text, code }) => ({ kind, text, code })) }),
        });
        await setState({ ...empty, tabId: rec.tabId });
        return reply(data);
      }
      default:
        return reply(null);
    }
  })().catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
