#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR || path.join(os.homedir(), '.agent-comm');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const LOCK_DIR = path.join(DATA_DIR, '.lock');
const ACTIVE_PRESENCE_TTL_MS = 60 * 60 * 1000;

function uuid() {
  return crypto.randomUUID();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function acquireLock(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch {
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {}
      spawnSync('sleep', ['0.1']);
    }
  }

  throw new Error('Could not acquire lock');
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function createEmptyStore() {
  return {
    version: 2,
    participants: {},
    presence: {},
    groups: {},
    directMessages: [],
    groupMessages: [],
  };
}

function migrateLegacy(raw) {
  const data = createEmptyStore();
  const agents = raw && raw.agents ? raw.agents : {};
  const messages = raw && raw.messages ? raw.messages : [];
  const participantIds = new Set([...Object.keys(agents), ...messages.flatMap((message) => [message.from, message.to])]);
  const now = Date.now();

  for (const id of participantIds) {
    const agent = agents[id];
    data.participants[id] = {
      uuid: id,
      type: 'agent',
      name: (agent && agent.name) || `agent-${id.slice(0, 8)}`,
      createdAt: (agent && agent.lastSeen) || now,
    };
    if (agent) {
      data.presence[id] = { lastSeen: agent.lastSeen };
    }
  }

  data.directMessages = messages.map((message) => ({
    id: message.id,
    from: message.from,
    to: message.to,
    content: message.content,
    timestamp: message.timestamp,
    readAt: null,
  }));

  return data;
}

function cleanup(data) {
  const now = Date.now();
  const cleaned = {
    version: 2,
    participants: data.participants || {},
    presence: {},
    groups: {},
    directMessages: [],
    groupMessages: [],
  };

  for (const [id, presence] of Object.entries(data.presence || {})) {
    if (cleaned.participants[id] && now - presence.lastSeen < ACTIVE_PRESENCE_TTL_MS) {
      cleaned.presence[id] = presence;
    }
  }

  const groupMessages = Array.isArray(data.groupMessages) ? data.groupMessages : [];
  for (const [groupId, group] of Object.entries(data.groups || {})) {
    const members = {};
    for (const [memberUuid, membership] of Object.entries(group.members || {})) {
      if (cleaned.participants[memberUuid]) {
        members[memberUuid] = {
          joinedAt: membership.joinedAt,
          lastReadSequence: membership.lastReadSequence || 0,
        };
      }
    }

    const lastSequence = groupMessages
      .filter((message) => message.groupUuid === groupId)
      .reduce((max, message) => Math.max(max, message.sequence), group.lastSequence || 0);

    cleaned.groups[groupId] = { ...group, members, lastSequence };
  }

  const participantIds = new Set(Object.keys(cleaned.participants));
  const groupIds = new Set(Object.keys(cleaned.groups));
  cleaned.directMessages = (data.directMessages || []).filter(
    (message) => participantIds.has(message.from) && participantIds.has(message.to)
  );
  cleaned.groupMessages = groupMessages.filter(
    (message) => participantIds.has(message.from) && groupIds.has(message.groupUuid)
  );

  return cleaned;
}

function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && raw.version === 2) {
      return cleanup(raw);
    }
    return cleanup(migrateLegacy(raw));
  } catch {
    return createEmptyStore();
  }
}

