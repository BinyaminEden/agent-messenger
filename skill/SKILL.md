---
name: agent-comm
description: Enables agents to communicate across sessions and repositories, including named channels and shared groups. Use when the user asks you to talk to another agent, ask another agent a question and wait for its answer, join or create a channel/group, coordinate across repos, wait for messages, or work as part of a multi-agent team.
---

# Agent Communication

Communicate with other agents through the shared store under `~/.agent-comm/`
(`data.json` + `presence.json`).

## Zero setup

Your identity resolves automatically on first use — **no `agent_register` needed**.

With the SessionStart hook installed (see below), your identity is
**session-scoped**: your messaging UUID *is* the Claude Code session UUID (stable
across `--resume` and `/compact`, and what the user sees in `claude --resume`), so
two sessions in the same directory get distinct identities. The MCP server finds
its session by matching parent PID first, then cwd.

Without the hook it falls back to `AGENT_MESSENGER_NAME` (if set) or a stable
per-project name `` `${basename(cwd)}-${sha256(cwd).slice(0,6)}` ``, the same
across restarts in the same directory.

Use `agent_whoami` to see the resolved identity; `agent_register` only to rename.

### What happens on `/clear`

`/clear` mints a **new session UUID** for the pane. The SessionStart hook detects
the predecessor (same parent PID + cwd) and **hands your address over** to the new
identity: unread mail is re-targeted, group/channel memberships are copied, and
the old UUID/name/prefix is aliased forward so anyone messaging the old id still
reaches you. Repeated clears flatten (they never chain deeply), the old identity
drops out of `activeAgents`, and the running server adopts the new identity on its
next tool call. You keep your inbox and memberships across `/clear` — nothing to
do manually.

## Addressing

Reference another participant by **name**, **full UUID**, or a **unique UUID
prefix** (min 6 chars — e.g. the short id shown in the statusline). Ambiguous or
too-short prefixes return a clear error.

## Choose Your Method

### Option A: MCP tools

Recommended when the MCP server is installed.

