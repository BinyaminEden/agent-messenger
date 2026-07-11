import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Active wake mechanism (generic adapter contract).
//
// The Stop hook is the PASSIVE wake layer: it keeps a session from ending a turn
// with unread mail. But an IDLE session sitting at its prompt is never woken
// until its next turn. This module is the ACTIVE layer: after a successful send,
// it schedules a wake for each recipient and — if the recipient STILL has unread
// mail after a short debounce — invokes a user-configured command (the "wake
// adapter"). What that command does (type into a pane, POST a webhook, resume a
// headless session, …) is entirely the user's business.
//
// This file contains ZERO knowledge of any specific terminal/dashboard stack.
// The only contract with the outside world is:
//   1. a command string resolved from AGENT_MESSENGER_WAKE_CMD, else the
//      `wakeCommand` field of <data dir>/config.json;
//   2. that command receives ONE JSON object on stdin (see WakePayload).
//
// Everything here is fail-silent: a missing, broken, or slow adapter must never
// affect the send result or surface as a tool error.
// ---------------------------------------------------------------------------

// A session record as written by the SessionStart hook (see store.ts).
interface SessionRecordLite {
  cwd?: string;
  uuid?: string;
}

export interface WakePayload {
  recipient_uuid: string;
  recipient_name: string;
  // The recipient's Claude Code session id — the recipient uuid when it matches
  // a live session record, else null (e.g. a plain registered agent).
  session_id: string | null;
  // The recipient session's cwd (realpath), else null.
  session_cwd: string | null;
  unread_count: number;
  // Distinct display names of the participants who sent the unread messages.
  from_names: string[];
}

const DEFAULT_WAKE_DELAY_MS = 4000;
const ADAPTER_TIMEOUT_MS = 5000;

// All paths / config are read at CALL time (never captured at module load) so a
// process that changes AGENT_MESSENGER_DATA_DIR mid-run — notably the test
// harness — always resolves against the current environment.
function dataDir(): string {
  return process.env.AGENT_MESSENGER_DATA_DIR ?? path.join(os.homedir(), ".agent-comm");
}

function dataFile(): string {
  return path.join(dataDir(), "data.json");
}

function identityFile(): string {
  return path.join(dataDir(), "identities.json");
}

function configFile(): string {
  return path.join(dataDir(), "config.json");
}

export function wakeDelayMs(): number {
  const raw = process.env.AGENT_MESSENGER_WAKE_DELAY_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_WAKE_DELAY_MS;
}

// In-process dedupe: while a recipient's wake is pending, further sends to the
// same recipient within the debounce window are collapsed into the one pending
// wake (a burst fires at most one wake per recipient).
const pending = new Set<string>();

// Schedule a debounced wake for each recipient. Fire-and-forget: returns
// immediately, never throws, and the timers are unref'd so they never keep the
// (long-lived MCP server) process alive.
export function scheduleWake(recipientUuids: Iterable<string>): void {
  const delay = wakeDelayMs();
  for (const uuid of recipientUuids) {
    if (!uuid || pending.has(uuid)) {
      continue;
    }
    pending.add(uuid);
    const timer = setTimeout(() => {
      pending.delete(uuid);
      void fireWake(uuid).catch(() => {});
    }, delay);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }
}

// Re-read the store and, if this recipient STILL has unread mail, invoke the
// wake adapter. Called after the debounce window elapses.
async function fireWake(uuid: string): Promise<void> {
  const command = await resolveWakeCommand();
  if (!command) {
    return; // no adapter configured — Stop hook remains the passive fallback.
  }

  const payload = await gatherRecipientInfo(uuid);
  if (!payload || payload.unread_count <= 0) {
    return; // consumed within the window (Stop hook or an active turn) — stay silent.
  }

  spawnAdapter(command, payload);
}

// Resolve the wake command: env AGENT_MESSENGER_WAKE_CMD wins, then the
// `wakeCommand` field of <data dir>/config.json. Null when neither is set.
async function resolveWakeCommand(): Promise<string | null> {
  const fromEnv = process.env.AGENT_MESSENGER_WAKE_CMD;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }

  try {
    const content = await fs.readFile(configFile(), "utf-8");
    const parsed = JSON.parse(content) as { wakeCommand?: unknown } | null;
    const command = parsed?.wakeCommand;
    if (typeof command === "string" && command.trim().length > 0) {
      return command;
    }
  } catch {
    // No config file / unreadable / malformed — treated as "no adapter".
  }

  return null;
}

interface RawStoreLite {
  participants?: Record<string, { uuid: string; name: string }>;
  groups?: Record<string, { uuid: string; members?: Record<string, { lastReadSequence?: number }> }>;
  directMessages?: Array<{ to: string; from: string; readAt: number | null }>;
  groupMessages?: Array<{ groupUuid: string; from: string; sequence: number }>;
}

// Lock-free read of the store's unread state for one recipient, plus its session
// info. Mirrors the hooks: only the fields needed here are touched, no migration.
async function gatherRecipientInfo(uuid: string): Promise<WakePayload | null> {
  let data: RawStoreLite;
  try {
    data = JSON.parse(await fs.readFile(dataFile(), "utf-8")) as RawStoreLite;
  } catch {
    return null;
  }

  const participants = data.participants ?? {};
  const groups = data.groups ?? {};
  const directMessages = data.directMessages ?? [];
  const groupMessages = data.groupMessages ?? [];

  const participant = participants[uuid];
  const nameOf = (senderUuid: string): string => participants[senderUuid]?.name ?? senderUuid;

  const fromNames: string[] = [];
  const seen = new Set<string>();
  let unread = 0;

  for (const message of directMessages) {
    if (message.to === uuid && message.readAt === null) {
      unread += 1;
      if (!seen.has(message.from)) {
        seen.add(message.from);
        fromNames.push(nameOf(message.from));
      }
    }
  }

  for (const group of Object.values(groups)) {
    const membership = group.members?.[uuid];
    if (!membership) {
      continue;
    }
    const lastRead = membership.lastReadSequence ?? 0;
    for (const message of groupMessages) {
      if (message.groupUuid === group.uuid && message.sequence > lastRead) {
        unread += 1;
        if (!seen.has(message.from)) {
          seen.add(message.from);
          fromNames.push(nameOf(message.from));
        }
      }
    }
  }

  const session = await readSessionRecord(uuid);

  return {
    recipient_uuid: uuid,
    recipient_name: participant?.name ?? uuid,
    session_id: session ? uuid : null,
    session_cwd: session?.cwd ?? null,
    unread_count: unread,
    from_names: fromNames,
  };
}

async function readSessionRecord(uuid: string): Promise<SessionRecordLite | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(identityFile(), "utf-8")) as {
      sessions?: Record<string, SessionRecordLite>;
    } | null;
    const record = parsed?.sessions?.[uuid];
    return record && record.uuid === uuid ? record : null;
  } catch {
    return null;
  }
}

// Spawn the adapter via the shell, pass the payload as one JSON object on stdin,
// detach + unref so it never blocks process exit, and kill it after a timeout.
// Fully fail-silent.
function spawnAdapter(command: string, payload: WakePayload): void {
  try {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });

    child.on("error", () => {});

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, ADAPTER_TIMEOUT_MS);
    if (typeof killTimer.unref === "function") {
      killTimer.unref();
    }
    child.on("exit", () => clearTimeout(killTimer));

    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    }

    child.unref();
  } catch {
    // A broken adapter must never affect the caller.
  }
}
