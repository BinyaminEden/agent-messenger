#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR || path.join(os.homedir(), '.agent-comm');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');
const IDENTITY_FILE = path.join(DATA_DIR, 'identities.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOCK_DIR = path.join(DATA_DIR, '.lock');
const ACTIVE_PRESENCE_TTL_MS = 60 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 150;
const DEFAULT_FALLBACK_POLL_MS = 15000;

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

// ---------------------------------------------------------------------------
// v3 store shape: data.json (durable, lock-guarded) + presence.json (best-effort)
// ---------------------------------------------------------------------------

function createEmptyStore() {
  return {
    version: 3,
    participants: {},
    groups: {},
    directMessages: [],
    groupMessages: [],
  };
}

function migrateLegacy(raw) {
  const data = createEmptyStore();
  const presence = {};
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
      presence[id] = { lastSeen: agent.lastSeen };
    }
  }

  data.directMessages = messages.map((message) => ({
    id: message.id,
    from: message.from,
    to: message.to,
    content: message.content,
    timestamp: message.timestamp,
    readAt: null,
    replyTo: null,
  }));

  return { data, presence };
}

function migrateV2(raw) {
  const data = {
    version: 3,
    participants: raw.participants || {},
    groups: raw.groups || {},
    directMessages: (raw.directMessages || []).map((message) => ({
      ...message,
      replyTo: message.replyTo ?? null,
    })),
    groupMessages: raw.groupMessages || [],
  };
  const presence = raw.presence && typeof raw.presence === 'object' ? raw.presence : {};
  return { data, presence };
}

function cleanup(data) {
  const cleaned = {
    version: 3,
    participants: data.participants || {},
    groups: {},
    directMessages: [],
    groupMessages: [],
  };

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
  cleaned.directMessages = (data.directMessages || [])
    .filter((message) => participantIds.has(message.from) && participantIds.has(message.to))
    .map((message) => ({ ...message, replyTo: message.replyTo ?? null }));
  cleaned.groupMessages = groupMessages.filter(
    (message) => participantIds.has(message.from) && groupIds.has(message.groupUuid)
  );

  return cleaned;
}

// Move a legacy/v2 in-file presence map into presence.json, but only if
// presence.json does not already exist (never clobber a newer presence file).
function migratePresenceIfAbsent(presence) {
  try {
    if (!presence || Object.keys(presence).length === 0) {
      return;
    }
    if (fs.existsSync(PRESENCE_FILE)) {
      return;
    }
    ensureDataDir();
    writePresenceStore({ version: 1, presence });
  } catch {
    // best-effort
  }
}

function normalize(raw) {
  if (raw && typeof raw === 'object' && raw.version === 3 && raw.participants && raw.groups) {
    return cleanup(raw);
  }
  if (raw && typeof raw === 'object' && raw.version === 2 && raw.participants && raw.groups) {
    const { data, presence } = migrateV2(raw);
    migratePresenceIfAbsent(presence);
    return cleanup(data);
  }
  const { data, presence } = migrateLegacy(raw);
  migratePresenceIfAbsent(presence);
  return cleanup(data);
}

function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return normalize(raw);
  } catch {
    return createEmptyStore();
  }
}

function writeData(data) {
  const payload = {
    version: 3,
    participants: data.participants,
    groups: data.groups,
    directMessages: data.directMessages,
    groupMessages: data.groupMessages,
  };
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------------
// presence.json — best-effort, NO lock, atomic tmp+rename.
// ---------------------------------------------------------------------------

function readPresence() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
    return (parsed && parsed.presence) || {};
  } catch {
    return {};
  }
}

