#!/usr/bin/env node

// Claude Code "Stop" hook for agent-messenger.
//
// Blocks a session from stopping while it still has unread agent messages, so
// the agent reads and handles inbound traffic before ending its turn. Reads the
// shared store directly (lock-free), NEVER clears unread state, and is fully
// fail-open: any error allows the stop.
//
// Wire it into .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//     "command": "node /absolute/path/to/skill/scripts/inbox-hook.js",
//     "timeout": 10 } ] } ] } }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR || path.join(os.homedir(), '.agent-comm');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const IDENTITY_FILE = path.join(DATA_DIR, 'identities.json');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Lock-free read of the store. Tolerates v2/v3/legacy shapes; only the fields
// this hook needs are accessed, so no migration is required.
function readData() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return {
    participants: (raw && raw.participants) || {},
    groups: (raw && raw.groups) || {},
    directMessages: (raw && raw.directMessages) || [],
    groupMessages: (raw && raw.groupMessages) || [],
  };
}

function resolveName(cwd) {
  const envName = process.env.AGENT_MESSENGER_NAME;
  if (envName && envName.trim().length > 0) {
    return envName;
  }
  const base = path.basename(cwd || process.cwd());
  const hash = crypto.createHash('sha256').update(cwd || process.cwd()).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function findParticipantByName(data, name) {
  return Object.values(data.participants).find(
    (participant) => participant.type === 'agent' && participant.name === name
  );
}

// Read the cwd -> identity map the MCP server (or CLI) persisted when it
// resolved its identity. Best-effort: any error yields an empty map.
function readIdentities() {
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    return (parsed && parsed.identities) || {};
  } catch {
    return {};
  }
}

// Recover the identity the server pinned for this session by matching the
// session's live cwd (or any ancestor of it) against the persisted map. This
// keeps the hook's identity aligned with the server's even after the session
// `cd`s into a subdirectory or through a symlink, where re-deriving a name
// from the live cwd would drift and silently allow stopping with unread mail.
function findPersistedIdentity(cwd) {
  const identities = readIdentities();
  if (!identities || Object.keys(identities).length === 0) {
    return null;
  }

  let dir = cwd || process.cwd();
  try {
    dir = fs.realpathSync(dir);
  } catch {
    // fall through with the raw cwd
  }

  // Walk from the live cwd up to the filesystem root, matching the deepest
  // recorded ancestor first.
  while (true) {
    if (identities[dir]) {
      return identities[dir];
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Resolve the participant this session acts as. Prefer the session_id (exact,
// no drift possible — the participant's uuid IS the session_id when the
// SessionStart hook is installed), then the server-persisted cwd identity, then
// a cwd re-derivation (fragile to `cd`, kept for un-hooked setups).
function resolveParticipant(data, input) {
  // 1. Session-scoped identity: uuid == session_id (SessionStart hook).
  const sessionId = input && input.session_id;
  if (sessionId && data.participants[sessionId]) {
    return data.participants[sessionId];
  }

  const cwd = input && input.cwd;

  const envName = process.env.AGENT_MESSENGER_NAME;
  if (envName && envName.trim().length > 0) {
    // An explicit name is cwd-independent and shared with the server.
    return findParticipantByName(data, envName);
  }

  const persisted = findPersistedIdentity(cwd);
  if (persisted && persisted.uuid && data.participants[persisted.uuid]) {
    return data.participants[persisted.uuid];
  }

  // Backward-compatible fallback: derive the name from cwd as before.
  return findParticipantByName(data, resolveName(cwd));
}

// Count unread messages for a participant WITHOUT mutating the store.
function countUnread(data, participantUuid) {
  let unread = data.directMessages.filter(
    (message) => message.to === participantUuid && message.readAt === null
  ).length;

  for (const group of Object.values(data.groups)) {
    const membership = group.members && group.members[participantUuid];
    if (!membership) continue;
    unread += data.groupMessages.filter(
      (message) => message.groupUuid === group.uuid && message.sequence > membership.lastReadSequence
    ).length;
  }

  return unread;
}

function allowStop() {
  process.exit(0);
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return allowStop(); // fail-open on bad JSON
  }

  // Loop safety: if a Stop hook already blocked once, never block again.
  if (input && input.stop_hook_active === true) {
    return allowStop();
  }

  let data;
  try {
    data = readData();
  } catch {
    return allowStop(); // no/unreadable store — nothing to check
  }

  const me = resolveParticipant(data, input);
  if (!me) {
    return allowStop(); // identity never registered — nothing to check
  }

  let unread;
  try {
    unread = countUnread(data, me.uuid);
  } catch {
    return allowStop();
  }

  if (unread > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `You have ${unread} unread agent message(s). Run agent_receive (or the agent-comm receive CLI) to read and handle them before stopping.`,
      })
    );
  }

  process.exit(0);
}

try {
  main();
} catch {
  allowStop();
}
