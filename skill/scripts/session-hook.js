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

// Read the whole identities.json store (identities + sessions).
function readIdentityStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    return {
      version: 1,
      identities: (parsed && parsed.identities) || {},
      sessions: (parsed && parsed.sessions) || {},
    };
  } catch {
    return { version: 1, identities: {}, sessions: {} };
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

// Remove this session's record on SessionEnd. The participant + its messages
// stay so offline delivery keeps working.
function removeSession(sessionId) {
  try {
    const store = readIdentityStore();
    if (store.sessions[sessionId]) {
      delete store.sessions[sessionId];
      writeIdentityStore(store);
    }
  } catch {
    // best-effort
  }
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

  upsertSession({
    session_id: sessionId,
    cwd: realpath(cwd),
    name: registered.name,
    uuid: registered.uuid,
    ppid: process.ppid,
    updatedAt: Date.now(),
  });

  writePresence(registered.uuid);
}

try {
  main();
} catch {
  // fail-open: never break session start/end
} finally {
  process.exit(0);
}