function writePresenceStore(store) {
  const tmp = `${PRESENCE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, PRESENCE_FILE);
}

function writePresence(uuids) {
  try {
    const list = Array.isArray(uuids) ? uuids : [uuids];
    const filtered = list.filter(Boolean);
    if (filtered.length === 0) {
      return;
    }
    ensureDataDir();
    const current = readPresence();
    const now = Date.now();
    for (const id of filtered) {
      current[id] = { lastSeen: now };
    }
    writePresenceStore({ version: 1, presence: current });
  } catch {
    // best-effort
  }
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

// ---------------------------------------------------------------------------
// Active wake mechanism (mirror of src/notify.ts, generic adapter contract).
//
// The Stop hook is the passive wake layer; this is the active one. After a send,
// if the recipient stays idle with unread mail, invoke a user-configured command
// (env AGENT_MESSENGER_WAKE_CMD, else `wakeCommand` in <data dir>/config.json).
// It receives one JSON object on stdin (recipient_uuid, recipient_name,
// session_id, session_cwd, unread_count, from_names). This file has ZERO
// knowledge of any specific terminal/dashboard stack.
//
// NOTE: unlike the long-lived MCP server (which debounces via an unref'd timer),
// this CLI is short-lived and cannot hold a timer past process exit, so it fires
// IMMEDIATELY and synchronously after the send (no debounce window). The adapter
// is spawned detached so it outlives the CLI. Always fail-silent.
// ---------------------------------------------------------------------------

function resolveWakeCommand() {
  const fromEnv = process.env.AGENT_MESSENGER_WAKE_CMD;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const command = parsed && parsed.wakeCommand;
    if (typeof command === 'string' && command.trim().length > 0) {
      return command;
    }
  } catch {
    // no config / unreadable / malformed → no adapter
  }
  return null;
}

function readSessionRecord(uuid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    const record = parsed && parsed.sessions && parsed.sessions[uuid];
    return record && record.uuid === uuid ? record : null;
  } catch {
    return null;
  }
}

function gatherRecipientInfo(data, uuid) {
  const nameOf = (senderUuid) =>
    (data.participants[senderUuid] && data.participants[senderUuid].name) || senderUuid;

  const fromNames = [];
  const seen = new Set();
  let unread = 0;

  for (const message of data.directMessages) {
    if (message.to === uuid && message.readAt === null) {
      unread += 1;
      if (!seen.has(message.from)) {
        seen.add(message.from);
        fromNames.push(nameOf(message.from));
      }
    }
  }
  for (const group of Object.values(data.groups)) {
    const membership = group.members && group.members[uuid];
    if (!membership) continue;
    const lastRead = membership.lastReadSequence || 0;
    for (const message of data.groupMessages) {
      if (message.groupUuid === group.uuid && message.sequence > lastRead) {
        unread += 1;
        if (!seen.has(message.from)) {
          seen.add(message.from);
          fromNames.push(nameOf(message.from));
        }
      }
    }
  }

  const session = readSessionRecord(uuid);
  return {
    recipient_uuid: uuid,
    recipient_name: (data.participants[uuid] && data.participants[uuid].name) || uuid,
    session_id: session ? uuid : null,
    session_cwd: (session && session.cwd) || null,
    unread_count: unread,
    from_names: fromNames,
  };
}

function spawnAdapter(command, payload) {
  try {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    }
    child.unref();
  } catch {
    // a broken adapter must never affect the caller
  }
}

// Immediately wake each recipient that currently has unread mail.
function wakeRecipients(recipientUuids) {
  try {
    const command = resolveWakeCommand();
    if (!command) return;
    const data = readData();
    const seen = new Set();
    for (const uuid of recipientUuids) {
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      const payload = gatherRecipientInfo(data, uuid);
      if (payload.unread_count > 0) {
        spawnAdapter(command, payload);
      }
    }
  } catch {
    // fail-silent
  }
}

function participantByName(data, type, name) {
  if (!name) return undefined;
  return Object.values(data.participants).find(
    (participant) => participant.type === type && participant.name === name
  );
}

function findGroupByName(data, name) {
  const normalized = name.trim().toLowerCase();
  const matches = Object.values(data.groups).filter(
    (group) => group.name.trim().toLowerCase() === normalized
  );
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => a.createdAt - b.createdAt || a.uuid.localeCompare(b.uuid))[0];
}

function asActiveAgents(data, presence) {
  const now = Date.now();
  return Object.values(data.participants)
    .filter((participant) => {
      if (participant.type !== 'agent') return false;
      const entry = presence[participant.uuid];
      return Boolean(entry) && now - entry.lastSeen < ACTIVE_PRESENCE_TTL_MS;
    })
    .map((participant) => ({
      uuid: participant.uuid,
      type: participant.type,
      name: participant.name,
      createdAt: participant.createdAt,
      lastSeen: presence[participant.uuid].lastSeen,
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
    replyTo: message.replyTo ?? null,
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
      const members = Object.entries(group.members)
        .map(([memberUuid, membership]) => {
          const participant = data.participants[memberUuid];
          if (!participant) return null;
          return {
            uuid: memberUuid,
            type: participant.type,
            name: participant.name,
            createdAt: participant.createdAt,
            joinedAt: membership.joinedAt,
            lastReadSequence: membership.lastReadSequence,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
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

// ---------------------------------------------------------------------------
// Identity + reference resolution.
// ---------------------------------------------------------------------------

function registerParticipant(type, name, participantUuid) {
  const result = withLock(() => {
    const data = readData();

    if (participantUuid && data.participants[participantUuid] && data.participants[participantUuid].type === type) {
      if (name) {
        data.participants[participantUuid].name = name;
        writeData(data);
      }
      return { uuid: participantUuid, name: data.participants[participantUuid].name, type };
    }

    const existing = participantByName(data, type, name);
    if (existing) {
      return { uuid: existing.uuid, name: existing.name, type };
    }

    const id = uuid();
    const participantName = name || `${type}-${id.slice(0, 8)}`;
    data.participants[id] = {
      uuid: id,
      type,
      name: participantName,
      createdAt: Date.now(),
    };
    writeData(data);
    return { uuid: id, name: participantName, type };
  });

  writePresence(result.uuid);
  return result;
}

function registerAgent(name) {
  return registerParticipant('agent', name);
}

// Record cwd -> identity so the Stop hook can recover this exact identity
// instead of re-deriving one from its own (possibly drifted) cwd.
function persistIdentity(cwd, identity) {
  try {
    ensureDataDir();
    let key = cwd;
    try {
      key = fs.realpathSync(cwd);
    } catch {}
    let identities = {};
    let sessions = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
      identities = (parsed && parsed.identities) || {};
      // Preserve session records written by the SessionStart hook.
      sessions = (parsed && parsed.sessions) || {};
    } catch {}
    identities[key] = { uuid: identity.uuid, name: identity.name, cwd: key, updatedAt: Date.now() };
    const tmp = `${IDENTITY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, identities, sessions }, null, 2));
    fs.renameSync(tmp, IDENTITY_FILE);
  } catch {
    // best-effort
  }
}

