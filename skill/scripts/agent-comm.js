#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DATA_DIR = path.join(os.homedir(), ".agent-comm");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const LOCK_DIR = path.join(DATA_DIR, ".lock");

const AGENT_TTL_MS = 60 * 60 * 1000;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function uuid() {
  return crypto.randomUUID();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function acquireLock(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return true;
    } catch {
      // Check for stale lock (older than 10 seconds)
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch {}
      // Brief sync sleep via spawnSync
      require("child_process").spawnSync("sleep", ["0.1"]);
    }
  }
  throw new Error("Could not acquire lock");
}

function releaseLock() {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {}
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { agents: {}, messages: [] };
  }
}

function writeData(data) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function cleanup(data) {
  const now = Date.now();
  const agents = {};
  for (const [id, agent] of Object.entries(data.agents)) {
    if (now - agent.lastSeen < AGENT_TTL_MS) agents[id] = agent;
  }
  const valid = new Set(Object.keys(agents));
  const messages = data.messages.filter(
    (m) => now - m.timestamp < MESSAGE_TTL_MS && valid.has(m.to)
  );
  return { agents, messages };
}

function withLock(fn) {
  ensureDataDir();
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function doRegister(name) {
  return withLock(() => {
    let data = cleanup(readData());

    if (name) {
      for (const [id, agent] of Object.entries(data.agents)) {
        if (agent.name === name) {
          agent.lastSeen = Date.now();
          writeData(data);
          return { uuid: id, name: agent.name };
        }
      }
    }

    const id = uuid();
    const agentName = name || `agent-${id.slice(0, 8)}`;
    data.agents[id] = { name: agentName, lastSeen: Date.now() };
    writeData(data);
    return { uuid: id, name: agentName };
  });
}

function doSend(fromUuid, toUuid, content) {
  return withLock(() => {
    let data = cleanup(readData());

    if (!data.agents[toUuid]) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }

    if (data.agents[fromUuid]) {
      data.agents[fromUuid].lastSeen = Date.now();
    }

    data.messages.push({
      id: uuid(),
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
    });
    writeData(data);
    return { success: true };
  });
}

function doReceive(myUuid, clear = true) {
  return withLock(() => {
    let data = cleanup(readData());

    if (data.agents[myUuid]) {
      data.agents[myUuid].lastSeen = Date.now();
    }

    const mine = data.messages.filter((m) => m.to === myUuid);
    const messages = mine.map((m) => ({
      id: m.id,
      from: m.from,
      fromName: data.agents[m.from]?.name,
      content: m.content,
      timestamp: m.timestamp,
    }));

    if (clear) {
      data.messages = data.messages.filter((m) => m.to !== myUuid);
    }

    const agents = Object.entries(data.agents).map(([id, a]) => ({
      uuid: id,
      name: a.name,
      lastSeen: a.lastSeen,
    }));

    writeData(data);
    return { messages, agents };
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function doWait(myUuid, timeoutMs = 60000, pollMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = doReceive(myUuid, false);
    if (result.messages.length > 0) {
      return { ...doReceive(myUuid, true), timedOut: false };
    }
    await sleep(pollMs);
  }
  return { ...doReceive(myUuid, false), timedOut: true };
}

async function doSendAndWait(fromUuid, toUuid, content, timeoutMs = 120000) {
  const sendResult = doSend(fromUuid, toUuid, content);
  if (!sendResult.success) {
    return { ...sendResult, phase: "send" };
  }
  const waitResult = await doWait(fromUuid, timeoutMs);
  return { sentTo: toUuid, sentMessage: content, ...waitResult };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  function flag(name) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  }

  switch (cmd) {
    case "register": {
      const result = doRegister(flag("name"));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "send": {
      const result = doSend(flag("from"), flag("to"), flag("message"));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "receive": {
      const clear = flag("clear") !== "false";
      const result = doReceive(flag("uuid"), clear);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "wait": {
      const timeout = parseInt(flag("timeout") || "60") * 1000;
      const poll = parseInt(flag("poll") || "2") * 1000;
      const result = await doWait(flag("uuid"), timeout, poll);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "send-and-wait": {
      const timeout = parseInt(flag("timeout") || "120") * 1000;
      const result = await doSendAndWait(
        flag("from"),
        flag("to"),
        flag("message"),
        timeout
      );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error(`Usage: agent-comm.js <command> [flags]

Commands:
  register    --name <name>
  send        --from <uuid> --to <uuid> --message <text>
  receive     --uuid <uuid> [--clear false]
  wait        --uuid <uuid> [--timeout <seconds>] [--poll <seconds>]
  send-and-wait --from <uuid> --to <uuid> --message <text> [--timeout <seconds>]`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
