#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "url";
import { z } from "zod";
import {
  createGroup,
  getParticipant,
  joinChannel,
  joinGroup,
  leaveGroup,
  listGroups,
  receive,
  registerParticipant,
  replyToMessage,
  resolveIdentity,
  resolveParticipantRef,
  sendChannelMessage,
  sendDirectMessage,
  sendGroupMessage,
  waitForMessages,
  waitForReply,
} from "./store.js";
import type { ParticipantType, RegisterResult } from "./store.js";

// Mutable holder for a single session's resolved messaging identity. Exposed so
// the identity-scoped handlers below can be unit-tested against a real store.
export interface AgentSession {
  uuid: string | null;
}

const session: AgentSession = { uuid: null };

const server = new McpServer({
  name: "agent-messenger",
  version: "3.0.0",
});

// Resolve (once) the identity for a session. Subsequent calls reuse the cached
// uuid so a rename via agent_register is never silently undone.
export async function resolveSessionAgent(state: AgentSession): Promise<string> {
  if (!state.uuid) {
    state.uuid = (await resolveIdentity()).uuid;
  }
  return state.uuid;
}

// agent_register: set or rename the session identity, keeping the same uuid.
export async function registerSessionAgent(
  state: AgentSession,
  name?: string
): Promise<RegisterResult> {
  await resolveSessionAgent(state);
  const result = await registerParticipant("agent", name, state.uuid ?? undefined);
  state.uuid = result.uuid;
  return result;
}

// agent_whoami: REPORT the current session identity without re-deriving it.
// Re-deriving (via resolveIdentity) would ignore a prior rename and mint a
// duplicate participant, switching the session's identity mid-conversation.
export async function whoamiSessionAgent(
  state: AgentSession
): Promise<{ uuid: string; name: string; type: ParticipantType }> {
  const uuid = await resolveSessionAgent(state);
  const participant = await getParticipant(uuid);
  return {
    uuid,
    name: participant?.name ?? uuid,
    type: participant?.type ?? "agent",
  };
}

async function resolveCurrentAgent(): Promise<string> {
  return resolveSessionAgent(session);
}

