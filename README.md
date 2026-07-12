# MCP Agent Messenger

A local MCP server and CLI skill for agent-to-agent (**A2A**) and agent-to-group (**A2G**) communication.

## Features

- **Session-scoped identity** — with the SessionStart hook, each Claude Code session's UUID *is* its messaging UUID (stable across `--resume`/`/compact`); falls back to a stable per-cwd identity with no hooks. No `agent_register` required
- Flexible addressing — message another participant by name, full UUID, or a unique UUID prefix (min 6 chars)
- Request/reply correlation — `agent_ask` blocks for the specific reply, not just any traffic
- Named channels — join/send by name, created on demand
- Durable direct messages, including offline delivery
- Shared groups with UUIDs and persistent history, with per-member unread state
- Event-driven waits (fs.watch) with a coarse fallback poll — low-latency, no busy polling
- Lock-free reads: presence lives in its own `presence.json`, so reads never rewrite `data.json`
- Optional Stop hook that keeps an agent from ending its turn with unread messages
- Optional **wake adapter** that actively nudges an *idle* recipient when new mail arrives (stack-neutral; you supply the command)

## Install

```bash
npm install
npm run build
```

## MCP setup

Configure your MCP client to run the built server:

```json
{
  "mcpServers": {
    "agent-messenger": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-agent-messenger/dist/src/index.js"]
    }
  }
}
```

Then restart the client. No registration step is needed — the first tool call
auto-resolves this session's identity.

## Identity

Identity is **session-scoped** when the SessionStart hook (below) is installed:
each Claude Code session already has a stable session UUID (stable across
`--resume` and `/compact`, and what you see in `claude --resume`). The hook
registers a participant whose **UUID *is* that session UUID**, so agents address
each other by native session UUID and two concurrent sessions in the same
directory get distinct identities.

The MCP server discovers which session it belongs to, in this priority order:

1. **Session by parent PID** — the SessionStart hook and the stdio MCP server are
   both direct children of the same `claude` worker process, so the hook records
   its `process.ppid` and the server matches it against its own `process.ppid`
   (freshest wins on ties). This is what disambiguates two sessions sharing a cwd.
2. **Session by cwd** — freshest session whose recorded realpath cwd matches the
   server's cwd (covers the case where PIDs don't line up).
3. **Fallback (no hooks installed):** `AGENT_MESSENGER_NAME` env var if set, else
   a stable per-project name `` `${basename(cwd)}-${sha256(cwd).slice(0,6)}` ``
   (e.g. `mcp-agent-messenger-1a2b3c`). Same directory → same UUID across restarts.

Session records live in `~/.agent-comm/identities.json` under `sessions`
(`{session_id, cwd, name, uuid, ppid, updatedAt}`); SessionEnd moves a session's
record into an `endedSessions` trail (kept ~24h, then pruned) while leaving its
participant and messages intact (offline delivery keeps working). Without the
hooks, nothing changes — the cwd/env fallback still applies.

Call `agent_whoami` to see the resolved `{uuid, name, type}`, and `agent_register`
only if you want to rename the current identity.

### What happens on `/clear`

`/clear` gives the pane a **new session UUID** (SessionStart fires with source
`clear`). The SessionStart hook detects the predecessor (same parent PID + cwd,
different session_id — found in `sessions` or the `endedSessions` trail, so it
works regardless of whether SessionEnd for the old id ran first) and **hands the
pane's address over**: the old participant is marked `aliasOf` the new one, its
unread mail is re-targeted, and its group/channel memberships are copied across.
Anyone who addresses the **old** UUID, name, or prefix is transparently
forwarded to the live participant (chains flatten, so repeated clears stay
depth-1), aliased participants drop out of `activeAgents`, and the running MCP
server notices its cached identity was superseded and adopts the new one on its
next tool call. Wakes for an old id poke the pane's *current* session.

### Addressing

Message a participant by **name**, **full UUID**, or a **unique UUID prefix**
(minimum 6 chars). Ambiguous or too-short prefixes return a clear error.

### Show your address in the status line

Since a session's messaging UUID *is* its Claude Code session UUID, you can put
each agent's address right on its status line — read it off one pane, tell any
other agent to message it. The status line command receives JSON on stdin that
includes `session_id`:

```bash
#!/bin/bash
# ~/.claude/statusline.sh
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // ""')
echo "✉ ${sid:0:8}  $(basename "$(echo "$input" | jq -r '.workspace.current_dir')")"
```

```json
{
  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
}
```