function resolveIdentity(cwd = process.cwd()) {
  const envName = process.env.AGENT_MESSENGER_NAME;
  let name;
  if (envName && envName.trim().length > 0) {
    name = envName;
  } else {
    const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 6);
    name = `${path.basename(cwd)}-${hash}`;
  }
  const result = registerParticipant('agent', name);
  persistIdentity(cwd, result);
  return result;
}

// mirror of resolveParticipantRef — pure read, no lock. Resolves by exact uuid,
// exact name, then a unique UUID prefix (min 6 chars, the statusline short id).
const MIN_UUID_PREFIX = 6;
function resolveRef(ref) {
  const data = readData();
  if (data.participants[ref]) {
    return { uuid: ref };
  }

  const nameMatches = Object.values(data.participants).filter((participant) => participant.name === ref);
  if (nameMatches.length === 1) {
    return { uuid: nameMatches[0].uuid };
  }
  if (nameMatches.length > 1) {
    return { error: `Ambiguous name '${ref}' → uuids: ${nameMatches.map((m) => m.uuid).join(', ')}` };
  }

  const prefixMatches = Object.values(data.participants).filter((participant) =>
    participant.uuid.startsWith(ref)
  );
  if (prefixMatches.length > 0 && ref.length < MIN_UUID_PREFIX) {
    return { error: `UUID prefix '${ref}' too short (min ${MIN_UUID_PREFIX} chars)` };
  }
  if (ref.length >= MIN_UUID_PREFIX && prefixMatches.length === 1) {
    return { uuid: prefixMatches[0].uuid };
  }
  if (ref.length >= MIN_UUID_PREFIX && prefixMatches.length > 1) {
    return { error: `Ambiguous UUID prefix '${ref}' → uuids: ${prefixMatches.map((m) => m.uuid).join(', ')}` };
  }

  return { error: `No participant named '${ref}'` };
}

