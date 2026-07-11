import { promises as fs, watch as fsWatch, type FSWatcher } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { scheduleWake } from "./notify.js";

export type ParticipantType = "agent" | "human";

export interface Participant {
  uuid: string;
  type: ParticipantType;
  name: string;
  createdAt: number;
  // When set, this participant has been superseded (e.g. its pane was /clear'd,
  // minting a new session_id) and its address forwards to the live participant
  // `aliasOf`. Aliased participants are hidden from active-agent listings; refs
  // that resolve to them follow the chain to the live participant.
  aliasOf?: string;
}

export interface Presence {
  lastSeen: number;
}

export interface GroupMembership {
  joinedAt: number;
  lastReadSequence: number;
}

export interface Group {
  uuid: string;
  name: string;
  createdBy: string;
  createdAt: number;
  lastSequence: number;
  members: Record<string, GroupMembership>;
}

export interface DirectMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  readAt: number | null;
  replyTo: string | null;
}

export interface GroupMessage {
  id: string;
  groupUuid: string;
  from: string;
  content: string;
  timestamp: number;
  sequence: number;
}

export interface StoreData {
  version: 3;
  participants: Record<string, Participant>;
  groups: Record<string, Group>;
  directMessages: DirectMessage[];
  groupMessages: GroupMessage[];
}

export interface PresenceStore {
  version: 1;
  presence: Record<string, Presence>;
}

// A durable map from the cwd an identity was resolved in to the participant it
// resolved to. Lets out-of-process helpers (e.g. the Stop hook) recover the
// SAME identity the server pinned at launch, instead of re-deriving one from
// their own live cwd (which drifts on `cd`, symlinks, etc.).
export interface IdentityRecord {
  uuid: string;
  name: string;
  cwd: string;
  updatedAt: number;
}

// A session-scoped identity record, keyed by the Claude Code session UUID. The
// SessionStart hook writes one of these per live session; the participant's uuid
// IS the session_id, so agents can address each other by native session UUID.
// `ppid` is the hook process's parent pid (the `claude` worker), which the MCP
// server matches against its own process.ppid to discover WHICH session it is.
export interface SessionRecord {
  session_id: string;
  cwd: string;
  name: string;
  uuid: string;
  ppid: number;
  updatedAt: number;
  stale?: boolean;
}

// A session record moved out of the live `sessions` map when SessionEnd fires,
// kept as a short trail so a later SessionStart (e.g. the /clear replacement)
// can still discover its predecessor even though the live record is gone.
// Pruned after ENDED_SESSION_TTL_MS.
export interface EndedSessionRecord extends SessionRecord {
  endedAt: number;
}

export interface IdentityStore {
  version: 1;
  identities: Record<string, IdentityRecord>;
  // session_id -> session identity (written by the SessionStart hook).
  sessions?: Record<string, SessionRecord>;
  // session_id -> ended session identity (SessionEnd trail; predecessor lookup).
  endedSessions?: Record<string, EndedSessionRecord>;
}

interface LegacyAgent {
  name: string;
  lastSeen: number;
}

interface LegacyMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

interface LegacyStoreData {
  agents?: Record<string, LegacyAgent>;
  messages?: LegacyMessage[];
}

export interface PublicParticipant {
  uuid: string;
  type: ParticipantType;
  name: string;
  createdAt: number;
}

export interface ActiveAgent extends PublicParticipant {
  lastSeen: number;
}

export interface GroupMemberSummary extends PublicParticipant {
  joinedAt: number;
  lastReadSequence: number;
}

export interface GroupSummary {
  uuid: string;
  name: string;
  createdBy: string;
  createdAt: number;
  unreadCount: number;
  memberCount: number;
  members: GroupMemberSummary[];
  lastMessage: GroupMessageSummary | null;
}

export interface DirectMessageSummary {
  id: string;
  from: string;
  fromName: string;
  fromType: ParticipantType;
  to: string;
  content: string;
  timestamp: number;
  replyTo: string | null;
}

export interface GroupMessageSummary {
  id: string;
  groupUuid: string;
  groupName: string;
  from: string;
  fromName: string;
  fromType: ParticipantType;
  content: string;
  timestamp: number;
  sequence: number;
}

export interface ReceiveResult {
  directMessages: DirectMessageSummary[];
  groupMessages: GroupMessageSummary[];
  groups: GroupSummary[];
  activeAgents: ActiveAgent[];
}

export interface WaitResult extends ReceiveResult {
  timedOut: boolean;
}