Direct messaging:
- `agent_whoami` — show your resolved identity
- `agent_register` — optional rename
- `agent_send` — send to a participant **by name, full UUID, or unique UUID prefix (min 6 chars)**
- `agent_ask` — send and block for the correlated reply
- `agent_reply` — reply to a specific message (unblocks the sender's `agent_ask`)
- `agent_send_and_wait` — send, then wait for any inbound traffic
- `agent_receive` — read unread messages, groups, active agents
- `agent_wait_for_messages` — block until any traffic arrives

Channels:
- `channel_join`
- `channel_send`

Groups:
- `agent_group_create`
- `agent_group_join`
- `agent_group_leave`
- `agent_group_send`
- `agent_group_list`

### Option B: CLI script

For auto-run/yolo workflows:

```bash
AGENT_COMM="node <path-to-repo>/skill/scripts/agent-comm.js"
```

Commands (mirror the MCP tools). `--from`/`--uuid` are optional — omit to use the
auto-resolved identity; `--to` and other participant refs accept a name, full
UUID, or unique UUID prefix (min 6 chars):
- `whoami`
- `register`
- `send`
- `ask`
- `reply`
- `send-and-wait`
- `receive`
- `wait`
- `channel-join`
- `channel-send`
- `group-create`
- `group-join`
- `group-leave`
- `group-send`
- `group-list`

## Core flow

1. No registration needed — just start messaging (identity auto-resolves).
2. To ask another agent something and wait for **its answer**, use `agent_ask`
   and have the other side `agent_reply` to your message.
3. For broadcast coordination, `channel_join` / `channel_send` a named channel.
4. For durable shared threads with UUID join capabilities, use groups.

## Examples

### Who am I

**MCP:** `agent_whoami()`

**CLI:**
```bash
$AGENT_COMM whoami
```

### Ask a question and wait for the reply

**MCP:**
```
agent_ask(to: "planner", message: "What's the schema version?")
```
Returns `{ timedOut, reply: { id, content, ... } }`. Unrelated traffic does NOT
unblock it and stays unread for a later `agent_receive`.

**CLI:**
```bash
$AGENT_COMM ask --to "planner" --message "What's the schema version?" --timeout 120
```

### Reply to a specific message

The reply must target the original message's id (surfaced by `agent_receive`),
which is what unblocks the sender's `agent_ask`.

**MCP:** `agent_reply(message_id: "MESSAGE_ID", message: "v3")`

**CLI:**
```bash
$AGENT_COMM reply --to-message MESSAGE_ID --message "v3"
```

### Fire-and-forget direct send (by name, UUID, or unique UUID prefix)

**MCP:** `agent_send(to: "planner", message: "Heads up")`

**CLI:**
```bash
$AGENT_COMM send --to "planner" --message "Heads up"
```

### Named channel

**MCP:**
```
channel_join(name: "research")
channel_send(name: "research", message: "Starting subtask A")
```

**CLI:**
```bash
$AGENT_COMM channel-join --name "research"
$AGENT_COMM channel-send --name "research" --message "Starting subtask A"
```

### Group

**MCP:**
```
agent_group_create(name: "research-room")
agent_group_join(group_uuid: "GROUP_UUID")
agent_group_send(group_uuid: "GROUP_UUID", message: "Take subtask A")
```

**CLI:**
```bash
$AGENT_COMM group-create --name "research-room"
$AGENT_COMM group-join --group GROUP_UUID
$AGENT_COMM group-send --group GROUP_UUID --message "Take subtask A"
```

### Check unread traffic

`agent_receive` / `receive` returns unread direct messages (with their ids),
unread group messages, joined groups, and active agents. It marks them read by
default; pass `--clear false` (CLI) or `clear: false` (MCP) to peek without
consuming.

## Hooks

Two Claude Code hook scripts (both fail-open — they never break a session):

- **`skill/scripts/session-hook.js`** — a **SessionStart** + **SessionEnd** hook.
  SessionStart registers a participant whose UUID is the session UUID, records the
  session (with parent PID) so the MCP server can discover it, and runs the
  `/clear` identity handoff; SessionEnd moves the session record into a short
  `endedSessions` trail (participant + messages stay for offline delivery).
- **`skill/scripts/inbox-hook.js`** — a **Stop** hook that prevents a session from
  ending while it has unread messages. It resolves identity by session UUID first
  (then cwd/env fallbacks), reads the store lock-free, never clears anything, and
  is loop-safe (`stop_hook_active`). When unread exists it blocks the stop and
  asks Claude to run `agent_receive` first.

Wire them into `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/session-hook.js", "timeout": 10 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/session-hook.js", "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/inbox-hook.js", "timeout": 10 } ] }
    ]
  }
}
```

## Waking idle agents

Two complementary wake layers:

- **Stop hook — passive.** Stops a session ending its *turn* with unread mail,
  but an *idle* session at its prompt is never nudged until its next turn.
- **Wake adapter — active.** After a send, the messenger schedules a wake per
  recipient, waits `AGENT_MESSENGER_WAKE_DELAY_MS` (default 4000ms), re-reads the
  store, and — only if that recipient *still* has unread mail — runs a
  user-configured command. A burst within the window fires at most one wake per
  recipient. The MCP server debounces with an `unref`'d timer; the short-lived
  CLI fires immediately after the send.

The command is stack-neutral (the core knows nothing about your terminal or
dashboard) and resolved in priority order:

1. `AGENT_MESSENGER_WAKE_CMD` env var, else
2. `wakeCommand` in `<data dir>/config.json` (e.g. `~/.agent-comm/config.json`).

If neither is set, nothing happens (the Stop hook stays the passive fallback).

**Adapter contract:** the command is spawned via the shell with one JSON object
on stdin — `{ recipient_uuid, recipient_name, session_id, session_cwd,
unread_count, from_names: [] }`. `session_id`/`session_cwd` are the recipient's
Claude Code session id + realpath cwd when the recipient uuid matches a live
session record, else `null`. It is spawned detached/unref'd, killed after ~5s,
and **always fail-silent** — a broken adapter never affects the send result.

**Examples** (generic, in `examples/`): `wake-webhook.mjs` (POST to any dashboard
that can type into a session), `wake-tmux.sh` (send-keys into a matching pane),
`wake-headless.sh` (`claude --resume` in the background — do not use on a session
open interactively).

## Data details

- Session-scoped identities (uuid == Claude Code session UUID) with the SessionStart hook; stable per-project fallback without it.
- `data.json` holds durable state (lock-guarded writes); `presence.json` holds
  best-effort `lastSeen` (no lock). Reads never rewrite `data.json`.
- Direct messages persist until read; `agent_ask`/`agent_reply` correlate via `replyTo`.
- Channels are groups keyed by name (oldest wins on collision).
- Group threads keep shared history with per-member read cursors; group UUIDs act
  as join capabilities.
- Waits are event-driven (fs.watch) with a coarse 15s fallback poll.
