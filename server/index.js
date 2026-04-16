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
const MAX_TOOL_READ_BYTES = positiveIntEnv("MINICURSOR_MAX_TOOL_READ_BYTES", 64 * 1024);
const MAX_TOOL_RESULT_BYTES = positiveIntEnv("MINICURSOR_MAX_TOOL_RESULT_BYTES", 96 * 1024);
const MAX_TOOL_ITERATIONS = positiveIntEnv("MINICURSOR_MAX_TOOL_ITERATIONS", 8);
const MAX_CHAT_USAGE_TOKENS = positiveIntEnv("MINICURSOR_MAX_CHAT_USAGE_TOKENS", 12000);
const IGNORE = new Set([
  "node_modules", ".git", ".DS_Store", "dist", "build", ".next",
  ".venv", "venv", "__pycache__", ".minicursor", ".cache",
]);

const CHAT_TOOLS = [
  {
    name: "list_files",
    description:
      "List the direct children of a directory under the project root. Paths are relative to the root; use an empty string for the root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file under the project root. Paths are relative to the root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root.",
        },
      },
      required: ["path"],
    },
  },
];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env or export the var.");
  process.exit(1);
}

const client = new Anthropic();

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

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

async function readFileForTool(relPath) {
  const abs = safeResolve(relPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw Object.assign(new Error("Path is not a file"), { status: 400 });
  }
  if (stat.size > MAX_TOOL_READ_BYTES) {
    throw Object.assign(
      new Error(`File too large for tool use (${stat.size} bytes; max ${MAX_TOOL_READ_BYTES})`),
      { status: 413 },
    );
  }
  return {
    path: path.relative(ROOT, abs),
    content: await fs.readFile(abs, "utf8"),
  };
}

function requireToolPath(input) {
  if (!input || typeof input.path !== "string") {
    throw Object.assign(new Error("Tool input must include a string path"), { status: 400 });
  }
  return input.path;
}

async function executeToolUse(toolUse) {
  try {
    const relPath = requireToolPath(toolUse.input);
    let result;
    if (toolUse.name === "list_files") {
      result = await listDir(relPath);
    } else if (toolUse.name === "read_file") {
      result = await readFileForTool(relPath);
    } else {
      throw Object.assign(new Error(`Unknown tool: ${toolUse.name}`), { status: 400 });
    }

    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: stringifyToolResult(result),
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      is_error: true,
      content: err.message || "Tool failed",
    };
  }
}

function stringifyToolResult(result) {
  const content = JSON.stringify(result, null, 2);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TOOL_RESULT_BYTES) {
    throw Object.assign(
      new Error(
        `Tool result too large (${bytes} bytes; max ${MAX_TOOL_RESULT_BYTES}). Use a narrower path.`,
      ),
      { status: 413 },
    );
  }
  return content;
}

function emptyUsageTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
  };
}

function addUsageTotals(total, usage = {}) {
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  for (const key of keys) {
    total[key] += Number(usage[key] || 0);
  }
  total.total_tokens = keys.reduce((sum, key) => sum + total[key], 0);
}

function textFromContent(content = []) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function withStopMessage(text, message) {
  return [text, message].filter(Boolean).join("\n\n");
}

async function createClaudeMessage(messages) {
  return client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    tools: CHAT_TOOLS,
  });
}

async function runChatWithTools(initialMessages) {
  const conversation = [...initialMessages];
  const usage = emptyUsageTotals();
  let toolIterations = 0;

  while (true) {
    const response = await createClaudeMessage(conversation);
    addUsageTotals(usage, response.usage);

    const text = textFromContent(response.content);
    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return {
        text,
        stop_reason: response.stop_reason,
        usage,
        tool_iterations: toolIterations,
      };
    }

    if (usage.total_tokens >= MAX_CHAT_USAGE_TOKENS) {
      return {
        text: withStopMessage(
          text,
          `Stopped because the chat token budget (${MAX_CHAT_USAGE_TOKENS}) was reached before Claude produced a final answer.`,
        ),
        stop_reason: "token_budget_exceeded",
        usage,
        tool_iterations: toolIterations,
      };
    }

    if (toolIterations >= MAX_TOOL_ITERATIONS) {
      return {
        text: withStopMessage(
          text,
          `Stopped after ${MAX_TOOL_ITERATIONS} tool-use rounds before Claude produced a final answer.`,
        ),
        stop_reason: "tool_loop_limit",
        usage,
        tool_iterations: toolIterations,
      };
    }

    conversation.push({ role: "assistant", content: response.content });
    conversation.push({
      role: "user",
      content: await Promise.all(toolUses.map(executeToolUse)),
    });
    toolIterations += 1;
  }
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
- If the user's request is ambiguous, ask a clarifying question instead of guessing.
- Use the list_files and read_file tools to inspect project files when needed. Tool paths are always relative to the project root.`;

app.post("/api/chat", async (req, res, next) => {
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

    const response = await runChatWithTools(normalized);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`MiniCursor listening on http://localhost:${PORT}`);
  console.log(`Editing root: ${ROOT}`);
  console.log(`Model: ${MODEL}`);
});
