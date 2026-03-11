---
name: agent-comm
description: Enables agents to communicate with each other across Cursor sessions and repos. Use when the user asks you to talk to another agent, coordinate across repos, wait for messages, register as an agent, or work as part of a multi-agent team.
---

# Agent Communication

Communicate with other Cursor agents across sessions using a shared message store at `~/.agent-comm/data.json`.

## Choose Your Method

There are two ways to use agent communication. Both are interchangeable - they read/write the same data.

### Option A: MCP Tools (recommended for most users)

Pre-approved tools, no popups. Requires one-time MCP setup.

Available tools: `agent_register`, `agent_send`, `agent_send_and_wait`, `agent_wait_for_messages`, `agent_receive`

### Option B: Shell Script (for auto-run / yolo mode users)

No setup needed. Works immediately via shell commands. Requires auto-run enabled to avoid approval popups.

```bash
AGENT_COMM="node <path-to-repo>/skill/scripts/agent-comm.js"
```

Replace `<path-to-repo>` with the actual path to this cloned repository.

Commands: `register`, `send`, `send-and-wait`, `wait`, `receive`

## Operations Reference

### Register (always do this first)

**MCP:** `agent_register(name: "your-name")`
**Shell:** `$AGENT_COMM register --name "your-name"`

Returns your UUID. Save it. Re-registering with the same name returns the existing UUID.

### Send and wait for reply (preferred for conversations)

**MCP:** `agent_send_and_wait(to: "their-uuid", message: "Hello!", timeout_seconds: 120)`
**Shell:** `$AGENT_COMM send-and-wait --from YOUR_UUID --to THEIR_UUID --message "Hello!" --timeout 120`

Sends a message then blocks until a reply arrives or timeout.

### Wait for messages

**MCP:** `agent_wait_for_messages(timeout_seconds: 120)`
**Shell:** `$AGENT_COMM wait --uuid YOUR_UUID --timeout 120`

Blocks until someone messages you.

### Send without waiting (fire-and-forget, rare)

**MCP:** `agent_send(to: "their-uuid", message: "Hello!")`
**Shell:** `$AGENT_COMM send --from YOUR_UUID --to THEIR_UUID --message "Hello!"`

### Quick check (non-blocking)

**MCP:** `agent_receive()`
**Shell:** `$AGENT_COMM receive --uuid YOUR_UUID`

Returns pending messages and list of active agents.

## Protocol Rules

1. **Register first** - always register before any other operation
2. **Always wait after sending** - use `send-and-wait`, not bare `send`
3. **Never leave the other agent hanging** - they are blocking, waiting for your reply
4. **Process then reply** - read the message, do your work, then respond

## Conversation Flow

```
You                                 Other Agent
────                                ───────────
register("Alice")                   register("Bob")

send-and-wait(to: Bob,              wait(timeout: 120)
  "Review this plan")                 ← receives your message
  → blocks waiting...                 processes it...

                                    send-and-wait(to: Alice,
                                      "Plan looks good")
  ← wakes up, got reply               → blocks waiting...

send-and-wait(to: Bob,
  "Great, proceed")
  → blocks waiting...                ← wakes up
  ...                               ...
```

## Discovery

`receive` and `wait` both return active agents:

```json
{
  "agents": [
    { "uuid": "abc-123", "name": "Alice" },
    { "uuid": "def-456", "name": "Bob" }
  ]
}
```

## Data Details

- Stored in `~/.agent-comm/data.json`
- Agents inactive for 1 hour are auto-removed
- Messages older than 24 hours are auto-purged
- File locking prevents race conditions
- Atomic writes prevent corruption

## MCP Setup (Option A only)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-messenger": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"]
    }
  }
}
```

Replace `<path-to-repo>` with the absolute path to this cloned repository. Then restart Cursor.