function writeData(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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

function touchPresence(data, participantUuid) {
  if (data.participants[participantUuid]) {
    data.presence[participantUuid] = { lastSeen: Date.now() };
  }
}

function participantByName(data, type, name) {
  return Object.values(data.participants).find(
    (participant) => participant.type === type && participant.name === name
  );
}

function asActiveAgents(data) {
  return Object.values(data.participants)
    .filter((participant) => participant.type === 'agent' && data.presence[participant.uuid])
    .map((participant) => ({
      uuid: participant.uuid,
      type: participant.type,
      name: participant.name,
      createdAt: participant.createdAt,
      lastSeen: data.presence[participant.uuid].lastSeen,
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name));
}

function groupMessageSummary(data, message) {
  const sender = data.participants[message.from];
  const group = data.groups[message.groupUuid];
  return {
    id: message.id,
    groupUuid: message.groupUuid,
    groupName: group ? group.name : message.groupUuid,
    from: message.from,
    fromName: sender ? sender.name : message.from,
    fromType: sender ? sender.type : 'agent',
    content: message.content,
    timestamp: message.timestamp,
    sequence: message.sequence,
  };
}

function directMessageSummary(data, message) {
  const sender = data.participants[message.from];
  return {
    id: message.id,
    from: message.from,
    fromName: sender ? sender.name : message.from,
    fromType: sender ? sender.type : 'agent',
    to: message.to,
    content: message.content,
    timestamp: message.timestamp,
  };
}

function unreadGroupMessages(data, participantUuid) {
  const results = [];
  for (const group of Object.values(data.groups)) {
    const membership = group.members[participantUuid];
    if (!membership) continue;
    for (const message of data.groupMessages) {
      if (message.groupUuid === group.uuid && message.sequence > membership.lastReadSequence) {
        results.push(groupMessageSummary(data, message));
      }
    }
  }
  return results.sort((a, b) => a.timestamp - b.timestamp);
}

function groupsForParticipant(data, participantUuid) {
  return Object.values(data.groups)
    .filter((group) => group.members[participantUuid])
    .map((group) => {
      const unreadCount = data.groupMessages.filter((message) => {
        const membership = group.members[participantUuid];
        return message.groupUuid === group.uuid && membership && message.sequence > membership.lastReadSequence;
      }).length;
      const lastMessage = data.groupMessages
        .filter((message) => message.groupUuid === group.uuid)
        .sort((a, b) => b.sequence - a.sequence)[0] || null;
      const members = Object.entries(group.members).map(([memberUuid, membership]) => {
        const participant = data.participants[memberUuid];
        return {
          uuid: memberUuid,
          type: participant.type,
          name: participant.name,
          createdAt: participant.createdAt,
          joinedAt: membership.joinedAt,
          lastReadSequence: membership.lastReadSequence,
        };
      });
      return {
        uuid: group.uuid,
        name: group.name,
        createdBy: group.createdBy,
        createdAt: group.createdAt,
        unreadCount,
        memberCount: members.length,
        members,
        lastMessage: lastMessage ? groupMessageSummary(data, lastMessage) : null,
      };
    })
    .sort((a, b) => {
      const aTs = a.lastMessage ? a.lastMessage.timestamp : a.createdAt;
      const bTs = b.lastMessage ? b.lastMessage.timestamp : b.createdAt;
      return bTs - aTs || a.name.localeCompare(b.name);
    });
}

function registerAgent(name) {
  return withLock(() => {
    const data = readData();
    const existing = name ? participantByName(data, 'agent', name) : null;
    if (existing) {
      touchPresence(data, existing.uuid);
      writeData(data);
      return { uuid: existing.uuid, name: existing.name, type: 'agent' };
    }

    const id = uuid();
    data.participants[id] = {
      uuid: id,
      type: 'agent',
      name: name || `agent-${id.slice(0, 8)}`,
      createdAt: Date.now(),
    };
    touchPresence(data, id);
    writeData(data);
    return { uuid: id, name: data.participants[id].name, type: 'agent' };
  });
}

function sendDirectMessage(fromUuid, toUuid, content) {
  return withLock(() => {
    const data = readData();
    if (!data.participants[fromUuid]) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }
    if (!data.participants[toUuid]) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }
    touchPresence(data, fromUuid);
    data.directMessages.push({
      id: uuid(),
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
      readAt: null,
    });
    writeData(data);
    return { success: true };
  });
}

function createGroup(fromUuid, name) {
  return withLock(() => {
    const data = readData();
    if (!data.participants[fromUuid]) {
      return { success: false, error: `Participant ${fromUuid} not found` };
    }
    const groupUuid = uuid();
    const timestamp = Date.now();
    data.groups[groupUuid] = {
      uuid: groupUuid,
      name: name || `group-${groupUuid.slice(0, 8)}`,
      createdBy: fromUuid,
      createdAt: timestamp,
      lastSequence: 0,
      members: {
        [fromUuid]: { joinedAt: timestamp, lastReadSequence: 0 },
      },
    };
    touchPresence(data, fromUuid);
    writeData(data);
    return { success: true, group: groupsForParticipant(data, fromUuid).find((group) => group.uuid === groupUuid) };
  });
}

function joinGroup(participantUuid, groupUuid) {
  return withLock(() => {
    const data = readData();
    if (!data.participants[participantUuid]) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }
    const group = data.groups[groupUuid];
    if (!group) {
      return { success: false, error: `Group ${groupUuid} not found` };
    }
    if (!group.members[participantUuid]) {
      group.members[participantUuid] = { joinedAt: Date.now(), lastReadSequence: 0 };
    }
    touchPresence(data, participantUuid);
    writeData(data);
    return { success: true, group: groupsForParticipant(data, participantUuid).find((item) => item.uuid === groupUuid) };
  });
}

function leaveGroup(participantUuid, groupUuid) {
  return withLock(() => {
    const data = readData();
    const group = data.groups[groupUuid];
    if (!group || !group.members[participantUuid]) {
      return { success: false, error: `Group ${groupUuid} not found or not joined` };
    }
    delete group.members[participantUuid];
    touchPresence(data, participantUuid);
    writeData(data);
    return { success: true };
  });
}

