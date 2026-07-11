#!/usr/bin/env node

// Claude Code "SessionStart" / "SessionEnd" hook for agent-messenger.
//
// Makes the messaging identity SESSION-SCOPED and native to Claude Code: it
// registers a participant whose uuid IS the Claude Code session UUID (stable
// across --resume and /compact, and what the user sees in `claude --resume`).
// Agents then address each other by native session UUID.
//
// stdin JSON provides: session_id, cwd, transcript_path, hook_event_name, and
// (on SessionStart) source: "startup" | "resume" | "clear" | "compact".
//
// On SessionStart it upserts (idempotently — same uuid == session_id):
//   - a participant in data.json (uuid == session_id, name == <base>-<sid6>)
//   - a session record in identities.json under `sessions[session_id]`:
//       { session_id, cwd (realpath), name, uuid, ppid, updatedAt }
//     ppid is process.ppid — the `claude` worker that also parents the stdio
//     MCP server, so the server can match its own process.ppid to this session.
//
// On SessionEnd it removes that session record (the participant + its messages
// stay, so offline delivery keeps working).
//
// Fully fail-open: never breaks session start/end, exits 0 always, no stdout.
//
// Wire it into .claude/settings.json:
//   { "hooks": {
//       "SessionStart": [ { "hooks": [ { "type": "command",
//         "command": "node /absolute/path/to/skill/scripts/session-hook.js" } ] } ],
//       "SessionEnd":   [ { "hooks": [ { "type": "command",
//         "command": "node /absolute/path/to/skill/scripts/session-hook.js" } ] } ]
//   } }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR || path.join(os.homedir(), '.agent-comm');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const IDENTITY_FILE = path.join(DATA_DIR, 'identities.json');
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');
const LOCK_DIR = path.join(DATA_DIR, '.lock');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// mkdir-based lock, mirroring src/store.ts + agent-comm.js.
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
      // Busy wait without spawning: brief spin.
      const until = Date.now() + 100;
      while (Date.now() < until) {}
    }
  }
  throw new Error('Could not acquire lock');
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
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

