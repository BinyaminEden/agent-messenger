import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import * as lockfile from "proper-lockfile";

export interface Agent {
  name: string;
  lastSeen: number;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

export interface StoreData {
  agents: Record<string, Agent>;
  messages: Message[];
}

const DATA_DIR = path.join(os.homedir(), ".agent-comm");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const LOCK_FILE = path.join(DATA_DIR, ".lock");

const AGENT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function ensureLockFile(): Promise<void> {
  try {
    await fs.access(LOCK_FILE);
  } catch {
    await fs.writeFile(LOCK_FILE, "");
  }
}

async function readData(): Promise<StoreData> {
  try {
    const content = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(content) as StoreData;
  } catch {
    return { agents: {}, messages: [] };
  }
}

async function writeData(data: StoreData): Promise<void> {
  const tempFile = DATA_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
  await fs.rename(tempFile, DATA_FILE);
}

function cleanupData(data: StoreData): StoreData {
  const now = Date.now();

  const agents: Record<string, Agent> = {};
  for (const [uuid, agent] of Object.entries(data.agents)) {
    if (now - agent.lastSeen < AGENT_TTL_MS) {
      agents[uuid] = agent;
    }
  }

  const validAgentIds = new Set(Object.keys(agents));
  const messages = data.messages.filter(
    (msg) =>
      now - msg.timestamp < MESSAGE_TTL_MS && validAgentIds.has(msg.to)
  );

  return { agents, messages };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDataDir();
  await ensureLockFile();

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(LOCK_FILE, {
      retries: {
        retries: 10,
        minTimeout: 50,
        maxTimeout: 500,
      },
      stale: 10000,
    });
    return await fn();
  } finally {
    if (release) {
      await release();
    }
  }
}

export interface RegisterResult {
  uuid: string;
  name: string;
}

export async function register(name?: string): Promise<RegisterResult> {
  return withLock(async () => {
    let data = await readData();
    data = cleanupData(data);

    if (name) {
      for (const [uuid, agent] of Object.entries(data.agents)) {
        if (agent.name === name) {
          agent.lastSeen = Date.now();
          await writeData(data);
          return { uuid, name: agent.name };
        }
      }
    }

    const uuid = uuidv4();
    const agentName = name || `agent-${uuid.slice(0, 8)}`;
    data.agents[uuid] = {
      name: agentName,
      lastSeen: Date.now(),
    };

    await writeData(data);
    return { uuid, name: agentName };
  });
}

export interface SendResult {
  success: boolean;
  error?: string;
}

export async function send(
  fromUuid: string,
  toUuid: string,
  content: string
): Promise<SendResult> {
  return withLock(async () => {
    let data = await readData();
    data = cleanupData(data);

    if (!data.agents[toUuid]) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }

    if (data.agents[fromUuid]) {
      data.agents[fromUuid].lastSeen = Date.now();
    }

    const message: Message = {
      id: uuidv4(),
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
    };

    data.messages.push(message);
    await writeData(data);

    return { success: true };
  });
}

export interface ReceiveResult {
  messages: Array<{
    id: string;
    from: string;
    fromName?: string;
    content: string;
    timestamp: number;
  }>;
  agents: Array<{
    uuid: string;
    name: string;
    lastSeen: number;
  }>;
}

export async function receive(
  uuid: string,
  clear: boolean = true
): Promise<ReceiveResult> {
  return withLock(async () => {
    let data = await readData();
    data = cleanupData(data);

    if (data.agents[uuid]) {
      data.agents[uuid].lastSeen = Date.now();
    }

    const myMessages = data.messages.filter((msg) => msg.to === uuid);

    const messagesWithNames = myMessages.map((msg) => ({
      id: msg.id,
      from: msg.from,
      fromName: data.agents[msg.from]?.name,
      content: msg.content,
      timestamp: msg.timestamp,
    }));

    if (clear) {
      data.messages = data.messages.filter((msg) => msg.to !== uuid);
    }

    const agents = Object.entries(data.agents).map(([agentUuid, agent]) => ({
      uuid: agentUuid,
      name: agent.name,
      lastSeen: agent.lastSeen,
    }));

    await writeData(data);

    return {
      messages: messagesWithNames,
      agents,
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitResult extends ReceiveResult {
  timedOut: boolean;
}

export async function waitForMessages(
  uuid: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 2000
): Promise<WaitResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await receive(uuid, false);
    
    if (result.messages.length > 0) {
      const finalResult = await receive(uuid, true);
      return { ...finalResult, timedOut: false };
    }

    await sleep(pollIntervalMs);
  }

  const finalResult = await receive(uuid, false);
  return { ...finalResult, timedOut: true };
}
