# claude-session-viewer

Local web viewer for **Claude Code** session history.

- Browse all sessions across projects
- View full conversation history
- Token usage per session and per message
- Cost estimation dashboard (by model: sonnet / opus / haiku)
- Daily cost chart, per-session cost table, project & model breakdown

## Requirements

- Node.js 16+
- Claude Code installed (sessions stored in `~/.claude/projects/`)

## Usage

### Run without installing

```bash
npx github:Malburi/claude-session-viewer
```

### Run without installing (클론방식)

```bash
git clone https://github.com/Malburi/claude-session-viewer.git
cd claude-session-viewer
npm install
node session-viewer.js   # 또는 npm start
```

### Install globally

```bash
npm install -g github:Malburi/claude-session-viewer
claude-session-viewer
```

Then open **http://localhost:3000** in your browser.

## Options

```
--port <n>   Use a different port (default: 3000)
--no-open    Don't auto-open the browser
```

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Sessions | `/` | Browse & read session history |
| Dashboard | `/dashboard` | Cost & token usage analytics |

## Screenshots

**Sessions** — project tree, search, token chips per message

![Sessions](screenshots/sessions.png)

**Dashboard** — stat cards, daily cost chart, project breakdown, per-session cost table

![Dashboard](screenshots/dashboard.png)
