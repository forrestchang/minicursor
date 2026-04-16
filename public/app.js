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

/* ------------------------ Command Palette ------------------------ */

const palette = {
  el: null,
  input: null,
  list: null,
  hint: null,
  open: false,
  mode: null,         // "file" | "action"
  items: [],          // current filtered items [{label, hint?, score, indices, run}]
  selected: 0,
  fileIndex: null,    // cached [{path}] of all files
  fileIndexLoading: null,
};

function buildPalette() {
  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true">
      <input class="palette-input" type="text" autocomplete="off" spellcheck="false" />
      <div class="palette-list" role="listbox"></div>
      <div class="palette-hint"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  palette.el = overlay;
  palette.input = overlay.querySelector(".palette-input");
  palette.list = overlay.querySelector(".palette-list");
  palette.hint = overlay.querySelector(".palette-hint");

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });
  palette.input.addEventListener("input", refreshPalette);
  palette.input.addEventListener("keydown", onPaletteKey);
  palette.list.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".palette-row");
    if (!row) return;
    e.preventDefault();
    palette.selected = Number(row.dataset.index);
    commitSelection();
  });
}

function openFilePalette() {
  openPalette("file", "Go to file…", "↑↓ navigate · Enter open · Esc close");
  ensureFileIndex();
  refreshPalette();
}

function openActionPalette() {
  openPalette("action", "Run action…", "↑↓ navigate · Enter run · Esc close");
  refreshPalette();
}

function openPalette(mode, placeholder, hint) {
  palette.mode = mode;
  palette.open = true;
  palette.el.hidden = false;
  palette.input.placeholder = placeholder;
  palette.hint.textContent = hint;
  palette.input.value = "";
  palette.selected = 0;
  palette.input.focus();
}

function closePalette() {
  if (!palette.open) return;
  palette.open = false;
  palette.el.hidden = true;
  palette.mode = null;
  palette.items = [];
  if (state.editor) state.editor.focus();
}

function onPaletteKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    commitSelection();
  }
}

function moveSelection(delta) {
  if (!palette.items.length) return;
  palette.selected = (palette.selected + delta + palette.items.length) % palette.items.length;
  renderPaletteList();
  const active = palette.list.querySelector(".palette-row.active");
  active?.scrollIntoView({ block: "nearest" });
}

function commitSelection() {
  const item = palette.items[palette.selected];
  if (!item) return;
  closePalette();
  try {
    item.run();
  } catch (err) {
    console.error(err);
  }
}

function refreshPalette() {
  const q = palette.input.value;
  const source = palette.mode === "file" ? fileCandidates() : actionCandidates();
  palette.items = filterAndRank(source, q);
  palette.selected = 0;
  renderPaletteList();
}

function renderPaletteList() {
  palette.list.innerHTML = "";
  if (!palette.items.length) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    if (palette.mode === "file" && !palette.fileIndex) {
      empty.textContent = "Indexing files…";
    } else {
      empty.textContent = "No matches";
    }
    palette.list.appendChild(empty);
    return;
  }
  palette.items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "palette-row" + (i === palette.selected ? " active" : "");
    row.dataset.index = String(i);
    row.setAttribute("role", "option");
    const label = document.createElement("div");
    label.className = "palette-label";
    label.innerHTML = highlightMatch(item.label, item.indices);
    row.appendChild(label);
    if (item.hint) {
      const hint = document.createElement("div");
      hint.className = "palette-row-hint";
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    palette.list.appendChild(row);
  });
}

function highlightMatch(text, indices) {
  if (!indices || !indices.length) return escapeHtml(text);
  const set = new Set(indices);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? `<b>${ch}</b>` : ch;
  }
  return out;
}

