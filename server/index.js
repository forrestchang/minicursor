import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(process.env.MINICURSOR_ROOT || process.cwd());
const PORT = Number(process.env.PORT || 5173);
const MODEL = process.env.MINICURSOR_MODEL || "claude-sonnet-4-6";
const MAX_BYTES = 2 * 1024 * 1024;
const IGNORE = new Set([
  "node_modules", ".git", ".DS_Store", "dist", "build", ".next",
  ".venv", "venv", "__pycache__", ".minicursor", ".cache",
]);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env or export the var.");
  process.exit(1);
}

const client = new Anthropic();

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function safeResolve(relPath) {
  const abs = path.resolve(ROOT, relPath || ".");
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw Object.assign(new Error("Path escapes root"), { status: 400 });
  }
  return abs;
}

async function listDir(relPath) {
  const abs = safeResolve(relPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => !IGNORE.has(e.name))
    .map((e) => ({
      name: e.name,
      path: path.relative(ROOT, path.join(abs, e.name)),
      type: e.isDirectory() ? "dir" : "file",
    }))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
}

app.get("/api/meta", (_req, res) => {
  res.json({ root: ROOT, model: MODEL });
});

app.get("/api/tree", async (req, res, next) => {
  try {
    res.json(await listDir(req.query.path || ""));
  } catch (err) {
    next(err);
  }
});

app.get("/api/file", async (req, res, next) => {
  try {
    const abs = safeResolve(req.query.path);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_BYTES) {
      return res.status(413).json({ error: `File too large (${stat.size} bytes)` });
    }
    res.json({ path: path.relative(ROOT, abs), content: await fs.readFile(abs, "utf8") });
  } catch (err) {
    next(err);
  }
});

app.put("/api/file", async (req, res, next) => {
  try {
    const { path: relPath, content } = req.body || {};
    if (typeof relPath !== "string" || typeof content !== "string") {
      return res.status(400).json({ error: "path and content are required" });
    }
    const abs = safeResolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    res.json({ ok: true, path: path.relative(ROOT, abs) });
  } catch (err) {
    next(err);
  }
});

const SYSTEM_PROMPT = `You are MiniCursor, a concise AI pair-programmer embedded in a lightweight code editor.

When the user asks for code changes, respond with a short explanation followed by ONE fenced block per file you want to change, using the exact format:

\`\`\`edit:path/relative/to/root.ext
<complete new file contents>
\`\`\`

Rules:
- Use \`edit:<path>\` as the code fence language tag. The path is relative to the project root.
- Always include the COMPLETE new file contents (not a diff). The editor applies edits by full-file replacement.
- Only emit edit blocks when the user clearly wants to modify code. Otherwise just answer in prose.
- Prefer minimal, surgical changes.
- If the user's request is ambiguous, ask a clarifying question instead of guessing.`;

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/chat", async (req, res, next) => {
  let headersSent = false;
  try {
    const { messages, currentFile } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] required" });
    }
    const contextBlock = currentFile?.path
      ? `\n\n<current_file path="${currentFile.path}">\n${currentFile.content ?? ""}\n</current_file>`
      : "";
    const normalized = messages.map((m, i) => {
      const content =
        i === messages.length - 1 && m.role === "user"
          ? `${m.content}${contextBlock}`
          : m.content;
      return { role: m.role, content };
    });

    const { data: stream } = await client.messages
      .create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: normalized,
        stream: true,
      })
      .withResponse();

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    headersSent = true;

    let clientClosed = false;
    res.on("close", () => {
      clientClosed = !res.writableEnded;
      if (clientClosed) stream.controller.abort();
    });

    let stopReason = null;
    let usage = null;
    for await (const event of stream) {
      if (clientClosed) break;
      if (event.type === "message_start") {
        usage = event.message.usage;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        writeSse(res, "text", { text: event.delta.text });
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason;
        usage = { ...(usage || {}), ...event.usage };
      }
    }

    if (!clientClosed) {
      writeSse(res, "done", { stop_reason: stopReason, usage });
      res.end();
    }
  } catch (err) {
    if (headersSent) {
      console.error(`Chat stream failed: ${err.message || "Unknown error"}`);
      writeSse(res, "error", { error: err.message || "Stream failed" });
      return res.end();
    }
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(`Request failed (${err.status || 500}): ${err.message || "Internal error"}`);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`MiniCursor listening on http://localhost:${PORT}`);
  console.log(`Editing root: ${ROOT}`);
  console.log(`Model: ${MODEL}`);
});
