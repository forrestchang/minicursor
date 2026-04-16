# MiniCursor

A basic, hackable AI code editor inspired by [Cursor](https://cursor.com).
~800 lines of JavaScript, no build step, one Node process. Point it at a
folder, open a file, chat with Claude, apply edits with one click.

![screenshot placeholder](./docs/screenshot.png)

> **Status**: v0.2 — ships with streaming responses, diff view for edits,
> tool use for file exploration, and command palette. Built as a reference
> implementation: small enough to read in one sitting, real enough to use.

## Features

- **Monaco editor** — same editor VS Code uses, loaded from CDN so there's no
  build step.
- **File tree** — browses your project, respects common ignore patterns
  (`node_modules`, `.git`, `.venv`, `dist`, …).
- **Tabs + dirty indicators** — unsaved changes are tracked per file.
- **⌘/Ctrl + S** — save the active file.
- **Claude chat with streaming** — the AI streams tokens as they arrive, no
  waiting for full responses.
- **Tool use** — Claude can list and read files on its own when exploring
  your codebase.
- **Diff view for edits** — edit blocks show a side-by-side diff with
  accept/reject buttons before applying.
- **Command palette** — ⌘P to go to file, ⌘K for commands.
- **One-click Apply** — edit blocks (`` ```edit:path/to/file ``) show an
  **Accept** button that writes the file and refreshes the editor.

## Architecture

```
┌──────────────────────┐   HTTP/JSON/SSE  ┌──────────────────────┐
│  Browser (Monaco)    │ ────────────────▶│  Node + Express      │
│  public/app.js       │                  │  server/index.js     │
│  public/index.html   │                  │  - /api/tree         │
│  public/styles.css   │                  │  - /api/file (R/W)   │
│                      │                  │  - /api/chat (SSE)   │
│                      │                  │  - Tool use API      │
└──────────────────────┘                  └──────────────────────┘
```

All file I/O is sandboxed to a single root directory (`MINICURSOR_ROOT`,
defaults to the CWD). Path traversal is rejected at the API layer.

## Quick start

```bash
# 1. Clone
git clone https://github.com/forrestchang/minicursor.git
cd minicursor

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 4. Run (edits the current directory by default)
npm start
# or: node server/cli.js /path/to/any/project
```

Open http://localhost:5173.

## How the AI applies edits

The system prompt tells Claude to emit changes as fenced blocks:

    ```edit:src/foo.js
    <complete new file contents>
    ```

The frontend parses these, renders them as a diff view with accept/reject
buttons, and on accept writes the file via `PUT /api/file`. Full-file
replacement is simple and robust; a diff/patch mode is a natural next step.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘/Ctrl + S | Save active file |
| ⌘/Ctrl + P | Go to file |
| ⌘/Ctrl + K | Command palette |
| ⌘/Ctrl + Enter | Send chat message |

## Configuration

| Env var              | Default                | Purpose                             |
| -------------------- | ---------------------- | ----------------------------------- |
| `ANTHROPIC_API_KEY`  | *(required)*           | Your Anthropic API key.             |
| `MINICURSOR_MODEL`   | `claude-sonnet-4-6`    | Any Anthropic chat model ID.        |
| `MINICURSOR_ROOT`    | `process.cwd()`        | Folder the editor can read/write.   |
| `PORT`               | `5173`                 | HTTP port.                          |

## Development

```bash
# Run with auto-reload on file changes
npm run dev

# Lint
npm run lint

# Run smoke tests (starts server, hits endpoints, shuts down)
npm test
```

## Roadmap

- **v0.3** — Multi-file edits with per-hunk accept/reject, terminal tab
- **v0.4** — Agent loop (Claude can run commands, see output, iterate)

## Changelog

### v0.2 (2025-04)
- Streaming chat responses via SSE
- Tool use: `read_file` and `list_dir` for Claude
- Diff view for edit blocks with accept/reject
- Command palette (⌘P / ⌘K)
- CI pipeline with smoke tests

### v0.1 (2025-04)
- Initial release
- File tree, tabs, Monaco editor
- Chat with Claude, one-click apply

## License

MIT