// Resolve a --from/--uuid flag, falling back to the auto project identity.
// When explicit is provided, resolve it through resolveRef (name→uuid) so the
// documented <name|uuid> forms work, and exit clearly on not-found/ambiguous.
function resolveSelf(explicit) {
  if (explicit) {
    const resolved = resolveRef(explicit);
    if (resolved.error) {
      console.log(JSON.stringify({ success: false, error: resolved.error }, null, 2));
      process.exit(1);
    }
    return resolved.uuid;
  }
  return resolveIdentity().uuid;
}

// ---------------------------------------------------------------------------
// Direct messages + request/reply.
// ---------------------------------------------------------------------------

function sendDirectMessage(fromUuid, toUuid, content, replyTo = null) {
  const outcome = withLock(() => {
    const data = readData();
    if (!data.participants[fromUuid]) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }
    if (!data.participants[toUuid]) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }
    const id = uuid();
    data.directMessages.push({
      id,
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
      readAt: null,
      replyTo: replyTo ?? null,
    });
    writeData(data);
    return { success: true, messageId: id };
  });
  if (outcome.success) {
    writePresence(fromUuid);
    wakeRecipients([toUuid]);
  }
  return outcome;
}

function replyToMessage(fromUuid, originalMessageId, content) {
  let recipientUuid = null;
  const outcome = withLock(() => {
    const data = readData();
    if (!data.participants[fromUuid]) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }
    const original = data.directMessages.find((message) => message.id === originalMessageId);
    if (!original) {
      return { success: false, error: `Original message ${originalMessageId} not found` };
    }
    const toUuid = original.from;
    if (!data.participants[toUuid]) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }
    const id = uuid();
    data.directMessages.push({
      id,
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
      readAt: null,
      replyTo: originalMessageId,
    });
    recipientUuid = toUuid;
    writeData(data);
    return { success: true, messageId: id };
  });
  if (outcome.success) {
    writePresence(fromUuid);
    if (recipientUuid) {
      wakeRecipients([recipientUuid]);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Groups + channels.
// ---------------------------------------------------------------------------

function createGroup(fromUuid, name) {
  const result = withLock(() => {
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
    writeData(data);
    return { success: true, group: groupsForParticipant(data, fromUuid).find((group) => group.uuid === groupUuid) };
  });
  if (result.success) {
    writePresence(fromUuid);
  }
  return result;
}

function joinGroup(participantUuid, groupUuid) {
  const result = withLock(() => {
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
    writeData(data);
    return { success: true, group: groupsForParticipant(data, participantUuid).find((item) => item.uuid === groupUuid) };
  });
  if (result.success) {
    writePresence(participantUuid);
  }
  return result;
}

function joinChannel(participantUuid, name) {
  const result = withLock(() => {
    const data = readData();
    if (!data.participants[participantUuid]) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }
    let group = findGroupByName(data, name);
    if (!group) {
      const groupUuid = uuid();
      const timestamp = Date.now();
      group = {
        uuid: groupUuid,
        name,
        createdBy: participantUuid,
        createdAt: timestamp,
        lastSequence: 0,
        members: {},
      };
      data.groups[groupUuid] = group;
    }
    if (!group.members[participantUuid]) {
      group.members[participantUuid] = { joinedAt: Date.now(), lastReadSequence: 0 };
    }
    writeData(data);
    return { success: true, group: groupsForParticipant(data, participantUuid).find((item) => item.uuid === group.uuid) };
  });
  if (result.success) {
    writePresence(participantUuid);
  }
  return result;
}

function leaveGroup(participantUuid, groupUuid) {
  const result = withLock(() => {
    const data = readData();
    const group = data.groups[groupUuid];
    if (!group || !group.members[participantUuid]) {
      return { success: false, error: `Group ${groupUuid} not found or not joined` };
    }
    delete group.members[participantUuid];
    writeData(data);
    return { success: true };
  });
  if (result.success) {
    writePresence(participantUuid);
  }
  return result;
}

function sendGroupMessage(fromUuid, groupUuid, content) {
  let recipients = [];
  const result = withLock(() => {
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
    recipients = Object.keys(group.members).filter((member) => member !== fromUuid);
    writeData(data);
    return { success: true };
  });
  if (result.success) {
    writePresence(fromUuid);
    wakeRecipients(recipients);
  }
  return result;
}

function sendChannelMessage(participantUuid, name, content) {
  let recipients = [];
  const result = withLock(() => {
    const data = readData();
    if (!data.participants[participantUuid]) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }
    const group = findGroupByName(data, name);
    if (!group) {
      return { success: false, error: `Channel '${name}' not found` };
    }
    if (!group.members[participantUuid]) {
      return { success: false, error: `Not a member of channel '${name}'` };
    }
    group.lastSequence += 1;
    data.groupMessages.push({
      id: uuid(),
      groupUuid: group.uuid,
      from: participantUuid,
      content,
      timestamp: Date.now(),
      sequence: group.lastSequence,
    });
    group.members[participantUuid].lastReadSequence = group.lastSequence;
    recipients = Object.keys(group.members).filter((member) => member !== participantUuid);
    writeData(data);
    return { success: true };
  });
  if (result.success) {
    writePresence(participantUuid);
    wakeRecipients(recipients);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Inbox reads (clear=true takes the lock; clear=false is a pure read).
// ---------------------------------------------------------------------------

function receive(participantUuid, clear = true) {
  if (clear) {
    const result = withLock(() => {
      const data = readData();
      if (!data.participants[participantUuid]) {
        return null;
      }
      const presence = { ...readPresence(), [participantUuid]: { lastSeen: Date.now() } };

      const directMessages = data.directMessages
        .filter((message) => message.to === participantUuid && message.readAt === null)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((message) => directMessageSummary(data, message));
      const groupMessages = unreadGroupMessages(data, participantUuid);

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

      const outcome = {
        directMessages,
        groupMessages,
        groups: groupsForParticipant(data, participantUuid),
        activeAgents: asActiveAgents(data, presence),
      };
      writeData(data);
      return outcome;
    });
    if (result !== null) {
      writePresence(participantUuid);
    }
    return result;
  }

  // Lock-free read path — never rewrites data.json.
  const data = readData();
  if (!data.participants[participantUuid]) {
    return null;
  }
  const presence = { ...readPresence(), [participantUuid]: { lastSeen: Date.now() } };
  const directMessages = data.directMessages
    .filter((message) => message.to === participantUuid && message.readAt === null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((message) => directMessageSummary(data, message));
  const groupMessages = unreadGroupMessages(data, participantUuid);
  writePresence(participantUuid);
  return {
    directMessages,
    groupMessages,
    groups: groupsForParticipant(data, participantUuid),
    activeAgents: asActiveAgents(data, presence),
  };
}

// ---------------------------------------------------------------------------
// Event-driven wait machinery (fs.watch on the directory + fallback poll).
// ---------------------------------------------------------------------------

function watchData(onChange, fallbackPollMs = DEFAULT_FALLBACK_POLL_MS) {
  let debounce = null;
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  let watcher = null;
  try {
    watcher = fs.watch(DATA_DIR, (_event, filename) => {
      if (!filename) {
        schedule();
        return;
      }
      const name = filename.toString();
      if (name.endsWith('.tmp') || name.includes('.lock')) {
        return;
      }
      if (name === 'data.json') {
        schedule();
      }
    });
  } catch {
    watcher = null;
  }

  const interval = setInterval(onChange, fallbackPollMs);

  return () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    clearInterval(interval);
    if (watcher) {
      try {
        watcher.close();
      } catch {}
    }
  };
}

function waitForMessages(participantUuid, timeoutMs = 60000, fallbackPollMs = DEFAULT_FALLBACK_POLL_MS) {
  const immediate = receive(participantUuid, false);
  if (immediate === null) {
    return Promise.resolve(null);
  }
  if (immediate.directMessages.length > 0 || immediate.groupMessages.length > 0) {
    const consumed = receive(participantUuid, true);
    return Promise.resolve(consumed ? { ...consumed, timedOut: false } : null);
  }

  ensureDataDir();

  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    let dispose = () => {};
    let timer;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      dispose();
      clearTimeout(timer);
      resolve(value);
    };

    const check = () => {
      if (settled || busy) return;
      busy = true;
      try {
        const snapshot = receive(participantUuid, false);
        if (settled) return;
        if (snapshot === null) {
          settle(null);
          return;
        }
        if (snapshot.directMessages.length > 0 || snapshot.groupMessages.length > 0) {
          const consumed = receive(participantUuid, true);
          if (settled) return;
          settle(consumed ? { ...consumed, timedOut: false } : null);
        }
      } finally {
        busy = false;
      }
    };

    timer = setTimeout(() => {
      const final = receive(participantUuid, false);
      settle(final ? { ...final, timedOut: true } : null);
    }, timeoutMs);
    dispose = watchData(check, fallbackPollMs);
  });
}

