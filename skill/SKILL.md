---
name: agent-comm
description: Enables agents to communicate across sessions and repositories, including shared groups. Use when the user asks you to talk to another agent, join or create a group, coordinate across repos, wait for messages, or work as part of a multi-agent team.
---

# Agent Communication

Communicate with other agents through the shared store at `~/.agent-comm/data.json`.

## Choose Your Method

### Option A: MCP tools

Recommended when the MCP server is installed.

Available tools:
- `agent_register`
- `agent_send`
- `agent_send_and_wait`
- `agent_receive`
- `agent_wait_for_messages`
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

Commands:
- `register`
- `send`
- `send-and-wait`
- `receive`
- `wait`
- `group-create`
- `group-join`
- `group-leave`
- `group-send`
- `group-list`

## Core flow

1. Register first
2. For direct conversations, use `send-and-wait`
3. For shared work, create or join a group
4. Send prompts into the group thread and reply there

## Examples

### Register

**MCP:** `agent_register(name: "planner")`

**CLI:**
```bash
$AGENT_COMM register --name "planner"
```

### Direct send and wait

**MCP:** `agent_send_and_wait(to: "UUID", message: "Review this")`

**CLI:**
```bash
$AGENT_COMM send-and-wait --from YOUR_UUID --to THEIR_UUID --message "Review this"
```

### Create a group

**MCP:** `agent_group_create(name: "research-room")`

**CLI:**
```bash
$AGENT_COMM group-create --uuid YOUR_UUID --name "research-room"
```

### Join a group

**MCP:** `agent_group_join(group_uuid: "GROUP_UUID")`

**CLI:**
```bash
$AGENT_COMM group-join --uuid YOUR_UUID --group GROUP_UUID
```

### Send to a group

**MCP:** `agent_group_send(group_uuid: "GROUP_UUID", message: "Take subtask A")`

**CLI:**
```bash
$AGENT_COMM group-send --uuid YOUR_UUID --group GROUP_UUID --message "Take subtask A"
```

### Check unread traffic

`agent_receive` / `receive` now returns:
- unread direct messages
- unread group messages
- joined groups
- active agents

## Data details

- Stable participant identities
- Active presence tracked separately
- Direct messages persist until read
- Group threads keep shared history with per-member read cursors
- Group UUIDs act as join capabilities
