#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "url";
import { z } from "zod";
import {
  createGroup,
  joinGroup,
  leaveGroup,
  listGroups,
  receive,
  registerAgent,
  sendDirectMessage,
  sendGroupMessage,
  waitForMessages,
} from "./store.js";

let currentAgentUuid: string | null = null;

const server = new McpServer({
  name: "agent-messenger",
  version: "2.0.0",
});

function requireCurrentAgent() {
  if (!currentAgentUuid) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: "You must register first using agent_register before using messaging tools.",
          }),
        },
      ],
      isError: true,
    };
  }

  return null;
}

server.tool(
  "agent_register",
  "Register this agent with the messaging system. Returns a stable UUID for this agent.",
  {
    name: z.string().optional().describe("Human-readable name for this agent"),
  },
  async ({ name }) => {
    const result = await registerAgent(name);
    currentAgentUuid = result.uuid;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              uuid: result.uuid,
              name: result.name,
              type: result.type,
              message: `Registered successfully. Your UUID is ${result.uuid}. Share this with other agents who want to message you or add you to groups.`,
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
  "Send a direct message to another participant by UUID.",
  {
    to: z.string().describe("The recipient participant UUID"),
    message: z.string().describe("The message content to send"),
  },
  async ({ to, message }) => {
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await sendDirectMessage(currentAgentUuid!, to, message);

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
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await receive(currentAgentUuid!, clear);
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
              yourUuid: currentAgentUuid,
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
      .default(2)
      .describe("How often to check for messages (default: 2 seconds)"),
  },
  async ({ timeout_seconds, poll_interval_seconds }) => {
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await waitForMessages(
      currentAgentUuid!,
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
              yourUuid: currentAgentUuid,
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
    to: z.string().describe("The recipient participant UUID"),
    message: z.string().describe("The message content to send"),
    timeout_seconds: z
      .number()
      .optional()
      .default(120)
      .describe("How long to wait for follow-up traffic (default: 120 seconds)"),
  },
  async ({ to, message, timeout_seconds }) => {
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const sendResult = await sendDirectMessage(currentAgentUuid!, to, message);

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

    const waitResult = await waitForMessages(currentAgentUuid!, timeout_seconds * 1000, 2000);
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
              yourUuid: currentAgentUuid,
              sentTo: to,
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
  "agent_group_create",
  "Create a new group and join it immediately.",
  {
    name: z.string().optional().describe("Optional human-readable group name"),
  },
  async ({ name }) => {
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await createGroup(currentAgentUuid!, name);
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
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await joinGroup(currentAgentUuid!, group_uuid);
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
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await leaveGroup(currentAgentUuid!, group_uuid);
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
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const result = await sendGroupMessage(currentAgentUuid!, group_uuid, message);
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
    const error = requireCurrentAgent();
    if (error) {
      return error;
    }

    const groups = await listGroups(currentAgentUuid!);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: currentAgentUuid,
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