The 8-char `✉` prefix is a complete, directly usable address (see
[Addressing](#addressing)).

## Available MCP tools

### Direct messaging
- `agent_whoami` — show this session's resolved identity
- `agent_register` — optional: set/rename this agent's identity
- `agent_send` — send a direct message (recipient by **name, full UUID, or unique UUID prefix — min 6 chars**)
- `agent_ask` — send and block for the correlated reply (or timeout)
- `agent_reply` — reply to a specific message so the sender's `agent_ask` unblocks
- `agent_send_and_wait` — send, then wait for any inbound traffic
- `agent_receive` — read unread direct/group messages, joined groups, active agents
- `agent_wait_for_messages` — block until any traffic arrives or timeout

### Channels
- `channel_join` — join a named channel, creating it if needed
- `channel_send` — send to a named channel (joins first if needed)

### Group messaging
- `agent_group_create`
- `agent_group_join`
- `agent_group_leave`
- `agent_group_send`
- `agent_group_list`

## Zero-setup two-agent flow

Two agents, no manual registration. Agent A runs in `/repo/a`, Agent B in `/repo/b`.

1. **A asks B a question and blocks for the answer:**
   ```
   agent_ask(to: "b-9f3c1a", message: "What's the schema version?")
   ```
   (A also learns names via `agent_receive` → `activeAgents`, or B shares its
   name from `agent_whoami`.)

2. **B sees the message and replies to it:**
   ```
   agent_receive()                         # returns the message + its id
   agent_reply(message_id: "<id>", message: "v3")
   ```

3. **A's `agent_ask` unblocks** with `{ timedOut: false, reply: { content: "v3", ... } }`.

Unrelated messages arriving at A while it waits do **not** unblock the `agent_ask`
and remain unread for a later `agent_receive`.

For broadcast-style coordination use channels:

```
channel_join(name: "research")
channel_send(name: "research", message: "Starting on subtask A")
```

## Claude Code hooks

Two hook scripts make identity session-native and keep agents from dropping mail.
Wire them into `.claude/settings.json` (all three fail-open — any error is
ignored and never blocks the session):

- **`skill/scripts/session-hook.js`** — a **SessionStart** + **SessionEnd** hook.
  On SessionStart it registers a participant whose UUID is the Claude Code session
  UUID and records the session (with its parent PID) so the MCP server can find
  it; it also runs the `/clear` identity handoff (see "What happens on `/clear`"
  above). On SessionEnd it moves the session record into the `endedSessions` trail
  (participant + messages stay).
- **`skill/scripts/inbox-hook.js`** — a **Stop** hook. When the session tries to
  end, it checks the store (lock-free, never clearing anything) for unread
  messages addressed to this session (resolved by session UUID first) and, if any
  exist, blocks the stop and tells Claude to run `agent_receive`. It is loop-safe
  (respects `stop_hook_active`).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/session-hook.js",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/session-hook.js",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/mcp-agent-messenger/skill/scripts/inbox-hook.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The Stop hook works with or without the SessionStart hook: with it, identity is
resolved by exact session UUID; without it, it falls back to the persisted
cwd/env identity.

## Waking idle agents

There are two wake layers, and they complement each other:

- **Stop hook — passive.** Keeps a session from *ending its turn* with unread
  mail. But a session sitting *idle* at its prompt never runs a Stop hook, so it
  is never nudged until its next turn.
- **Wake adapter — active.** After a successful send, the messenger schedules a
  wake for each recipient. It waits `AGENT_MESSENGER_WAKE_DELAY_MS` (default
  `4000`), re-reads the store, and — only if that recipient *still* has unread
  mail (i.e. its Stop hook or an active turn did not already consume it) —
  invokes a user-configured command. A burst of sends within the window fires at
  most one wake per recipient. In the long-lived MCP server the timer is
  `unref`'d so it never blocks exit; the short-lived CLI can't hold a timer past
  its own exit, so it fires immediately after the send instead.

The wake command is entirely yours — the messenger core knows nothing about your
terminal, multiplexer, or dashboard. It is resolved in priority order:

1. the `AGENT_MESSENGER_WAKE_CMD` environment variable, else
2. the `wakeCommand` field of `<data dir>/config.json` (e.g. `~/.agent-comm/config.json`).

If neither is set, nothing happens (the Stop hook remains the passive fallback).

### Adapter contract

The command is spawned via the shell with one JSON object on **stdin**:

```json
{
  "recipient_uuid": "…",
  "recipient_name": "…",
  "session_id": "…or null",
  "session_cwd": "…or null",
  "session_ppid": 12345,
  "unread_count": 3,
  "from_names": ["Alice", "Bob"]
}
```

- `session_id` is the recipient's Claude Code session id when the recipient uuid
  matches a live session record (SessionStart hook), else `null`.
- `session_cwd` is that session's realpath cwd, else `null`.
- `session_ppid` is the pid of the recipient's `claude` process (the SessionStart
  hook's parent pid), else `null`. A same-user adapter can inspect that process's
  environment (e.g. `ps eww -o command= -p <ppid>` on macOS) to discover the
  terminal pane it runs in — waking an idle pane directly, with no external
  service. See `examples/wake-zellij.mjs`.
- `from_names` are the distinct display names of the senders of the unread messages.

The adapter is spawned **detached** and **unref**'d, killed after ~5s, and is
**always fail-silent**: a missing, broken, or slow adapter never affects the send
result or surfaces as a tool error.

### Example adapters

Four illustrative, self-contained adapters live in `examples/` (all generic):

- **`examples/wake-webhook.mjs`** — POSTs `{ session_id, text, submit: true }` to
  a URL from `WAKE_WEBHOOK_URL` (or the first CLI arg); skips when `session_id`
  is null. Works with any dashboard/bridge that can type into a session by id.
- **`examples/wake-zellij.mjs`** — no external service. Reads `session_ppid` from
  the payload, extracts `ZELLIJ_SESSION_NAME` + `ZELLIJ_PANE_ID` from that
  process's environment (`ps eww`), and types the wake into the pane. With a
  zellij pipe plugin (`WAKE_ZELLIJ_PIPE_PLUGIN`) it targets the pane WITHOUT
  stealing focus; otherwise it falls back to `zellij action write-chars`, which
  types into the focused pane (see its header for the plugin payload contract).
- **`examples/wake-tmux.sh`** — finds a tmux pane whose cwd matches `session_cwd`
  and `send-keys` a "check your agent messages" prompt (cwd→pane matching is
  heuristic; adapt to your setup).
- **`examples/wake-headless.sh`** — runs `claude --resume "$session_id" -p …` in
  the background. **Resumes the conversation headlessly** — do not use it while
  the session is open interactively.

Example `~/.agent-comm/config.json`:

```json
{
  "wakeCommand": "WAKE_WEBHOOK_URL=https://your-dashboard.example/api/send node /absolute/path/to/mcp-agent-messenger/examples/wake-webhook.mjs"
}
```

Or, without a config file:

```bash
export AGENT_MESSENGER_WAKE_CMD='node /absolute/path/to/examples/wake-tmux.sh'
```

## CLI skill script

The standalone script at `skill/scripts/agent-comm.js` reads the same local store
and mirrors the MCP tools. `--from`/`--uuid` are optional — omit them to use the
auto-resolved identity; `--to` and other participant refs accept a name, full
UUID, or unique UUID prefix (min 6 chars).

```bash
node skill/scripts/agent-comm.js whoami
node skill/scripts/agent-comm.js send --to "planner" --message "Hello"
node skill/scripts/agent-comm.js ask --to "planner" --message "Ready?" --timeout 120
node skill/scripts/agent-comm.js reply --to-message MESSAGE_ID --message "Yes"
node skill/scripts/agent-comm.js channel-join --name "research"
node skill/scripts/agent-comm.js channel-send --name "research" --message "Starting subtask A"
node skill/scripts/agent-comm.js receive
node skill/scripts/agent-comm.js wait --timeout 60
node skill/scripts/agent-comm.js group-create --name "research-room"
node skill/scripts/agent-comm.js group-join --group GROUP_UUID
node skill/scripts/agent-comm.js group-send --group GROUP_UUID --message "Please take subtask A"
```

## Scripts

```bash
npm run build        # compile the MCP server and tests
npm start            # run MCP stdio server
npm test             # backend regression tests
```

## Storage

State lives under `~/.agent-comm/` by default:

- `data.json` — durable state (participants, groups, messages), mutated only under the lock.
- `presence.json` — best-effort `lastSeen` map, written without the lock and TTL-cleaned on read.
- `identities.json` — `identities` (cwd → pinned identity, for the Stop hook) and `sessions` (session_id → `{cwd, name, uuid, ppid, updatedAt}`, written by the SessionStart hook).
- `config.json` — optional; `{ "wakeCommand": "…" }` for the wake adapter (see [Waking idle agents](#waking-idle-agents)). Never created automatically.

Override the storage location if needed:

```bash
AGENT_MESSENGER_DATA_DIR=/tmp/agent-messenger-dev
```

Legacy and v2 stores are migrated to v3 losslessly on first read; any in-file
presence from a v2 store is moved into `presence.json`.

## Notes

- Groups are first-class recipients with UUIDs; knowing a group UUID is enough to join.
- Channels are groups keyed by name; the oldest group wins on a name collision.
- Direct and group messages persist until read; presence is tracked separately.
- The app/UI and always-on worker runtime are intentionally not part of this public MVP.

## License

MIT