function sendGroupMessage(fromUuid, groupUuid, content) {
  return withLock(() => {
    const data = readData();
    const group = data.groups[groupUuid];
    if (!data.participants[fromUuid]) {
      return { success: false, error: `Participant ${fromUuid} not found` };
    }
    if (!group || !group.members[fromUuid]) {
      return { success: false, error: `Group ${groupUuid} not found or not joined` };
    }
    group.lastSequence += 1;
    data.groupMessages.push({
      id: uuid(),
      groupUuid,
      from: fromUuid,
      content,
      timestamp: Date.now(),
      sequence: group.lastSequence,
    });
    group.members[fromUuid].lastReadSequence = group.lastSequence;
    touchPresence(data, fromUuid);
    writeData(data);
    return { success: true };
  });
}

function receive(participantUuid, clear = true) {
  return withLock(() => {
    const data = readData();
    if (!data.participants[participantUuid]) {
      return null;
    }

    touchPresence(data, participantUuid);

    const directMessages = data.directMessages
      .filter((message) => message.to === participantUuid && message.readAt === null)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((message) => directMessageSummary(data, message));
    const groupMessages = unreadGroupMessages(data, participantUuid);

    if (clear) {
      const now = Date.now();
      for (const message of data.directMessages) {
        if (message.to === participantUuid && message.readAt === null) {
          message.readAt = now;
        }
      }
      for (const group of Object.values(data.groups)) {
        if (group.members[participantUuid]) {
          group.members[participantUuid].lastReadSequence = group.lastSequence;
        }
      }
    }

    const result = {
      directMessages,
      groupMessages,
      groups: groupsForParticipant(data, participantUuid),
      activeAgents: asActiveAgents(data),
    };

    writeData(data);
    return result;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMessages(participantUuid, timeoutMs = 60000, pollMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = receive(participantUuid, false);
    if (!result) {
      return null;
    }
    if (result.directMessages.length > 0 || result.groupMessages.length > 0) {
      return { ...receive(participantUuid, true), timedOut: false };
    }
    await sleep(pollMs);
  }
  return { ...receive(participantUuid, false), timedOut: true };
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'register':
      console.log(JSON.stringify(registerAgent(flag(args, 'name')), null, 2));
      break;
    case 'send':
      console.log(JSON.stringify(sendDirectMessage(flag(args, 'from'), flag(args, 'to'), flag(args, 'message')), null, 2));
      break;
    case 'receive':
      console.log(JSON.stringify(receive(flag(args, 'uuid'), flag(args, 'clear') !== 'false'), null, 2));
      break;
    case 'wait': {
      const timeout = parseInt(flag(args, 'timeout') || '60', 10) * 1000;
      const poll = parseInt(flag(args, 'poll') || '2', 10) * 1000;
      console.log(JSON.stringify(await waitForMessages(flag(args, 'uuid'), timeout, poll), null, 2));
      break;
    }
    case 'send-and-wait': {
      const timeout = parseInt(flag(args, 'timeout') || '120', 10) * 1000;
      const sendResult = sendDirectMessage(flag(args, 'from'), flag(args, 'to'), flag(args, 'message'));
      if (!sendResult.success) {
        console.log(JSON.stringify({ ...sendResult, phase: 'send' }, null, 2));
        break;
      }
      console.log(JSON.stringify(await waitForMessages(flag(args, 'from'), timeout, 2000), null, 2));
      break;
    }
    case 'group-create':
      console.log(JSON.stringify(createGroup(flag(args, 'uuid'), flag(args, 'name')), null, 2));
      break;
    case 'group-join':
      console.log(JSON.stringify(joinGroup(flag(args, 'uuid'), flag(args, 'group')), null, 2));
      break;
    case 'group-leave':
      console.log(JSON.stringify(leaveGroup(flag(args, 'uuid'), flag(args, 'group')), null, 2));
      break;
    case 'group-send':
      console.log(JSON.stringify(sendGroupMessage(flag(args, 'uuid'), flag(args, 'group'), flag(args, 'message')), null, 2));
      break;
    case 'group-list':
      console.log(JSON.stringify(withLock(() => {
        const data = readData();
        touchPresence(data, flag(args, 'uuid'));
        writeData(data);
        return groupsForParticipant(data, flag(args, 'uuid'));
      }), null, 2));
      break;
    default:
      console.error(`Usage: agent-comm.js <command> [flags]\n\nCommands:\n  register      --name <name>\n  send          --from <uuid> --to <uuid> --message <text>\n  receive       --uuid <uuid> [--clear false]\n  wait          --uuid <uuid> [--timeout <seconds>] [--poll <seconds>]\n  send-and-wait --from <uuid> --to <uuid> --message <text> [--timeout <seconds>]\n  group-create  --uuid <uuid> [--name <name>]\n  group-join    --uuid <uuid> --group <group-uuid>\n  group-leave   --uuid <uuid> --group <group-uuid>\n  group-send    --uuid <uuid> --group <group-uuid> --message <text>\n  group-list    --uuid <uuid>`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
