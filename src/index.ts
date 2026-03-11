#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { register, send, receive, waitForMessages } from "./store.js";

let currentAgentUuid: string | null = null;

const server = new McpServer({
  name: "agent-messenger",
  version: "1.0.0",
});

server.tool(
  "agent_register",
  "Register this agent with the messaging system. Returns a unique UUID for this agent.",
  {
    name: z.string().optional().describe("Human-readable name for this agent"),
  },
  async ({ name }) => {
    const result = await register(name);
    currentAgentUuid = result.uuid;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              uuid: result.uuid,
              name: result.name,
              message: `Registered successfully. Your UUID is ${result.uuid}. Share this with other agents who want to message you.`,
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
  "Send a message to another agent by their UUID. WARNING: After sending, you SHOULD call agent_wait_for_messages to wait for their reply. Consider using agent_send_and_wait instead which does both automatically.",
  {
    to: z.string().describe("The recipient agent's UUID"),
    message: z.string().describe("The message content to send"),
  },
  async ({ to, message }) => {
    if (!currentAgentUuid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error:
                "You must register first using agent_register before sending messages.",
            }),
          },
        ],
        isError: true,
      };
    }

    const result = await send(currentAgentUuid, to, message);

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
  "Check for pending messages and list active agents.",
  {
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to clear messages after reading (default: true)"),
  },
  async ({ clear }) => {
    if (!currentAgentUuid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error:
                "You must register first using agent_register before receiving messages.",
            }),
          },
        ],
        isError: true,
      };
    }

    const result = await receive(currentAgentUuid, clear);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: currentAgentUuid,
              messageCount: result.messages.length,
              messages: result.messages,
              activeAgents: result.agents,
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
  "Wait for incoming messages. Blocks until a message arrives or timeout is reached. Use this to have real-time conversations with other agents.",
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
      .describe("How often to check for new messages (default: 2 seconds)"),
  },
  async ({ timeout_seconds, poll_interval_seconds }) => {
    if (!currentAgentUuid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error:
                "You must register first using agent_register before waiting for messages.",
            }),
          },
        ],
        isError: true,
      };
    }

    const result = await waitForMessages(
      currentAgentUuid,
      timeout_seconds * 1000,
      poll_interval_seconds * 1000
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              yourUuid: currentAgentUuid,
              timedOut: result.timedOut,
              messageCount: result.messages.length,
              messages: result.messages,
              activeAgents: result.agents,
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
  "PREFERRED METHOD: Send a message to another agent, then automatically wait for their reply. This is the correct way to have conversations - it ensures you don't leave the other agent waiting. Blocks until a reply arrives or timeout.",
  {
    to: z.string().describe("The recipient agent's UUID"),
    message: z.string().describe("The message content to send"),
    timeout_seconds: z
      .number()
      .optional()
      .default(120)
      .describe("How long to wait for a reply (default: 120 seconds)"),
  },
  async ({ to, message, timeout_seconds }) => {
    if (!currentAgentUuid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error:
                "You must register first using agent_register before chatting.",
            }),
          },
        ],
        isError: true,
      };
    }

    const sendResult = await send(currentAgentUuid, to, message);
    
    if (!sendResult.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: sendResult.error,
              phase: "send",
            }),
          },
        ],
        isError: true,
      };
    }

    const waitResult = await waitForMessages(
      currentAgentUuid,
      timeout_seconds * 1000,
      2000
    );

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
              replyCount: waitResult.messages.length,
              replies: waitResult.messages,
              activeAgents: waitResult.agents,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Messenger MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