export interface RegisterResult {
  uuid: string;
  name: string;
  type: ParticipantType;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

export interface DirectSendResult extends SendResult {
  messageId?: string;
}

export interface GroupActionResult extends SendResult {
  group?: GroupSummary;
}

export interface GroupThreadResult {
  group: GroupSummary;
  messages: GroupMessageSummary[];
}

export interface AskReplyResult {
  message: DirectMessageSummary | null;
  timedOut: boolean;
}

export interface EventSnapshot {
  directUnreadCount: number;
  groupsFingerprint: string;
  messagesFingerprint: string;
  activeAgentsFingerprint: string;
}

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR ?? path.join(os.homedir(), ".agent-comm");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PRESENCE_FILE = path.join(DATA_DIR, "presence.json");
const IDENTITY_FILE = path.join(DATA_DIR, "identities.json");
const LOCK_PATH = path.join(DATA_DIR, ".lock");

const ACTIVE_PRESENCE_TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const WATCH_DEBOUNCE_MS = 150;
const DEFAULT_FALLBACK_POLL_MS = 15_000;

function createEmptyStore(): StoreData {
  return {
    version: 3,
    participants: {},
    groups: {},
    directMessages: [],
    groupMessages: [],
  };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function acquireLock(maxRetries: number = 30): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      await fs.mkdir(LOCK_PATH);
      return;
    } catch {
      try {
        const stat = await fs.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore and retry.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error("Could not acquire lock");
}

async function releaseLock(): Promise<void> {
  await fs.rm(LOCK_PATH, { recursive: true, force: true });
}

function asPublicParticipant(participant: Participant): PublicParticipant {
  return {
    uuid: participant.uuid,
    type: participant.type,
    name: participant.name,
    createdAt: participant.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Presence (presence.json) — best-effort, NEVER guarded by the lock.
// ---------------------------------------------------------------------------

async function readPresence(): Promise<Record<string, Presence>> {
  try {
    const content = await fs.readFile(PRESENCE_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<PresenceStore> | undefined;
    return parsed?.presence ?? {};
  } catch {
    return {};
  }
}

async function writePresence(uuids: string | string[]): Promise<void> {
  try {
    const list = Array.isArray(uuids) ? uuids : [uuids];
    const filtered = list.filter((uuid) => Boolean(uuid));
    if (filtered.length === 0) {
      return;
    }

    await ensureDataDir();
    const current = await readPresence();
    const now = Date.now();
    for (const uuid of filtered) {
      current[uuid] = { lastSeen: now };
    }

    const store: PresenceStore = { version: 1, presence: current };
    const tempFile = `${PRESENCE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
    await fs.rename(tempFile, PRESENCE_FILE);
  } catch {
    // best-effort; races and IO errors are tolerated (last-writer-wins).
  }
}

// Move a legacy/v2 in-file presence map into presence.json, but only if
// presence.json does not already exist (never clobber a newer presence file).
async function migratePresenceIfAbsent(presence: Record<string, Presence>): Promise<void> {
  try {
    if (!presence || Object.keys(presence).length === 0) {
      return;
    }

    await ensureDataDir();
    try {
      await fs.access(PRESENCE_FILE);
      return; // Already exists — do not overwrite.
    } catch {
      // Not present yet — proceed to write.
    }

    const store: PresenceStore = { version: 1, presence };
    const tempFile = `${PRESENCE_FILE}.migrate.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
    await fs.rename(tempFile, PRESENCE_FILE);
  } catch {
    // best-effort.
  }
}

function withSelfPresence(
  presence: Record<string, Presence>,
  uuid: string
): Record<string, Presence> {
  return { ...presence, [uuid]: { lastSeen: Date.now() } };
}

// ---------------------------------------------------------------------------
// Persisted identity (identities.json) — best-effort, NEVER guarded by the
// lock. Records which participant a given cwd resolved to so that other
// processes can recover the exact same identity without re-deriving.
// ---------------------------------------------------------------------------

async function canonicalizeCwd(cwd: string): Promise<string> {
  try {
    return await fs.realpath(cwd);
  } catch {
    return cwd;
  }
}

async function readIdentityStore(): Promise<Record<string, IdentityRecord>> {
  try {
    const content = await fs.readFile(IDENTITY_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<IdentityStore> | undefined;
    return parsed?.identities ?? {};
  } catch {
    return {};
  }
}

async function readSessionRecords(): Promise<Record<string, SessionRecord>> {
  try {
    const content = await fs.readFile(IDENTITY_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<IdentityStore> | undefined;
    return parsed?.sessions ?? {};
  } catch {
    return {};
  }
}

async function readEndedSessionRecords(): Promise<Record<string, EndedSessionRecord>> {
  try {
    const content = await fs.readFile(IDENTITY_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<IdentityStore> | undefined;
    return parsed?.endedSessions ?? {};
  } catch {
    return {};
  }
}

// Follow a participant's aliasOf chain to the terminal (live, non-aliased)
// participant uuid. Cycle-protected: bounded hops + a visited set, so a corrupt
// self- or mutual-alias never loops. Falls back to the last resolvable uuid.
function resolveAliasedUuid(participants: Record<string, Participant>, uuid: string): string {
  let current = uuid;
  const seen = new Set<string>();
  for (let hop = 0; hop < 32; hop += 1) {
    const participant = participants[current];
    if (!participant || !participant.aliasOf || participant.aliasOf === current) {
      return current;
    }
    if (seen.has(current) || !participants[participant.aliasOf]) {
      return current;
    }
    seen.add(current);
    current = participant.aliasOf;
  }
  return current;
}

// Discover WHICH session this MCP server process belongs to, using the records
// the SessionStart hook persisted. Priority:
//   (1) session whose ppid matches this process's parent pid — hook and stdio
//       MCP server are both direct children of the same `claude` worker, so
//       their ppids match. Freshest updatedAt wins on ties.
//   (2) freshest session whose recorded cwd matches this process's realpath cwd.
// Returns null when no session matches (caller falls back to cwd-derivation).
async function findServerSession(cwd: string): Promise<SessionRecord | null> {
  const sessions = Object.values(await readSessionRecords()).filter(
    (session) => session && !session.stale && session.uuid
  );
  if (sessions.length === 0) {
    return null;
  }

  const ppid = process.ppid;
  const byPpid = sessions
    .filter((session) => session.ppid === ppid)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (byPpid.length > 0) {
    return byPpid[0];
  }

  const realCwd = await canonicalizeCwd(cwd);
  const byCwd = sessions
    .filter((session) => session.cwd === realCwd)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (byCwd.length > 0) {
    return byCwd[0];
  }

  return null;
}

async function persistIdentity(
  cwd: string,
  identity: { uuid: string; name: string }
): Promise<void> {
  try {
    await ensureDataDir();
    const key = await canonicalizeCwd(cwd);
    const identities = await readIdentityStore();
    identities[key] = {
      uuid: identity.uuid,
      name: identity.name,
      cwd: key,
      updatedAt: Date.now(),
    };

    // Preserve the session + ended-session records the hooks wrote — this
    // best-effort write must never clobber them.
    const sessions = await readSessionRecords();
    const endedSessions = await readEndedSessionRecords();
    const store: IdentityStore = { version: 1, identities, sessions, endedSessions };
    const tempFile = `${IDENTITY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
    await fs.rename(tempFile, IDENTITY_FILE);
  } catch {
    // best-effort; identity recovery falls back to cwd-derivation.
  }
}

// ---------------------------------------------------------------------------
// Migration + normalization to v3.
// ---------------------------------------------------------------------------

interface RawStore {
  version?: number;
  participants?: Record<string, Participant>;
  presence?: Record<string, Presence>;
  groups?: Record<string, Group>;
  directMessages?: Array<Partial<DirectMessage> & { id: string; from: string; to: string; content: string; timestamp: number }>;
  groupMessages?: GroupMessage[];
}

async function normalizeStoreData(raw: unknown, _dataDir: string = DATA_DIR): Promise<StoreData> {
  if (raw && typeof raw === "object") {
    const obj = raw as RawStore;

    if (obj.version === 3 && obj.participants && obj.groups) {
      return cleanupData(obj);
    }

    if (obj.version === 2 && obj.participants && obj.groups) {
      await migratePresenceIfAbsent(obj.presence ?? {});
      return cleanupData(obj);
    }
  }

  const { data, presence } = migrateLegacyStore(raw as LegacyStoreData | undefined);
  await migratePresenceIfAbsent(presence);
  return cleanupData(data);
}

function migrateLegacyStore(legacy?: LegacyStoreData): {
  data: StoreData;
  presence: Record<string, Presence>;
} {
  const data = createEmptyStore();
  const presence: Record<string, Presence> = {};
  const now = Date.now();
  const legacyAgents = legacy?.agents ?? {};
  const legacyMessages = legacy?.messages ?? [];

  const participantIds = new Set<string>([
    ...Object.keys(legacyAgents),
    ...legacyMessages.flatMap((message) => [message.from, message.to]),
  ]);

  for (const uuid of participantIds) {
    const legacyAgent = legacyAgents[uuid];
    const createdAt = legacyAgent?.lastSeen ?? now;
    data.participants[uuid] = {
      uuid,
      type: "agent",
      name: legacyAgent?.name ?? `agent-${uuid.slice(0, 8)}`,
      createdAt,
    };

    if (legacyAgent) {
      presence[uuid] = { lastSeen: legacyAgent.lastSeen };
    }
  }

  data.directMessages = legacyMessages.map((message) => ({
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

async function readData(): Promise<StoreData> {
  try {
    const content = await fs.readFile(DATA_FILE, "utf-8");
    return await normalizeStoreData(JSON.parse(content) as unknown);
  } catch {
    return createEmptyStore();
  }
}

async function writeData(data: StoreData): Promise<void> {
  const payload: StoreData = {
    version: 3,
    participants: data.participants,
    groups: data.groups,
    directMessages: data.directMessages,
    groupMessages: data.groupMessages,
  };
  const tempFile = DATA_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
  await fs.rename(tempFile, DATA_FILE);
}

function cleanupData(data: RawStore): StoreData {
  const cleanedGroups: Record<string, Group> = {};
  for (const [groupUuid, group] of Object.entries(data.groups ?? {})) {
    const members: Record<string, GroupMembership> = {};
    for (const [memberUuid, membership] of Object.entries(group.members ?? {})) {
      if ((data.participants ?? {})[memberUuid]) {
        members[memberUuid] = {
          joinedAt: membership.joinedAt,
          lastReadSequence: membership.lastReadSequence ?? 0,
        };
      }
    }

    const groupMessages = (data.groupMessages ?? []).filter(
      (message) => message.groupUuid === groupUuid
    );
    const lastSequence = groupMessages.reduce(
      (maxSequence, message) => Math.max(maxSequence, message.sequence),
      group.lastSequence ?? 0
    );

    cleanedGroups[groupUuid] = {
      ...group,
      members,
      lastSequence,
    };
  }

  const validParticipants = new Set(Object.keys(data.participants ?? {}));
  const validGroups = new Set(Object.keys(cleanedGroups));

  const directMessages: DirectMessage[] = (data.directMessages ?? [])
    .filter(
      (message) => validParticipants.has(message.from) && validParticipants.has(message.to)
    )
    .map((message) => ({
      id: message.id,
      from: message.from,
      to: message.to,
      content: message.content,
      timestamp: message.timestamp,
      readAt: message.readAt ?? null,
      replyTo: message.replyTo ?? null,
    }));

  const groupMessages = (data.groupMessages ?? []).filter(
    (message) => validParticipants.has(message.from) && validGroups.has(message.groupUuid)
  );

  return {
    version: 3,
    participants: data.participants ?? {},
    groups: cleanedGroups,
    directMessages,
    groupMessages,
  };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDataDir();

  try {
    await acquireLock();
    return await fn();
  } finally {
    await releaseLock();
  }
}

function findParticipantByName(
  data: StoreData,
  type: ParticipantType,
  name?: string
): Participant | undefined {
  if (!name) {
    return undefined;
  }

  return Object.values(data.participants).find(
    (participant) => participant.type === type && participant.name === name
  );
}

function findGroupByName(data: StoreData, name: string): Group | undefined {
  const normalized = name.trim().toLowerCase();
  const matches = Object.values(data.groups).filter(
    (group) => group.name.trim().toLowerCase() === normalized
  );

  if (matches.length === 0) {
    return undefined;
  }

  // Channels treat the name as a key: the deterministic oldest group wins.
  return matches.sort(
    (left, right) => left.createdAt - right.createdAt || left.uuid.localeCompare(right.uuid)
  )[0];
}

function activeAgentsFromData(
  data: StoreData,
  presence: Record<string, Presence>
): ActiveAgent[] {
  const now = Date.now();
  return Object.values(data.participants)
    .filter((participant) => {
      if (participant.type !== "agent") {
        return false;
      }
      // Aliased (superseded) participants are hidden — their live successor is
      // the one that should appear as active.
      if (participant.aliasOf) {
        return false;
      }
      const entry = presence[participant.uuid];
      return Boolean(entry) && now - entry.lastSeen < ACTIVE_PRESENCE_TTL_MS;
    })
    .map((participant) => ({
      ...asPublicParticipant(participant),
      lastSeen: presence[participant.uuid].lastSeen,
    }))
    .sort((left, right) => right.lastSeen - left.lastSeen || left.name.localeCompare(right.name));
}

function groupMessageSummaryFromData(
  data: StoreData,
  message: GroupMessage
): GroupMessageSummary {
  const sender = data.participants[message.from];
  const group = data.groups[message.groupUuid];

  return {
    id: message.id,
    groupUuid: message.groupUuid,
    groupName: group?.name ?? message.groupUuid,
    from: message.from,
    fromName: sender?.name ?? message.from,
    fromType: sender?.type ?? "agent",
    content: message.content,
    timestamp: message.timestamp,
    sequence: message.sequence,
  };
}

function directMessageSummaryFromData(
  data: StoreData,
  message: DirectMessage
): DirectMessageSummary {
  const sender = data.participants[message.from];

  return {
    id: message.id,
    from: message.from,
    fromName: sender?.name ?? message.from,
    fromType: sender?.type ?? "agent",
    to: message.to,
    content: message.content,
    timestamp: message.timestamp,
    replyTo: message.replyTo ?? null,
  };
}

function unreadGroupMessagesForParticipant(
  data: StoreData,
  participantUuid: string
): GroupMessageSummary[] {
  const messages: GroupMessageSummary[] = [];

  for (const group of Object.values(data.groups)) {
    const membership = group.members[participantUuid];
    if (!membership) {
      continue;
    }

    for (const message of data.groupMessages) {
      if (
        message.groupUuid === group.uuid &&
        message.sequence > membership.lastReadSequence
      ) {
        messages.push(groupMessageSummaryFromData(data, message));
      }
    }
  }

  return messages.sort((left, right) => left.timestamp - right.timestamp);
}

function groupsForParticipant(data: StoreData, participantUuid: string): GroupSummary[] {
  return Object.values(data.groups)
    .filter((group) => Boolean(group.members[participantUuid]))
    .map((group) => {
      const unreadCount = data.groupMessages.filter((message) => {
        const membership = group.members[participantUuid];
        return (
          message.groupUuid === group.uuid &&
          membership &&
          message.sequence > membership.lastReadSequence
        );
      }).length;

      const lastMessage = data.groupMessages
        .filter((message) => message.groupUuid === group.uuid)
        .sort((left, right) => right.sequence - left.sequence)[0] ?? null;

      const members = Object.entries(group.members)
        .map(([memberUuid, membership]) => {
          const participant = data.participants[memberUuid];
          if (!participant || participant.aliasOf) {
            return null;
          }

          return {
            ...asPublicParticipant(participant),
            joinedAt: membership.joinedAt,
            lastReadSequence: membership.lastReadSequence,
          } satisfies GroupMemberSummary;
        })
        .filter((member): member is GroupMemberSummary => member !== null)
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        uuid: group.uuid,
        name: group.name,
        createdBy: group.createdBy,
        createdAt: group.createdAt,
        unreadCount,
        memberCount: members.length,
        members,
        lastMessage: lastMessage ? groupMessageSummaryFromData(data, lastMessage) : null,
      } satisfies GroupSummary;
    })
    .sort((left, right) => {
      const leftTimestamp = left.lastMessage?.timestamp ?? left.createdAt;
      const rightTimestamp = right.lastMessage?.timestamp ?? right.createdAt;
      return rightTimestamp - leftTimestamp || left.name.localeCompare(right.name);
    });
}

function ensureParticipantExists(data: StoreData, uuid: string): Participant | null {
  return data.participants[uuid] ?? null;
}

function ensureGroupMember(data: StoreData, groupUuid: string, participantUuid: string): Group | null {
  const group = data.groups[groupUuid];
  if (!group || !group.members[participantUuid]) {
    return null;
  }

  return group;
}

// ---------------------------------------------------------------------------
// Registration + identity.
// ---------------------------------------------------------------------------

export async function registerAgent(name?: string): Promise<RegisterResult> {
  return registerParticipant("agent", name);
}

export async function registerHuman(
  name?: string,
  participantUuid?: string
): Promise<RegisterResult> {
  return registerParticipant("human", name, participantUuid);
}

export async function registerParticipant(
  type: ParticipantType,
  name?: string,
  participantUuid?: string
): Promise<RegisterResult> {
  const result = await withLock(async () => {
    const data = await readData();

    if (participantUuid && data.participants[participantUuid]?.type === type) {
      if (name) {
        data.participants[participantUuid].name = name;
        await writeData(data);
      }
      return {
        uuid: participantUuid,
        name: data.participants[participantUuid].name,
        type,
      };
    }

    const existing = findParticipantByName(data, type, name);
    if (existing && (!participantUuid || existing.uuid === participantUuid)) {
      // No durable mutation — leave data.json untouched (presence touched below).
      return { uuid: existing.uuid, name: existing.name, type };
    }

    // Honor an explicit uuid (e.g. a session_id) when it is free, so
    // session-scoped identities are created with uuid == session_id.
    const uuid =
      participantUuid && !data.participants[participantUuid] ? participantUuid : uuidv4();
    const participantName = name || `${type}-${uuid.slice(0, 8)}`;
    data.participants[uuid] = {
      uuid,
      type,
      name: participantName,
      createdAt: Date.now(),
    };
    await writeData(data);

    return { uuid, name: participantName, type };
  });

  await writePresence(result.uuid);
  return result;
}

export async function resolveIdentity(cwd: string = process.cwd()): Promise<RegisterResult> {
  // Prefer the session-scoped identity the SessionStart hook registered: the
  // participant's uuid IS the Claude Code session UUID (stable across --resume
  // and /compact, and what the user sees in `claude --resume`).
  const sessionMatch = await findServerSession(cwd);
  if (sessionMatch) {
    const result = await registerParticipant("agent", sessionMatch.name, sessionMatch.uuid);
    await persistIdentity(cwd, result);
    return result;
  }

  // Fallback (no SessionStart hook installed): env name, else a stable
  // per-cwd name so behavior is unchanged for un-hooked setups.
  const envName = process.env.AGENT_MESSENGER_NAME;
  let name: string;

  if (envName && envName.trim().length > 0) {
    name = envName;
  } else {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 6);
    name = `${path.basename(cwd)}-${hash}`;
  }

  const result = await registerParticipant("agent", name);
  // Record cwd -> identity so out-of-process helpers (Stop hook, CLI) can
  // recover this exact identity instead of re-deriving from their own cwd.
  await persistIdentity(cwd, result);
  return result;
}

// ---------------------------------------------------------------------------
// Identity handoff (/clear survival).
//
// When a pane is /clear'd, Claude Code mints a NEW session_id for it. The
// SessionStart hook detects the predecessor(s) (same ppid + cwd, different
// session_id) and hands the pane's address over to the new participant. This is
// the store-level mirror of that logic — the standalone session-hook.js runs the
// same steps out-of-process, and the MCP server (refreshIdentity) uses it as a
// self-healing safety net when it notices its cached session was superseded.
// ---------------------------------------------------------------------------

// Migrate one superseded predecessor onto the live participant, in place.
// Returns true when anything changed. Idempotent: re-running is a no-op.
function handoffPredecessor(data: StoreData, oldUuid: string, newUuid: string): boolean {
  if (oldUuid === newUuid) {
    return false;
  }
  const predecessor = data.participants[oldUuid];
  const successor = data.participants[newUuid];
  if (!predecessor || !successor) {
    return false;
  }

  // Successor must be terminal.
  if (successor.aliasOf) {
    delete successor.aliasOf;
  }

  // 1. Alias the predecessor forward.
  predecessor.aliasOf = newUuid;

  // 2. Re-target the predecessor's UNREAD direct mail to the successor.
  for (const message of data.directMessages) {
    if (message.to === oldUuid && message.readAt === null) {
      message.to = newUuid;
    }
  }

  // 3. Copy group/channel memberships, merging read state so no unread is lost.
  for (const group of Object.values(data.groups)) {
    const oldMembership = group.members[oldUuid];
    if (!oldMembership) {
      continue;
    }
    const newMembership = group.members[newUuid];
    if (!newMembership) {
      group.members[newUuid] = {
        joinedAt: oldMembership.joinedAt,
        lastReadSequence: oldMembership.lastReadSequence,
      };
    } else {
      newMembership.joinedAt = Math.min(newMembership.joinedAt, oldMembership.joinedAt);
      newMembership.lastReadSequence = Math.min(
        newMembership.lastReadSequence,
        oldMembership.lastReadSequence
      );
    }
    delete group.members[oldUuid];
  }

  // 4. Flatten: any alias that pointed at the predecessor now points straight at
  //    the successor, keeping chains at depth 1 (eab→4f8→c29 collapses).
  for (const participant of Object.values(data.participants)) {
    if (participant.aliasOf === oldUuid) {
      participant.aliasOf = newUuid;
    }
  }

  return true;
}

// Hand a pane's address from one or more superseded predecessors to the live
// participant. Locked (mutates data.json). Safe to call repeatedly.
export async function applyIdentityHandoff(
  predecessorUuids: string[],
  newUuid: string
): Promise<void> {
  const unique = [...new Set(predecessorUuids.filter((uuid) => uuid && uuid !== newUuid))];
  if (unique.length === 0) {
    return;
  }

  await withLock(async () => {
    const data = await readData();
    if (!data.participants[newUuid]) {
      return;
    }
    let changed = false;
    for (const oldUuid of unique) {
      changed = handoffPredecessor(data, oldUuid, newUuid) || changed;
    }
    if (changed) {
      await writeData(data);
    }
  });
}

// Cheap re-resolution for the long-lived MCP server's cached identity. Called on
// each tool use: if the pane got a NEW session_id (freshest ppid/cwd-matched
// session record differs from the cache — e.g. after /clear) adopt it, running a
// self-healing handoff in case the hook's did not. Otherwise, if the cached
// participant has since been aliased, follow the alias to the live participant.
// Both are small lock-free reads on the common (unchanged) path.
export async function refreshIdentity(
  cachedUuid: string,
  cwd: string = process.cwd()
): Promise<string> {
  const session = await findServerSession(cwd);
  if (session && session.uuid !== cachedUuid) {
    const result = await registerParticipant("agent", session.name, session.uuid);
    await applyIdentityHandoff([cachedUuid], result.uuid);
    await persistIdentity(cwd, result);
    return result.uuid;
  }

  const data = await readData();
  return resolveAliasedUuid(data.participants, cachedUuid);
}

// Minimum length for a UUID-prefix address. Shorter prefixes are rejected to
// avoid accidental collisions; this matches the short id shown in the statusline.
const MIN_UUID_PREFIX = 6;

export async function resolveParticipantRef(
  ref: string
): Promise<{ uuid: string } | { error: string }> {
  const data = await readData();

  // Any resolved uuid is forwarded through its aliasOf chain so addressing a
  // pane by an OLD uuid/name/prefix (pre-/clear) reaches its live participant.
  const live = (uuid: string): { uuid: string } => ({
    uuid: resolveAliasedUuid(data.participants, uuid),
  });

  // Exact UUID always wins.
  if (data.participants[ref]) {
    return live(ref);
  }

  // Exact name next (names remain the primary human-facing address).
  const nameMatches = Object.values(data.participants).filter(
    (participant) => participant.name === ref
  );
  if (nameMatches.length === 1) {
    return live(nameMatches[0].uuid);
  }
  if (nameMatches.length > 1) {
    const liveUuids = new Set(
      nameMatches.map((match) => resolveAliasedUuid(data.participants, match.uuid))
    );
    if (liveUuids.size === 1) {
      return { uuid: [...liveUuids][0] };
    }
    return {
      error: `Ambiguous name '${ref}' → uuids: ${nameMatches
        .map((match) => match.uuid)
        .join(", ")}`,
    };
  }

  // Finally, a unique UUID prefix (min 6 chars) — the short id from the statusline.
  const prefixMatches = Object.values(data.participants).filter((participant) =>
    participant.uuid.startsWith(ref)
  );
  if (prefixMatches.length > 0 && ref.length < MIN_UUID_PREFIX) {
    return {
      error: `UUID prefix '${ref}' too short (min ${MIN_UUID_PREFIX} chars)`,
    };
  }
  if (ref.length >= MIN_UUID_PREFIX && prefixMatches.length === 1) {
    return live(prefixMatches[0].uuid);
  }
  if (ref.length >= MIN_UUID_PREFIX && prefixMatches.length > 1) {
    const liveUuids = new Set(
      prefixMatches.map((match) => resolveAliasedUuid(data.participants, match.uuid))
    );
    if (liveUuids.size === 1) {
      return { uuid: [...liveUuids][0] };
    }
    return {
      error: `Ambiguous UUID prefix '${ref}' → uuids: ${prefixMatches
        .map((match) => match.uuid)
        .join(", ")}`,
    };
  }

  return { error: `No participant named '${ref}'` };
}

// ---------------------------------------------------------------------------
// Direct messages + request/reply.
// ---------------------------------------------------------------------------

export async function sendDirectMessage(
  fromUuid: string,
  toUuid: string,
  content: string,
  replyTo: string | null = null
): Promise<DirectSendResult> {
  const outcome = await withLock(async (): Promise<DirectSendResult> => {
    const data = await readData();

    if (!ensureParticipantExists(data, fromUuid)) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }

    if (!ensureParticipantExists(data, toUuid)) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }

    const id = uuidv4();
    data.directMessages.push({
      id,
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
      readAt: null,
      replyTo: replyTo ?? null,
    });

    await writeData(data);
    return { success: true, messageId: id };
  });

  if (outcome.success) {
    await writePresence(fromUuid);
    // Actively wake the recipient if it stays idle with this unread message.
    scheduleWake([toUuid]);
  }
  return outcome;
}

export async function replyToMessage(
  fromUuid: string,
  originalMessageId: string,
  content: string
): Promise<DirectSendResult> {
  let recipientUuid: string | null = null;
  const outcome = await withLock(async (): Promise<DirectSendResult> => {
    const data = await readData();

    if (!ensureParticipantExists(data, fromUuid)) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }

    const original = data.directMessages.find((message) => message.id === originalMessageId);
    if (!original) {
      return { success: false, error: `Original message ${originalMessageId} not found` };
    }

    const toUuid = original.from;
    if (!ensureParticipantExists(data, toUuid)) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }

    const id = uuidv4();
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
    await writeData(data);
    return { success: true, messageId: id };
  });

  if (outcome.success) {
    await writePresence(fromUuid);
    if (recipientUuid) {
      scheduleWake([recipientUuid]);
    }
  }
  return outcome;
}

export async function waitForReply(
  participantUuid: string,
  correlationMessageId: string,
  timeoutMs: number
): Promise<AskReplyResult> {
  await ensureDataDir();

  const scan = async (): Promise<boolean> => {
    const data = await readData();
    return data.directMessages.some(
      (message) =>
        message.to === participantUuid &&
        message.readAt === null &&
        message.replyTo === correlationMessageId
    );
  };

  const consume = async (): Promise<DirectMessageSummary | null> => {
    return withLock(async () => {
      const data = await readData();
      const match = data.directMessages.find(
        (message) =>
          message.to === participantUuid &&
          message.readAt === null &&
          message.replyTo === correlationMessageId
      );

      if (!match) {
        return null;
      }

      match.readAt = Date.now();
      const summary = directMessageSummaryFromData(data, match);
      await writeData(data);
      return summary;
    });
  };

  if (await scan()) {
    const message = await consume();
    if (message) {
      await writePresence(participantUuid);
      return { message, timedOut: false };
    }
  }

  return new Promise<AskReplyResult>((resolve) => {
    let settled = false;
    let busy = false;
    let dispose: () => void = () => {};
    let timer: ReturnType<typeof setTimeout>;

    const settle = (value: AskReplyResult) => {
      if (settled) {
        return;
      }
      settled = true;
      dispose();
      clearTimeout(timer);
      resolve(value);
    };

    const check = async () => {
      if (settled || busy) {
        return;
      }
      busy = true;
      try {
        if (await scan()) {
          const message = await consume();
          if (settled) {
            return;
          }
          if (message) {
            await writePresence(participantUuid);
            settle({ message, timedOut: false });
          }
        }
      } finally {
        busy = false;
      }
    };

    timer = setTimeout(() => settle({ message: null, timedOut: true }), timeoutMs);
    dispose = watchData(() => {
      void check();
    }, DEFAULT_FALLBACK_POLL_MS);
  });
}

// ---------------------------------------------------------------------------
// Groups + channels.
// ---------------------------------------------------------------------------

export async function createGroup(
  creatorUuid: string,
  name?: string
): Promise<GroupActionResult> {
  const result = await withLock(async (): Promise<GroupActionResult> => {
    const data = await readData();
    const creator = ensureParticipantExists(data, creatorUuid);
    if (!creator) {
      return { success: false, error: `Participant ${creatorUuid} not found` };
    }

    const groupUuid = uuidv4();
    const timestamp = Date.now();
    data.groups[groupUuid] = {
      uuid: groupUuid,
      name: name || `group-${groupUuid.slice(0, 8)}`,
      createdBy: creatorUuid,
      createdAt: timestamp,
      lastSequence: 0,
      members: {
        [creatorUuid]: {
          joinedAt: timestamp,
          lastReadSequence: 0,
        },
      },
    };

    await writeData(data);

    return {
      success: true,
      group: groupsForParticipant(data, creatorUuid).find((group) => group.uuid === groupUuid),
    };
  });

  if (result.success) {
    await writePresence(creatorUuid);
  }
  return result;
}

export async function joinGroup(
  participantUuid: string,
  groupUuid: string
): Promise<GroupActionResult> {
  const result = await withLock(async (): Promise<GroupActionResult> => {
    const data = await readData();
    const participant = ensureParticipantExists(data, participantUuid);
    if (!participant) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }

    const group = data.groups[groupUuid];
    if (!group) {
      return { success: false, error: `Group ${groupUuid} not found` };
    }

    if (!group.members[participantUuid]) {
      group.members[participantUuid] = {
        joinedAt: Date.now(),
        lastReadSequence: 0,
      };
    }

    await writeData(data);

    return {
      success: true,
      group: groupsForParticipant(data, participantUuid).find((entry) => entry.uuid === groupUuid),
    };
  });

  if (result.success) {
    await writePresence(participantUuid);
  }
  return result;
}

export async function joinChannel(
  participantUuid: string,
  name: string
): Promise<GroupActionResult> {
  const result = await withLock(async (): Promise<GroupActionResult & { groupUuid?: string }> => {
    const data = await readData();
    const participant = ensureParticipantExists(data, participantUuid);
    if (!participant) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }

    let group = findGroupByName(data, name);
    if (!group) {
      const groupUuid = uuidv4();
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
      group.members[participantUuid] = {
        joinedAt: Date.now(),
        lastReadSequence: 0,
      };
    }

    await writeData(data);

    return {
      success: true,
      groupUuid: group.uuid,
      group: groupsForParticipant(data, participantUuid).find((entry) => entry.uuid === group!.uuid),
    };
  });

  if (result.success) {
    await writePresence(participantUuid);
  }
  return { success: result.success, error: result.error, group: result.group };
}

export async function leaveGroup(
  participantUuid: string,
  groupUuid: string
): Promise<GroupActionResult> {
  const result = await withLock(async (): Promise<GroupActionResult> => {
    const data = await readData();
    const participant = ensureParticipantExists(data, participantUuid);
    if (!participant) {
      return { success: false, error: `Participant ${participantUuid} not found` };
    }

    const group = ensureGroupMember(data, groupUuid, participantUuid);
    if (!group) {
      return { success: false, error: `Group ${groupUuid} not found or not joined` };
    }

    delete group.members[participantUuid];
    await writeData(data);

    return { success: true };
  });

  if (result.success) {
    await writePresence(participantUuid);
  }
  return result;
}

export async function sendGroupMessage(
  fromUuid: string,
  groupUuid: string,
  content: string
): Promise<SendResult> {
  let recipients: string[] = [];
  const result = await withLock(async (): Promise<SendResult> => {
    const data = await readData();
    const participant = ensureParticipantExists(data, fromUuid);
    if (!participant) {
      return { success: false, error: `Participant ${fromUuid} not found` };
    }

    const group = ensureGroupMember(data, groupUuid, fromUuid);
    if (!group) {
      return { success: false, error: `Group ${groupUuid} not found or not joined` };
    }

    group.lastSequence += 1;
    data.groupMessages.push({
      id: uuidv4(),
      groupUuid,
      from: fromUuid,
      content,
      timestamp: Date.now(),
      sequence: group.lastSequence,
    });
    group.members[fromUuid].lastReadSequence = group.lastSequence;

    recipients = Object.keys(group.members).filter((member) => member !== fromUuid);
    await writeData(data);
    return { success: true };
  });

  if (result.success) {
    await writePresence(fromUuid);
    scheduleWake(recipients);
  }
  return result;
}

export async function sendChannelMessage(
  participantUuid: string,
  name: string,
  content: string
): Promise<SendResult> {
  let recipients: string[] = [];
  const result = await withLock(async (): Promise<SendResult> => {
    const data = await readData();
    const participant = ensureParticipantExists(data, participantUuid);
    if (!participant) {
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
      id: uuidv4(),
      groupUuid: group.uuid,
      from: participantUuid,
      content,
      timestamp: Date.now(),
      sequence: group.lastSequence,
    });
    group.members[participantUuid].lastReadSequence = group.lastSequence;

    recipients = Object.keys(group.members).filter((member) => member !== participantUuid);
    await writeData(data);
    return { success: true };
  });

  if (result.success) {
    await writePresence(participantUuid);
    scheduleWake(recipients);
  }
  return result;
}

export async function listGroups(participantUuid: string): Promise<GroupSummary[]> {
  const data = await readData();
  if (!ensureParticipantExists(data, participantUuid)) {
    return [];
  }

  await writePresence(participantUuid);
  return groupsForParticipant(data, participantUuid);
}

export async function getGroupThread(
  participantUuid: string,
  groupUuid: string,
  markRead: boolean = true
): Promise<GroupThreadResult | null> {
  const build = (data: StoreData, group: Group): GroupThreadResult => {
    const messages = data.groupMessages
      .filter((message) => message.groupUuid === groupUuid)
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => groupMessageSummaryFromData(data, message));

    return {
      group:
        groupsForParticipant(data, participantUuid).find((entry) => entry.uuid === groupUuid) ?? {
          uuid: group.uuid,
          name: group.name,
          createdBy: group.createdBy,
          createdAt: group.createdAt,
          unreadCount: 0,
          memberCount: Object.keys(group.members).length,
          members: [],
          lastMessage: messages[messages.length - 1] ?? null,
        },
      messages,
    };
  };

  if (!markRead) {
    const data = await readData();
    const group = ensureGroupMember(data, groupUuid, participantUuid);
    if (!group) {
      return null;
    }
    await writePresence(participantUuid);
    return build(data, group);
  }

  const result = await withLock(async (): Promise<GroupThreadResult | null> => {
    const data = await readData();
    const group = ensureGroupMember(data, groupUuid, participantUuid);
    if (!group) {
      return null;
    }

    group.members[participantUuid].lastReadSequence = group.lastSequence;
    const thread = build(data, group);
    await writeData(data);
    return thread;
  });

  if (result) {
    await writePresence(participantUuid);
  }
  return result;
}

export async function listActiveAgents(): Promise<ActiveAgent[]> {
  const [data, presence] = await Promise.all([readData(), readPresence()]);
  return activeAgentsFromData(data, presence);
}

export async function getParticipant(
  participantUuid: string
): Promise<PublicParticipant | null> {
  const data = await readData();
  const participant = data.participants[participantUuid];
  if (!participant) {
    return null;
  }

  await writePresence(participantUuid);
  return asPublicParticipant(participant);
}

// ---------------------------------------------------------------------------
// Inbox reads + waits.
// ---------------------------------------------------------------------------

export async function receive(
  participantUuid: string,
  clear: boolean = true
): Promise<ReceiveResult | null> {
  if (clear) {
    const result = await withLock(async (): Promise<ReceiveResult | null> => {
      const data = await readData();
      if (!ensureParticipantExists(data, participantUuid)) {
        return null;
      }

      const presence = withSelfPresence(await readPresence(), participantUuid);

      const directMessages = data.directMessages
        .filter((message) => message.to === participantUuid && message.readAt === null)
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((message) => directMessageSummaryFromData(data, message));

      const groupMessages = unreadGroupMessagesForParticipant(data, participantUuid);

      const now = Date.now();
      for (const message of data.directMessages) {
        if (message.to === participantUuid && message.readAt === null) {
          message.readAt = now;
        }
      }

      for (const group of Object.values(data.groups)) {
        const membership = group.members[participantUuid];
        if (membership) {
          membership.lastReadSequence = group.lastSequence;
        }
      }

      const outcome: ReceiveResult = {
        directMessages,
        groupMessages,
        groups: groupsForParticipant(data, participantUuid),
        activeAgents: activeAgentsFromData(data, presence),
      };

      await writeData(data);
      return outcome;
    });

    if (result !== null) {
      await writePresence(participantUuid);
    }
    return result;
  }

  // Lock-free read path: never rewrites data.json.
  const data = await readData();
  if (!ensureParticipantExists(data, participantUuid)) {
    return null;
  }

  const presence = withSelfPresence(await readPresence(), participantUuid);

  const directMessages = data.directMessages
    .filter((message) => message.to === participantUuid && message.readAt === null)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((message) => directMessageSummaryFromData(data, message));

  const groupMessages = unreadGroupMessagesForParticipant(data, participantUuid);

  const result: ReceiveResult = {
    directMessages,
    groupMessages,
    groups: groupsForParticipant(data, participantUuid),
    activeAgents: activeAgentsFromData(data, presence),
  };

  await writePresence(participantUuid);
  return result;
}

// ---------------------------------------------------------------------------
// Event-driven wait machinery (fs.watch + fallback poll).
// ---------------------------------------------------------------------------

function watchData(onChange: () => void, fallbackPollMs: number = DEFAULT_FALLBACK_POLL_MS): () => void {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(DATA_DIR, (_event, filename) => {
      if (!filename) {
        schedule();
        return;
      }
      const name = filename.toString();
      if (name.endsWith(".tmp") || name.includes(".lock")) {
        return;
      }
      if (name === "data.json") {
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
      } catch {
        // ignore
      }
    }
  };
}

export async function waitForMessages(
  participantUuid: string,
  timeoutMs: number = 60000,
  fallbackPollMs: number = DEFAULT_FALLBACK_POLL_MS
): Promise<WaitResult | null> {
  const immediate = await receive(participantUuid, false);
  if (immediate === null) {
    return null;
  }

  if (immediate.directMessages.length > 0 || immediate.groupMessages.length > 0) {
    const consumed = await receive(participantUuid, true);
    return consumed ? { ...consumed, timedOut: false } : null;
  }

  await ensureDataDir();

  return new Promise<WaitResult | null>((resolve) => {
    let settled = false;
    let busy = false;
    let dispose: () => void = () => {};
    let timer: ReturnType<typeof setTimeout>;

    const settle = (value: WaitResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      dispose();
      clearTimeout(timer);
      resolve(value);
    };

    const onTimeout = async () => {
      const final = await receive(participantUuid, false);
      settle(final ? { ...final, timedOut: true } : null);
    };

    const check = async () => {
      if (settled || busy) {
        return;
      }
      busy = true;
      try {
        const snapshot = await receive(participantUuid, false);
        if (settled) {
          return;
        }
        if (snapshot === null) {
          settle(null);
          return;
        }
        if (snapshot.directMessages.length > 0 || snapshot.groupMessages.length > 0) {
          const consumed = await receive(participantUuid, true);
          if (settled) {
            return;
          }
          settle(consumed ? { ...consumed, timedOut: false } : null);
        }
      } finally {
        busy = false;
      }
    };

    timer = setTimeout(() => {
      void onTimeout();
    }, timeoutMs);
    dispose = watchData(() => {
      void check();
    }, fallbackPollMs);
  });
}

export async function getEventSnapshot(
  participantUuid: string
): Promise<EventSnapshot | null> {
  const data = await readData();
  if (!ensureParticipantExists(data, participantUuid)) {
    return null;
  }

  const presence = withSelfPresence(await readPresence(), participantUuid);

  const unreadDirectCount = data.directMessages.filter(
    (message) => message.to === participantUuid && message.readAt === null
  ).length;

  const groups = groupsForParticipant(data, participantUuid);
  const messagesFingerprint = JSON.stringify(
    groups.map((group) => ({
      uuid: group.uuid,
      unreadCount: group.unreadCount,
      lastMessageId: group.lastMessage?.id ?? null,
    }))
  );

  const groupsFingerprint = JSON.stringify(
    groups.map((group) => ({
      uuid: group.uuid,
      memberCount: group.memberCount,
      memberIds: group.members.map((member) => member.uuid).sort(),
    }))
  );

  const activeAgentsFingerprint = JSON.stringify(
    activeAgentsFromData(data, presence).map((agent) => ({
      uuid: agent.uuid,
      lastSeen: agent.lastSeen,
    }))
  );

  await writePresence(participantUuid);

  return {
    directUnreadCount: unreadDirectCount,
    groupsFingerprint,
    messagesFingerprint,
    activeAgentsFingerprint,
  };
}