// Lock-free read of the store. Only the fields this hook needs are touched, so
// no migration is required; v2/v3/legacy shapes are all tolerated.
function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      version: 3,
      participants: (raw && raw.participants) || {},
      groups: (raw && raw.groups) || {},
      directMessages: (raw && raw.directMessages) || [],
      groupMessages: (raw && raw.groupMessages) || [],
    };
  } catch {
    return { version: 3, participants: {}, groups: {}, directMessages: [], groupMessages: [] };
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

function participantByName(data, type, name) {
  if (!name) return undefined;
  return Object.values(data.participants).find(
    (participant) => participant.type === type && participant.name === name
  );
}

// Register/update a participant with an explicit uuid (== session_id). Mirrors
// src/store.ts registerParticipant, but always creates with the given uuid.
function registerParticipant(type, name, participantUuid) {
  return withLock(() => {
    const data = readData();

    if (
      participantUuid &&
      data.participants[participantUuid] &&
      data.participants[participantUuid].type === type
    ) {
      if (name && data.participants[participantUuid].name !== name) {
        data.participants[participantUuid].name = name;
        writeData(data);
      }
      return { uuid: participantUuid, name: data.participants[participantUuid].name, type };
    }

    const existing = participantByName(data, type, name);
    if (existing && (!participantUuid || existing.uuid === participantUuid)) {
      return { uuid: existing.uuid, name: existing.name, type };
    }

    const id =
      participantUuid && !data.participants[participantUuid]
        ? participantUuid
        : crypto.randomUUID();
    const participantName = name || `${type}-${id.slice(0, 8)}`;
    data.participants[id] = { uuid: id, type, name: participantName, createdAt: Date.now() };
    writeData(data);
    return { uuid: id, name: participantName, type };
  });
}

// Best-effort presence touch (no lock, atomic tmp+rename), mirroring the store.
function writePresence(uuid) {
  try {
    if (!uuid) return;
    ensureDataDir();
    let presence = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
      presence = (parsed && parsed.presence) || {};
    } catch {}
    presence[uuid] = { lastSeen: Date.now() };
    const tmp = `${PRESENCE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, presence }, null, 2));
    fs.renameSync(tmp, PRESENCE_FILE);
  } catch {
    // best-effort
  }
}

// Trail retention for ended session records used in predecessor lookup.
const ENDED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Read the whole identities.json store (identities + sessions + endedSessions).
function readIdentityStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    return {
      version: 1,
      identities: (parsed && parsed.identities) || {},
      sessions: (parsed && parsed.sessions) || {},
      endedSessions: (parsed && parsed.endedSessions) || {},
    };
  } catch {
    return { version: 1, identities: {}, sessions: {}, endedSessions: {} };
  }
}

// Drop ended-session records older than the trail TTL.
function pruneEndedSessions(store) {
  if (!store.endedSessions) {
    store.endedSessions = {};
    return;
  }
  const now = Date.now();
  for (const [sid, rec] of Object.entries(store.endedSessions)) {
    if (!rec || typeof rec.endedAt !== 'number' || now - rec.endedAt > ENDED_SESSION_TTL_MS) {
      delete store.endedSessions[sid];
    }
  }
}

function writeIdentityStore(store) {
  ensureDataDir();
  const tmp = `${IDENTITY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, IDENTITY_FILE);
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Upsert this session's record. Best-effort (no lock; last-writer-wins), same
// pattern as the store's identities/presence writes.
function upsertSession(record) {
  try {
    const store = readIdentityStore();
    store.sessions[record.session_id] = record;
    writeIdentityStore(store);
  } catch {
    // best-effort
  }
}

// On SessionEnd, MOVE this session's record into the `endedSessions` trail (with
// a timestamp) rather than deleting it outright. Empirically a /clear removes the
// old record before the replacement SessionStart runs; the trail lets the new
// session still discover its predecessor. The participant + its messages stay so
// offline delivery keeps working; the trail is pruned after ENDED_SESSION_TTL_MS.
function removeSession(sessionId) {
  try {
    const store = readIdentityStore();
    const record = store.sessions[sessionId];
    if (record) {
      delete store.sessions[sessionId];
      store.endedSessions[sessionId] = { ...record, endedAt: Date.now() };
    }
    pruneEndedSessions(store);
    writeIdentityStore(store);
  } catch {
    // best-effort
  }
}

// Find predecessor session records of THIS pane: same ppid + cwd, different
// session_id. Unions live `sessions` with the `endedSessions` trail so the
// handoff works whether or not SessionEnd for the old id ran first.
function findPredecessors(store, sessionId, ppid, realCwd) {
  const merged = { ...(store.endedSessions || {}), ...(store.sessions || {}) };
  const preds = [];
  const seen = new Set();
  for (const rec of Object.values(merged)) {
    if (!rec || !rec.session_id || rec.session_id === sessionId) continue;
    if (rec.ppid !== ppid || rec.cwd !== realCwd) continue;
    const uuid = rec.uuid || rec.session_id;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    preds.push(rec);
  }
  return preds;
}

// Store-level handoff mirror (see src/store.ts handoffPredecessor). Migrate one
// superseded predecessor participant onto the live one, in place on `data`.
function handoffPredecessor(data, oldUuid, newUuid) {
  if (oldUuid === newUuid) return false;
  const predecessor = data.participants[oldUuid];
  const successor = data.participants[newUuid];
  if (!predecessor || !successor) return false;

  if (successor.aliasOf) delete successor.aliasOf;

  // 1. Alias the predecessor forward.
  predecessor.aliasOf = newUuid;

  // 2. Re-target the predecessor's UNREAD direct mail.
  for (const message of data.directMessages) {
    if (message.to === oldUuid && message.readAt === null) {
      message.to = newUuid;
    }
  }

  // 3. Copy group/channel memberships, merging read state (min → keep unread).
  for (const group of Object.values(data.groups)) {
    const oldMembership = group.members && group.members[oldUuid];
    if (!oldMembership) continue;
    const newMembership = group.members[newUuid];
    if (!newMembership) {
      group.members[newUuid] = {
        joinedAt: oldMembership.joinedAt,
        lastReadSequence: oldMembership.lastReadSequence || 0,
      };
    } else {
      newMembership.joinedAt = Math.min(newMembership.joinedAt, oldMembership.joinedAt);
      newMembership.lastReadSequence = Math.min(
        newMembership.lastReadSequence || 0,
        oldMembership.lastReadSequence || 0
      );
    }
    delete group.members[oldUuid];
  }

  // 4. Flatten aliases that pointed at the predecessor onto the successor.
  for (const participant of Object.values(data.participants)) {
    if (participant.aliasOf === oldUuid) {
      participant.aliasOf = newUuid;
    }
  }

  return true;
}

// Run the handoff for a set of predecessor uuids under the data lock.
function applyIdentityHandoff(oldUuids, newUuid) {
  const unique = [...new Set(oldUuids.filter((u) => u && u !== newUuid))];
  if (unique.length === 0) return;
  withLock(() => {
    const data = readData();
    if (!data.participants[newUuid]) return;
    let changed = false;
    for (const oldUuid of unique) {
      changed = handoffPredecessor(data, oldUuid, newUuid) || changed;
    }
    if (changed) writeData(data);
  });
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return; // fail-open on bad JSON
  }

  const sessionId = input && input.session_id;
  if (!sessionId) {
    return; // nothing we can key on
  }

  const cwd = (input && input.cwd) || process.cwd();
  const event = input && input.hook_event_name;

  if (event === 'SessionEnd') {
    removeSession(sessionId);
    return;
  }

  // Treat everything else as a SessionStart-style upsert (startup / resume /
  // compact / clear all map to the same uuid == session_id, so it's idempotent).
  const base = (process.env.AGENT_MESSENGER_NAME && process.env.AGENT_MESSENGER_NAME.trim()) ||
    path.basename(cwd);
  const name = `${base}-${String(sessionId).slice(0, 6)}`;

  let registered;
  try {
    registered = registerParticipant('agent', name, sessionId);
  } catch {
    return; // could not register — fail-open
  }

  const realCwd = realpath(cwd);

  // Identity handoff: if this pane was /clear'd, an older session with the same
  // ppid + cwd but a different session_id is its predecessor. Hand its address
  // (unread mail, group/channel memberships, aliasing) over to this session, so
  // the pane keeps its inbox and anyone addressing the old id reaches the new one.
  let predecessors = [];
  try {
    const store = readIdentityStore();
    predecessors = findPredecessors(store, sessionId, process.ppid, realCwd);
    if (predecessors.length > 0) {
      applyIdentityHandoff(
        predecessors.map((p) => p.uuid || p.session_id),
        registered.uuid
      );
    }
  } catch {
    // best-effort: a failed handoff must not break session start.
  }

  // Upsert this session's record and CONSUME the predecessors' records (so a
  // later clear does not reprocess them), pruning the trail while we hold it.
  try {
    const store = readIdentityStore();
    for (const p of predecessors) {
      delete store.sessions[p.session_id];
      delete store.endedSessions[p.session_id];
    }
    pruneEndedSessions(store);
    store.sessions[sessionId] = {
      session_id: sessionId,
      cwd: realCwd,
      name: registered.name,
      uuid: registered.uuid,
      ppid: process.ppid,
      updatedAt: Date.now(),
    };
    writeIdentityStore(store);
  } catch {
    // Fall back to the simple upsert if the combined write failed.
    upsertSession({
      session_id: sessionId,
      cwd: realCwd,
      name: registered.name,
      uuid: registered.uuid,
      ppid: process.ppid,
      updatedAt: Date.now(),
    });
  }

  writePresence(registered.uuid);
}

try {
  main();
} catch {
  // fail-open: never break session start/end
} finally {
  process.exit(0);
}
