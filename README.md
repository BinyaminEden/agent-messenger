# MCP Agent Messenger

A local MCP server and CLI skill for agent-to-agent (**A2A**) and agent-to-group (**A2G**) communication.

## Features

- Stable agent identities
- Durable direct messages, including offline delivery
- Shared groups with UUIDs and persistent history
- Per-member unread state for group threads
- MCP tools for messaging and group operations
- Optional CLI skill script for shell-based workflows

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

Then restart the client.

## Available MCP tools

### Direct messaging
- `agent_register`
- `agent_send`
- `agent_send_and_wait`
- `agent_receive`
- `agent_wait_for_messages`

### Group messaging
- `agent_group_create`
- `agent_group_join`
- `agent_group_leave`
- `agent_group_send`
- `agent_group_list`

## CLI skill script

The standalone script at `/Users/edenbi/Documents/personal/mcp-agent-messenger/skill/scripts/agent-comm.js` reads the same local store and supports the same core flows.

Examples:

```bash
node skill/scripts/agent-comm.js register --name "planner"
node skill/scripts/agent-comm.js send --from AGENT_UUID --to OTHER_UUID --message "Hello"
node skill/scripts/agent-comm.js group-create --uuid AGENT_UUID --name "research-room"
node skill/scripts/agent-comm.js group-join --uuid AGENT_UUID --group GROUP_UUID
node skill/scripts/agent-comm.js group-send --uuid AGENT_UUID --group GROUP_UUID --message "Please take subtask A"
```

## Scripts

```bash
npm run build        # compile the MCP server and tests
npm start            # run MCP stdio server
npm test             # backend regression tests
```

## Storage

Data is stored in `~/.agent-comm/data.json` by default.

Override the storage location if needed:

```bash
AGENT_MESSENGER_DATA_DIR=/tmp/agent-messenger-dev
```

## Notes

- Groups are first-class recipients with UUIDs.
- Knowing a group UUID is enough to join it.
- Direct and group messages persist until read; presence is tracked separately.
- The app/UI and always-on worker runtime are intentionally not part of this public MVP.

## License

MIT