function fuzzyScore(text, query) {
  if (!query) return { score: 0, indices: [] };
  const lt = text.toLowerCase();
  const lq = query.toLowerCase();
  const indices = [];
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < lq.length; qi++) {
    const ch = lq[qi];
    let found = -1;
    for (let i = ti; i < lt.length; i++) {
      if (lt[i] === ch) { found = i; break; }
    }
    if (found === -1) return null;
    // Bonuses: word start (sep before) and consecutive streak.
    const prev = found > 0 ? lt[found - 1] : "/";
    const atBoundary = /[\/\-_. ]/.test(prev) || found === 0;
    let gained = 1;
    if (atBoundary) gained += 3;
    if (found === ti) { streak++; gained += 2 * streak; } else { streak = 0; }
    score += gained;
    indices.push(found);
    ti = found + 1;
  }
  // Prefer shorter strings and matches closer to the basename.
  score -= text.length * 0.05;
  const slash = text.lastIndexOf("/");
  if (indices[0] > slash) score += 5;
  return { score, indices };
}

function filterAndRank(items, query) {
  if (!query.trim()) {
    return items.slice(0, 200).map((it) => ({ ...it, score: 0, indices: [] }));
  }
  const out = [];
  for (const it of items) {
    const res = fuzzyScore(it.label, query);
    if (res) out.push({ ...it, score: res.score, indices: res.indices });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 200);
}

function actionCandidates() {
  const active = state.activeFile;
  const actions = [
    {
      label: "Save File",
      hint: "⌘S",
      run: () => saveActive().catch((e) => alert(`Save failed: ${e.message}`)),
      enabled: !!active,
    },
    {
      label: "New Chat",
      hint: "Clear messages",
      run: () => els.clearChat.click(),
    },
    {
      label: "Toggle Include Current File",
      hint: els.includeFile.checked ? "currently on" : "currently off",
      run: () => { els.includeFile.checked = !els.includeFile.checked; },
    },
    {
      label: "Close Current Tab",
      hint: active || "no file open",
      run: () => active && closeFile(active),
      enabled: !!active,
    },
    {
      label: "Close All Tabs",
      hint: `${state.openFiles.size} open`,
      run: () => {
        for (const p of [...state.openFiles.keys()]) closeFile(p);
      },
      enabled: state.openFiles.size > 0,
    },
    {
      label: "Open File…",
      hint: "⌘P",
      run: () => openFilePalette(),
    },
    {
      label: "Reload File Tree",
      run: () => {
        palette.fileIndex = null;
        palette.fileIndexLoading = null;
        state.tree.clear();
        renderRootTree();
      },
    },
    {
      label: "Focus Chat Input",
      run: () => els.input.focus(),
    },
  ];
  return actions.filter((a) => a.enabled !== false);
}

function fileCandidates() {
  if (!palette.fileIndex) return [];
  return palette.fileIndex.map((f) => ({
    label: f.path,
    run: () => openFile(f.path),
  }));
}

function ensureFileIndex() {
  if (palette.fileIndex || palette.fileIndexLoading) return palette.fileIndexLoading;
  palette.fileIndexLoading = (async () => {
    const files = [];
    const seen = new Set();
    async function walk(dir) {
      if (seen.has(dir)) return;
      seen.add(dir);
      let entries;
      try {
        entries = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
      } catch {
        return;
      }
      const dirs = [];
      for (const e of entries) {
        if (e.type === "file") files.push({ path: e.path });
        else if (e.type === "dir") dirs.push(e.path);
      }
      await Promise.all(dirs.map(walk));
    }
    await walk("");
    files.sort((a, b) => a.path.localeCompare(b.path));
    palette.fileIndex = files;
    palette.fileIndexLoading = null;
    if (palette.open && palette.mode === "file") refreshPalette();
  })();
  return palette.fileIndexLoading;
}

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "p") {
    e.preventDefault();
    e.stopPropagation();
    if (palette.open && palette.mode === "file") closePalette();
    else openFilePalette();
  } else if (key === "k") {
    e.preventDefault();
    e.stopPropagation();
    if (palette.open && palette.mode === "action") closePalette();
    else openActionPalette();
  }
}, true);

(async function main() {
  try {
    buildPalette();
    await loadMeta();
    await bootMonaco();
    await renderRootTree();
  } catch (err) {
    els.meta.textContent = `Error: ${err.message}`;
  }
})();
