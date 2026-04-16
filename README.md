# MiniCursor

A basic, hackable AI code editor inspired by [Cursor](https://cursor.com).
~600 lines of JavaScript, no build step, one Node process. Point it at a
folder, open a file, chat with Claude, apply edits with one click.

![screenshot placeholder](./docs/screenshot.png)

> **Status**: v0.1 — ships the core loop (browse → edit → chat → apply). Built
> as a reference implementation: small enough to read in one sitting, real
> enough to use.

## Features

- **Monaco editor** — same editor VS Code uses, loaded from CDN so there's no
  build step.
- **File tree** — browses your project, respects common ignore patterns
  (`node_modules`, `.git`, `.venv`, `dist`, …).
- **Tabs + dirty indicators** — unsaved changes are tracked per file.
- **⌘/Ctrl + S** — save the active file.
- **Claude chat** — the AI sees your currently-open file and can return
  full-file replacements in a structured format the UI applies with one click.
- **One-click Apply** — edit blocks (`` ```edit:path/to/file ``) show an
  **Apply** button that writes the file and refreshes the editor.

## Architecture

```
┌──────────────────────┐   HTTP/JSON   ┌──────────────────────┐
│  Browser (Monaco)    │ ────────────▶ │  Node + Express      │
│  public/app.js       │               │  server/index.js     │
│  public/index.html   │               │  - /api/tree         │
│  public/styles.css   │               │  - /api/file (R/W)   │
│                      │               │  - /api/chat → Claude│
└──────────────────────┘               └──────────────────────┘
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

The frontend parses these, renders them as a diff-free "apply card", and on
click writes the file via `PUT /api/file`. Full-file replacement is simple and
robust; a diff/patch mode is a natural next step.

## Configuration

| Env var              | Default                | Purpose                             |
| -------------------- | ---------------------- | ----------------------------------- |
| `ANTHROPIC_API_KEY`  | *(required)*           | Your Anthropic API key.             |
| `MINICURSOR_MODEL`   | `claude-sonnet-4-6`    | Any Anthropic chat model ID.        |
| `MINICURSOR_ROOT`    | `process.cwd()`        | Folder the editor can read/write.   |
| `PORT`               | `5173`                 | HTTP port.                          |

## Roadmap

See [GitHub Issues](https://github.com/forrestchang/minicursor/issues). The
next milestones:

- **Streaming responses** — stream tokens instead of waiting for full replies.
- **Diff view** — preview edit blocks as diffs before applying.
- **Tool use** — let Claude list files / read other files without the user
  pasting them.
- **Multi-file edits with per-hunk accept/reject.**
- **Terminal tab** — shell integration, so the AI can run tests.

## License

MIT