server.tool(
  "agent_register",
  "Optional: set or rename this agent's identity. Identity auto-resolves without calling this.",
  {
    name: z.string().optional().describe("New human-readable name for this agent"),
  },
  async ({ name }) => {
    const result = await registerSessionAgent(session, name);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              uuid: result.uuid,
              name: result.name,
              type: result.type,
              message: `Identity is ${result.name} (${result.uuid}). Share this with other agents who want to message you or add you to groups.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "agent_whoami",
  "Show this session's resolved messaging identity (uuid + name).",
  {},
  async () => {
    const identity = await whoamiSessionAgent(session);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              uuid: identity.uuid,
              name: identity.name,
              type: identity.type,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "agent_send",
  "Send a direct message to another participant by name, UUID, or unique UUID prefix.",
  {
    to: z.string().describe("Recipient name, full UUID, or unique UUID prefix (min 6 chars)"),
    message: z.string().describe("Message content"),
  },
  async ({ to, message }) => {
    const me = await resolveCurrentAgent();

    const resolved = await resolveParticipantRef(to);
    if ("error" in resolved) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: resolved.error }),
          },
        ],
        isError: true,
      };
    }

    const result = await sendDirectMessage(me, resolved.uuid, message);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_ask",
  "Send a direct message and block until a reply correlated to THIS message arrives (or timeout).",
  {
    to: z.string().describe("Recipient name, full UUID, or unique UUID prefix (min 6 chars)"),
    message: z.string().describe("Message content"),
    timeout_seconds: z
      .number()
      .optional()
      .default(120)
      .describe("How long to wait for the correlated reply"),
  },
  async ({ to, message, timeout_seconds }) => {
    const me = await resolveCurrentAgent();

    const resolved = await resolveParticipantRef(to);
    if ("error" in resolved) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: resolved.error }),
          },
        ],
        isError: true,
      };
    }

    const sendResult = await sendDirectMessage(me, resolved.uuid, message);
    if (!sendResult.success || !sendResult.messageId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: sendResult.error, phase: "send" }),
          },
        ],
        isError: true,
      };
    }

    const askResult = await waitForReply(me, sendResult.messageId, timeout_seconds * 1000);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: me,
              sentTo: resolved.uuid,
              messageId: sendResult.messageId,
              timedOut: askResult.timedOut,
              reply: askResult.message,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "agent_reply",
  "Reply to a specific direct message so the sender's agent_ask unblocks.",
  {
    message_id: z.string().describe("The id of the message you are replying to"),
    message: z.string().describe("Reply content"),
  },
  async ({ message_id, message }) => {
    const me = await resolveCurrentAgent();

    const result = await replyToMessage(me, message_id, message);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: result.success,
              messageId: result.messageId,
              error: result.error,
            },
            null,
            2
          ),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_receive",
  "Check unread direct/group messages, joined groups, and active agents.",
  {
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to mark unread messages as read (default: true)"),
  },
  async ({ clear }) => {
    const me = await resolveCurrentAgent();

    const result = await receive(me, clear);
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: "Current agent not found" }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: me,
              directMessageCount: result.directMessages.length,
              groupMessageCount: result.groupMessages.length,
              directMessages: result.directMessages,
              groupMessages: result.groupMessages,
              groups: result.groups,
              activeAgents: result.activeAgents,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "agent_wait_for_messages",
  "Wait for unread direct or group messages. Blocks until traffic arrives or timeout is reached.",
  {
    timeout_seconds: z
      .number()
      .optional()
      .default(60)
      .describe("How long to wait for messages (default: 60 seconds)"),
    poll_interval_seconds: z
      .number()
      .optional()
      .default(15)
      .describe("Coarse fallback poll interval in seconds (default: 15 seconds)"),
  },
  async ({ timeout_seconds, poll_interval_seconds }) => {
    const me = await resolveCurrentAgent();

    const result = await waitForMessages(
      me,
      timeout_seconds * 1000,
      poll_interval_seconds * 1000
    );

    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: "Current agent not found" }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: me,
              timedOut: result.timedOut,
              directMessageCount: result.directMessages.length,
              groupMessageCount: result.groupMessages.length,
              directMessages: result.directMessages,
              groupMessages: result.groupMessages,
              groups: result.groups,
              activeAgents: result.activeAgents,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "agent_send_and_wait",
  "Send a direct message to another participant, then wait for unread direct or group traffic.",
  {
    to: z.string().describe("Recipient name, full UUID, or unique UUID prefix (min 6 chars)"),
    message: z.string().describe("The message content to send"),
    timeout_seconds: z
      .number()
      .optional()
      .default(120)
      .describe("How long to wait for follow-up traffic (default: 120 seconds)"),
  },
  async ({ to, message, timeout_seconds }) => {
    const me = await resolveCurrentAgent();

    const resolved = await resolveParticipantRef(to);
    if ("error" in resolved) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: resolved.error, phase: "resolve" }),
          },
        ],
        isError: true,
      };
    }

    const sendResult = await sendDirectMessage(me, resolved.uuid, message);

    if (!sendResult.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: sendResult.error, phase: "send" }),
          },
        ],
        isError: true,
      };
    }

    const waitResult = await waitForMessages(me, timeout_seconds * 1000);
    if (!waitResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: "Current agent not found", phase: "wait" }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: me,
              sentTo: resolved.uuid,
              sentMessage: message,
              timedOut: waitResult.timedOut,
              directReplyCount: waitResult.directMessages.length,
              groupUpdateCount: waitResult.groupMessages.length,
              directReplies: waitResult.directMessages,
              groupUpdates: waitResult.groupMessages,
              groups: waitResult.groups,
              activeAgents: waitResult.activeAgents,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "channel_join",
  "Join a named channel, creating it if it does not exist.",
  {
    name: z.string().describe("Channel name"),
  },
  async ({ name }) => {
    const me = await resolveCurrentAgent();

    const result = await joinChannel(me, name);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "channel_send",
  "Send a message to a named channel (joins it first if needed).",
  {
    name: z.string().describe("Channel name"),
    message: z.string().describe("Message content"),
  },
  async ({ name, message }) => {
    const me = await resolveCurrentAgent();

    const joinResult = await joinChannel(me, name);
    if (!joinResult.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: joinResult.error, phase: "join" }),
          },
        ],
        isError: true,
      };
    }

    const result = await sendChannelMessage(me, name, message);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_group_create",
  "Create a new group and join it immediately.",
  {
    name: z.string().optional().describe("Optional human-readable group name"),
  },
  async ({ name }) => {
    const me = await resolveCurrentAgent();

    const result = await createGroup(me, name);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_group_join",
  "Join a group by its UUID.",
  {
    group_uuid: z.string().describe("The group UUID to join"),
  },
  async ({ group_uuid }) => {
    const me = await resolveCurrentAgent();

    const result = await joinGroup(me, group_uuid);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_group_leave",
  "Leave a joined group.",
  {
    group_uuid: z.string().describe("The group UUID to leave"),
  },
  async ({ group_uuid }) => {
    const me = await resolveCurrentAgent();

    const result = await leaveGroup(me, group_uuid);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_group_send",
  "Send a message to a joined group.",
  {
    group_uuid: z.string().describe("The target group UUID"),
    message: z.string().describe("The message content to send"),
  },
  async ({ group_uuid, message }) => {
    const me = await resolveCurrentAgent();

    const result = await sendGroupMessage(me, group_uuid, message);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  }
);

server.tool(
  "agent_group_list",
  "List the groups this agent has joined.",
  {},
  async () => {
    const me = await resolveCurrentAgent();

    const groups = await listGroups(me);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: me,
              groups,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Messenger MCP server running on stdio");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  startMcpServer().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
