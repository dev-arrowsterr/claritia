// Claritia Recorder: the popup. Connect once with an API key, then Record, Add check, and Save test.

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
let project = "";

function show(el, on) {
  el.hidden = !on;
}
function error(message) {
  $("error").textContent = message ?? "";
  show($("error"), !!message);
}
async function call(m) {
  error("");
  const r = await send(m);
  if (r?.error) {
    error(r.error);
    throw new Error(r.error);
  }
  return r;
}

function renderSteps(rec) {
  const list = $("steps");
  list.replaceChildren(
    ...rec.steps.map((s, i) => {
      const li = document.createElement("li");
      const n = Object.assign(document.createElement("span"), { className: "n", textContent: String(i + 1) });
      const t = Object.assign(document.createElement("span"), { className: "t", textContent: s.kind === "check" ? `Check: ${s.text}` : s.text });
      const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: "Remove" });
      x.onclick = async () => render(await call({ type: "delete", index: i }));
      li.append(n, t, x);
      return li;
    }),
  );
  $("record").textContent = rec.recording ? "Stop" : "Record";
  $("record").className = rec.recording ? "on" : "primary";
  $("check").disabled = !rec.recording;
  $("check").className = rec.mode === "check" ? "on" : "";
  $("save").disabled = rec.recording || rec.steps.length < 2 || !project;
}
function render(rec) {
  renderSteps(rec);
}

async function loadProjects() {
  const { projects } = await call({ type: "projects" });
  const box = $("projects");
  if (!project && projects.length) project = projects[0].id;
  box.replaceChildren(
    ...projects.map((p) => {
      const b = Object.assign(document.createElement("button"), { textContent: p.name, className: p.id === project ? "on" : "" });
      b.onclick = async () => {
        project = p.id;
        await loadProjects();
        render(await call({ type: "get" }));
      };
      return b;
    }),
  );
}

async function init() {
  const rec = await call({ type: "get" });
  const connected = !!rec.settings.key;
  show($("setup"), !connected);
  show($("main"), connected);
  $("app").value = rec.settings.app;
  if (connected) {
    await loadProjects().catch(() => undefined);
    render(rec);
  }
}

$("connect").onclick = async () => {
  await call({ type: "saveSettings", key: $("key").value, app: $("app").value });
  await init();
};
$("settings").onclick = () => {
  show($("setup"), true);
  show($("main"), false);
};
$("record").onclick = async () => {
  const rec = await call({ type: "get" });
  if (rec.recording) return render(await call({ type: "stop" }));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("http")) return error("Open the site to test in this tab first.");
  render(await call({ type: "start", tabId: tab.id }));
  window.close();
};
$("check").onclick = async () => {
  render(await call({ type: "check" }));
  window.close();
};
$("clear").onclick = async () => render(await call({ type: "clear" }));
$("save").onclick = async () => {
  const name = $("name").value.trim();
  if (!name) return error("Name the test.");
  const r = await call({ type: "save", project, name, useCase: $("useCase").value.trim() });
  $("note").innerHTML = "";
  $("note").append("Saved. ", Object.assign(document.createElement("a"), { href: r.url, target: "_blank", textContent: "Open in Claritia" }));
  show($("note"), true);
  render(await call({ type: "get" }));
};

init().catch((e) => error(e.message));
