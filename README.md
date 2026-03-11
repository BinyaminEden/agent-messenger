# MCP Agent Messenger

Enable AI agents to communicate with each other across sessions and repositories. Works with any MCP-compatible client — Cursor, Claude Code, Windsurf, and more.

## How It Works

Agents register with a UUID, send messages, and wait for replies. All data is shared via `~/.agent-comm/data.json`, so any agent on the same machine can participate.

```
Agent A (Repo 1)                     Agent B (Repo 2)
──────────────────                   ──────────────────
register("Alice")                    register("Bob")

send-and-wait("Hello!")              wait_for_messages()
  → blocks...                          ← receives "Hello!"

                                     send-and-wait("Hi back!")
  ← wakes up, got reply!               → blocks...
```

## Two Ways to Use

| | MCP (Option A) | Skill + CLI (Option B) |
|--|----------------|------------------------|
| Setup | Add to MCP config, restart | Copy skill to skills directory |
| Approval popups | None (pre-approved) | Needs auto-run / yolo mode |
| Best for | Any MCP client (Cursor, Claude Code, Windsurf, etc.) | Any agent with skills support |
| Same data? | Yes | Yes - fully interchangeable |

## Option A: MCP Server

### Quick Install (npx)

Add to your MCP config (e.g. `~/.cursor/mcp.json` for Cursor, `~/.claude/settings.json` for Claude Code):

```json
{
  "mcpServers": {
    "agent-messenger": {
      "command": "npx",
      "args": ["mcp-agent-messenger"]
    }
  }
}
```

Restart your client. That's it.

### From Source

```bash
git clone https://github.com/BinyaminEden/agent-messenger.git
cd agent-messenger
npm install
npm run build
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "agent-messenger": {
      "command": "node",
      "args": ["/absolute/path/to/agent-messenger/dist/index.js"]
    }
  }
}
```

Restart your client.

### Available Tools

`agent_register`, `agent_send`, `agent_send_and_wait`, `agent_wait_for_messages`, `agent_receive`

## Option B: Skill + CLI Script

### 1. Install the skill

Copy to your agent's skills directory:

```bash
# Cursor
cp -r skill/. ~/.cursor/skills/agent-comm/

# Claude Code
cp -r skill/. ~/.claude/skills/agent-comm/

# Or use the universal path
cp -r skill/. ~/.agents/skills/agent-comm/
```

### 2. Use via shell

```bash
node path/to/agent-messenger/skill/scripts/agent-comm.js register --name "MyAgent"
node path/to/agent-messenger/skill/scripts/agent-comm.js send-and-wait --from UUID --to UUID --message "Hello"
node path/to/agent-messenger/skill/scripts/agent-comm.js wait --uuid UUID --timeout 120
```

No dependencies required - uses Node.js built-ins only.

## CLI Reference

```
Commands:
  register      --name <name>
  send          --from <uuid> --to <uuid> --message <text>
  send-and-wait --from <uuid> --to <uuid> --message <text> [--timeout <seconds>]
  wait          --uuid <uuid> [--timeout <seconds>] [--poll <seconds>]
  receive       --uuid <uuid> [--clear false]
```

## Design

- **Shared file storage** - All agents read/write `~/.agent-comm/data.json`
- **File locking** - Atomic mkdir-based locks prevent race conditions
- **TTL cleanup** - Agents expire after 1 hour idle, messages after 24 hours
- **Atomic writes** - Temp file + rename prevents corruption
- **Zero dependencies** (CLI) - Pure Node.js built-ins

## Contributing

Contributions are welcome! Fork the repo, create a branch, and open a pull request.

```bash
git clone https://github.com/BinyaminEden/agent-messenger.git
cd agent-messenger
npm install
npm run build
```

## License

MIT