function waitForReply(participantUuid, correlationMessageId, timeoutMs, fallbackPollMs = DEFAULT_FALLBACK_POLL_MS) {
  const scan = () => {
    const data = readData();
    return data.directMessages.some(
      (message) =>
        message.to === participantUuid &&
        message.readAt === null &&
        message.replyTo === correlationMessageId
    );
  };

  const consume = () =>
    withLock(() => {
      const data = readData();
      const match = data.directMessages.find(
        (message) =>
          message.to === participantUuid &&
          message.readAt === null &&
          message.replyTo === correlationMessageId
      );
      if (!match) return null;
      match.readAt = Date.now();
      const summary = directMessageSummary(data, match);
      writeData(data);
      return summary;
    });

  if (scan()) {
    const message = consume();
    if (message) {
      writePresence(participantUuid);
      return Promise.resolve({ message, timedOut: false });
    }
  }

  ensureDataDir();

  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    let dispose = () => {};
    let timer;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      dispose();
      clearTimeout(timer);
      resolve(value);
    };

    const check = () => {
      if (settled || busy) return;
      busy = true;
      try {
        if (scan()) {
          const message = consume();
          if (settled) return;
          if (message) {
            writePresence(participantUuid);
            settle({ message, timedOut: false });
          }
        }
      } finally {
        busy = false;
      }
    };

    timer = setTimeout(() => settle({ message: null, timedOut: true }), timeoutMs);
    dispose = watchData(check, fallbackPollMs);
  });
}

