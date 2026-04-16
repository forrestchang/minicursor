const state = {
  tree: new Map(),          // path -> children array
  openFiles: new Map(),     // path -> { content, dirty, model }
  activeFile: null,
  messages: [],
  monaco: null,
  editor: null,
  meta: { root: "", model: "" },
};

const els = {
  tree: document.getElementById("tree"),
  tabs: document.getElementById("tabs"),
  editor: document.getElementById("editor"),
  status: document.getElementById("status"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("send"),
  includeFile: document.getElementById("includeFile"),
  clearChat: document.getElementById("clearChat"),
  meta: document.getElementById("meta"),
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function loadMeta() {
  state.meta = await api("/api/meta");
  els.meta.textContent = `${state.meta.root}  ·  ${state.meta.model}`;
}

function extToLang(p) {
  const ext = p.split(".").pop().toLowerCase();
  return ({
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    cs: "csharp", php: "php",
    html: "html", htm: "html", css: "css", scss: "scss",
    json: "json", yml: "yaml", yaml: "yaml", toml: "ini",
    md: "markdown", sh: "shell", bash: "shell",
    sql: "sql", xml: "xml",
  })[ext] || "plaintext";
}

async function loadTree(dir = "") {
  const entries = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
  state.tree.set(dir, entries);
  return entries;
}

function renderTreeNode(entry, container) {
  const node = document.createElement("div");
  node.className = `node ${entry.type}`;
  node.dataset.path = entry.path;
  node.innerHTML = `<span class="icon"></span>${escapeHtml(entry.name)}`;
  container.appendChild(node);

  if (entry.type === "dir") {
    const children = document.createElement("div");
    children.className = "children";
    children.dataset.path = entry.path;
    container.appendChild(children);
    node.addEventListener("click", async () => {
      const isOpen = node.classList.toggle("open");
      if (isOpen && !state.tree.has(entry.path)) {
        const kids = await loadTree(entry.path);
        kids.forEach((k) => renderTreeNode(k, children));
      }
    });
  } else {
    node.addEventListener("click", () => openFile(entry.path));
  }
}

async function renderRootTree() {
  els.tree.innerHTML = "";
  const entries = await loadTree("");
  entries.forEach((e) => renderTreeNode(e, els.tree));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function openFile(pathRel) {
  if (!state.openFiles.has(pathRel)) {
    const { content } = await api(`/api/file?path=${encodeURIComponent(pathRel)}`);
    const model = state.monaco.editor.createModel(content, extToLang(pathRel));
    model.onDidChangeContent(() => {
      const entry = state.openFiles.get(pathRel);
      if (!entry) return;
      entry.dirty = model.getValue() !== entry.savedContent;
      renderTabs();
      renderStatus();
    });
    state.openFiles.set(pathRel, { model, savedContent: content, dirty: false });
  }
  state.activeFile = pathRel;
  state.editor.setModel(state.openFiles.get(pathRel).model);
  state.editor.focus();
  renderTabs();
  renderTreeActive();
  renderStatus();
}

function closeFile(pathRel) {
  const entry = state.openFiles.get(pathRel);
  if (!entry) return;
  if (entry.dirty && !confirm(`Discard unsaved changes to ${pathRel}?`)) return;
  entry.model.dispose();
  state.openFiles.delete(pathRel);
  if (state.activeFile === pathRel) {
    const next = state.openFiles.keys().next().value || null;
    state.activeFile = next;
    if (next) {
      state.editor.setModel(state.openFiles.get(next).model);
    } else {
      state.editor.setModel(null);
    }
  }
  renderTabs();
  renderTreeActive();
  renderStatus();
}

function renderTabs() {
  els.tabs.innerHTML = "";
  for (const [p, info] of state.openFiles) {
    const tab = document.createElement("div");
    tab.className = "tab" + (p === state.activeFile ? " active" : "");
    const dirty = info.dirty ? '<span class="dirty" title="unsaved">●</span>' : "";
    tab.innerHTML = `<span>${escapeHtml(p)}</span>${dirty}<span class="close" title="close">×</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("close")) {
        closeFile(p);
      } else {
        openFile(p);
      }
    });
    els.tabs.appendChild(tab);
  }
}

function renderTreeActive() {
  els.tree.querySelectorAll(".node.file.active").forEach((n) => n.classList.remove("active"));
  if (state.activeFile) {
    const node = els.tree.querySelector(`.node.file[data-path="${CSS.escape(state.activeFile)}"]`);
    node?.classList.add("active");
  }
}

function renderStatus() {
  if (!state.activeFile) {
    els.status.textContent = "No file open";
    return;
  }
  const info = state.openFiles.get(state.activeFile);
  const model = info.model;
  els.status.textContent = `${state.activeFile}  ·  ${model.getLineCount()} lines  ·  ${extToLang(state.activeFile)}${info.dirty ? "  ·  ● unsaved" : ""}`;
}

async function saveActive() {
  if (!state.activeFile) return;
  const info = state.openFiles.get(state.activeFile);
  const content = info.model.getValue();
  await api("/api/file", {
    method: "PUT",
    body: JSON.stringify({ path: state.activeFile, content }),
  });
  info.savedContent = content;
  info.dirty = false;
  renderTabs();
  renderStatus();
}

/* ------------------------ Chat ------------------------ */

function appendUserMessage(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function parseAssistantText(text) {
  // Split into segments: plain text + edit blocks ```edit:path ...```
  const re = /```edit:([^\n`]+)\n([\s\S]*?)```/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push({ kind: "edit", path: m[1].trim(), content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

function appendAssistantMessage(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  for (const part of parseAssistantText(text)) {
    if (part.kind === "text") {
      const span = document.createElement("span");
      span.innerHTML = renderInlineMarkdown(part.value);
      el.appendChild(span);
    } else {
      el.appendChild(renderEditBlock(part.path, part.content));
    }
  }
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderInlineMarkdown(text) {
  const safe = escapeHtml(text);
  // Render ```lang ... ``` fenced code (non-edit)
  const withBlocks = safe.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, body) =>
    `<pre><code>${body}</code></pre>`,
  );
  // Inline code
  return withBlocks.replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function renderEditBlock(pathRel, content) {
  const block = document.createElement("div");
  block.className = "edit-block";
  block.innerHTML = `
    <div class="head">
      <span class="path">${escapeHtml(pathRel)}</span>
      <button class="apply">Apply</button>
    </div>
    <pre><code>${escapeHtml(content)}</code></pre>
  `;
  const btn = block.querySelector(".apply");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
      await api("/api/file", {
        method: "PUT",
        body: JSON.stringify({ path: pathRel, content }),
      });
      // Refresh editor if file is open
      if (state.openFiles.has(pathRel)) {
        const info = state.openFiles.get(pathRel);
        info.model.setValue(content);
        info.savedContent = content;
        info.dirty = false;
      }
      // Reload tree so new files show up
      await renderRootTree();
      btn.textContent = "Applied ✓";
      btn.classList.add("done");
      renderTabs();
      renderStatus();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Apply";
      alert(`Failed to apply: ${err.message}`);
    }
  });
  return block;
}

async function sendMessage(text) {
  state.messages.push({ role: "user", content: text });
  appendUserMessage(text);

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = "Thinking…";

  try {
    const body = { messages: state.messages };
    if (els.includeFile.checked && state.activeFile) {
      const info = state.openFiles.get(state.activeFile);
      body.currentFile = { path: state.activeFile, content: info.model.getValue() };
    }
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.messages.push({ role: "assistant", content: res.text });
    appendAssistantMessage(res.text);
  } catch (err) {
    appendAssistantMessage(`⚠️ ${err.message}`);
  } finally {
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = "Send";
  }
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.clearChat.addEventListener("click", () => {
  state.messages = [];
  els.messages.innerHTML = "";
});

/* ------------------------ Monaco ------------------------ */

function bootMonaco() {
  return new Promise((resolve) => {
    // eslint-disable-next-line no-undef
    require(["vs/editor/editor.main"], () => {
      // eslint-disable-next-line no-undef
      state.monaco = { editor: monaco.editor };
      // eslint-disable-next-line no-undef
      state.editor = monaco.editor.create(els.editor, {
        value: "",
        language: "plaintext",
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
      });
      state.editor.addCommand(
        // eslint-disable-next-line no-undef
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => saveActive().catch((e) => alert(`Save failed: ${e.message}`)),
      );
      resolve();
    });
  });
}

(async function main() {
  try {
    await loadMeta();
    await bootMonaco();
    await renderRootTree();
  } catch (err) {
    els.meta.textContent = `Error: ${err.message}`;
  }
})();