// ---------------------------------------------------------------------------
// CLI dispatch.
// ---------------------------------------------------------------------------

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

// Resolve a name-or-UUID target; print the error and exit on failure.
function resolveTargetOrExit(ref) {
  const resolved = resolveRef(ref);
  if (resolved.error) {
    console.log(JSON.stringify({ success: false, error: resolved.error }, null, 2));
    process.exit(1);
  }
  return resolved.uuid;
}

const USAGE = `Usage: agent-comm.js <command> [flags]

Identity auto-resolves per session (SessionStart hook) or per project
(AGENT_MESSENGER_NAME env, else <basename>-<hash6>).
--from / --uuid are optional; when omitted the resolved identity is used.
Every <name|uuid> reference accepts a name, a full UUID, or a unique UUID
prefix (min 6 chars, e.g. the statusline short id).

Commands:
  whoami
  register       [--name <name>]
  send           [--from <name|uuid>] --to <name|uuid> --message <text>
  ask            [--from <name|uuid>] --to <name|uuid> --message <text> [--timeout <seconds>]
  reply          [--from <name|uuid>] --to-message <message-id> --message <text>
  receive        [--uuid <name|uuid>] [--clear false]
  wait           [--uuid <name|uuid>] [--timeout <seconds>] [--poll <seconds>]
  send-and-wait  [--from <name|uuid>] --to <name|uuid> --message <text> [--timeout <seconds>]
  channel-join   [--uuid <name|uuid>] --name <name>
  channel-send   [--uuid <name|uuid>] --name <name> --message <text>
  group-create   [--uuid <name|uuid>] [--name <name>]
  group-join     [--uuid <name|uuid>] --group <group-uuid>
  group-leave    [--uuid <name|uuid>] --group <group-uuid>
  group-send     [--uuid <name|uuid>] --group <group-uuid> --message <text>
  group-list     [--uuid <name|uuid>]`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'whoami':
      console.log(JSON.stringify(resolveIdentity(), null, 2));
      break;
    case 'register': {
      const registered = registerAgent(flag(args, 'name'));
      // Parity with resolveIdentity / the MCP server: record cwd -> identity so
      // the Stop hook can recover this agent's identity for this project.
      persistIdentity(process.cwd(), registered);
      console.log(JSON.stringify(registered, null, 2));
      break;
    }
    case 'send': {
      const from = resolveSelf(flag(args, 'from'));
      const to = resolveTargetOrExit(flag(args, 'to'));
      console.log(JSON.stringify(sendDirectMessage(from, to, flag(args, 'message')), null, 2));
      break;
    }
    case 'ask': {
      const from = resolveSelf(flag(args, 'from'));
      const to = resolveTargetOrExit(flag(args, 'to'));
      const timeout = parseInt(flag(args, 'timeout') || '120', 10) * 1000;
      const sendResult = sendDirectMessage(from, to, flag(args, 'message'));
      if (!sendResult.success || !sendResult.messageId) {
        console.log(JSON.stringify({ ...sendResult, phase: 'send' }, null, 2));
        break;
      }
      const askResult = await waitForReply(from, sendResult.messageId, timeout);
      console.log(
        JSON.stringify(
          {
            yourUuid: from,
            sentTo: to,
            messageId: sendResult.messageId,
            timedOut: askResult.timedOut,
            reply: askResult.message,
          },
          null,
          2
        )
      );
      break;
    }
    case 'reply': {
      const from = resolveSelf(flag(args, 'from'));
      console.log(
        JSON.stringify(replyToMessage(from, flag(args, 'to-message'), flag(args, 'message')), null, 2)
      );
      break;
    }
    case 'receive': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(receive(uuid, flag(args, 'clear') !== 'false'), null, 2));
      break;
    }
    case 'wait': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      const timeout = parseInt(flag(args, 'timeout') || '60', 10) * 1000;
      const poll = parseInt(flag(args, 'poll') || '15', 10) * 1000;
      console.log(JSON.stringify(await waitForMessages(uuid, timeout, poll), null, 2));
      break;
    }
    case 'send-and-wait': {
      const from = resolveSelf(flag(args, 'from'));
      const to = resolveTargetOrExit(flag(args, 'to'));
      const timeout = parseInt(flag(args, 'timeout') || '120', 10) * 1000;
      const sendResult = sendDirectMessage(from, to, flag(args, 'message'));
      if (!sendResult.success) {
        console.log(JSON.stringify({ ...sendResult, phase: 'send' }, null, 2));
        break;
      }
      console.log(JSON.stringify(await waitForMessages(from, timeout), null, 2));
      break;
    }
    case 'channel-join': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(joinChannel(uuid, flag(args, 'name')), null, 2));
      break;
    }
    case 'channel-send': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      const name = flag(args, 'name');
      const joinResult = joinChannel(uuid, name);
      if (!joinResult.success) {
        console.log(JSON.stringify({ ...joinResult, phase: 'join' }, null, 2));
        break;
      }
      console.log(JSON.stringify(sendChannelMessage(uuid, name, flag(args, 'message')), null, 2));
      break;
    }
    case 'group-create': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(createGroup(uuid, flag(args, 'name')), null, 2));
      break;
    }
    case 'group-join': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(joinGroup(uuid, flag(args, 'group')), null, 2));
      break;
    }
    case 'group-leave': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(leaveGroup(uuid, flag(args, 'group')), null, 2));
      break;
    }
    case 'group-send': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      console.log(JSON.stringify(sendGroupMessage(uuid, flag(args, 'group'), flag(args, 'message')), null, 2));
      break;
    }
    case 'group-list': {
      const uuid = resolveSelf(flag(args, 'uuid'));
      const data = readData();
      writePresence(uuid);
      console.log(JSON.stringify(groupsForParticipant(data, uuid), null, 2));
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
