import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

export type ParticipantType = "agent" | "human";

export interface Participant {
  uuid: string;
  type: ParticipantType;
  name: string;
  createdAt: number;
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
  version: 2;
  participants: Record<string, Participant>;
  presence: Record<string, Presence>;
  groups: Record<string, Group>;
  directMessages: DirectMessage[];
  groupMessages: GroupMessage[];
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

export interface GroupActionResult extends SendResult {
  group?: GroupSummary;
}

export interface GroupThreadResult {
  group: GroupSummary;
  messages: GroupMessageSummary[];
}

export interface EventSnapshot {
  directUnreadCount: number;
  groupsFingerprint: string;
  messagesFingerprint: string;
  activeAgentsFingerprint: string;
}

const DATA_DIR = process.env.AGENT_MESSENGER_DATA_DIR ?? path.join(os.homedir(), ".agent-comm");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const LOCK_PATH = path.join(DATA_DIR, ".lock");

const ACTIVE_PRESENCE_TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;

function createEmptyStore(): StoreData {
  return {
    version: 2,
    participants: {},
    presence: {},
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

function normalizeStoreData(raw: unknown): StoreData {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as Partial<StoreData>).version === 2 &&
    (raw as Partial<StoreData>).participants &&
    (raw as Partial<StoreData>).groups
  ) {
    return cleanupData(raw as StoreData);
  }

  return cleanupData(migrateLegacyStore(raw as LegacyStoreData | undefined));
}

function migrateLegacyStore(legacy?: LegacyStoreData): StoreData {
  const data = createEmptyStore();
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
      data.presence[uuid] = { lastSeen: legacyAgent.lastSeen };
    }
  }

  data.directMessages = legacyMessages.map((message) => ({
    id: message.id,
    from: message.from,
    to: message.to,
    content: message.content,
    timestamp: message.timestamp,
    readAt: null,
  }));

  return data;
}

async function readData(): Promise<StoreData> {
  try {
    const content = await fs.readFile(DATA_FILE, "utf-8");
    return normalizeStoreData(JSON.parse(content) as unknown);
  } catch {
    return createEmptyStore();
  }
}

async function writeData(data: StoreData): Promise<void> {
  const tempFile = DATA_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
  await fs.rename(tempFile, DATA_FILE);
}

function cleanupData(data: StoreData): StoreData {
  const now = Date.now();
  const cleanedPresence: Record<string, Presence> = {};

  for (const [uuid, presence] of Object.entries(data.presence ?? {})) {
    if (data.participants[uuid] && now - presence.lastSeen < ACTIVE_PRESENCE_TTL_MS) {
      cleanedPresence[uuid] = presence;
    }
  }

  const cleanedGroups: Record<string, Group> = {};
  for (const [groupUuid, group] of Object.entries(data.groups ?? {})) {
    const members: Record<string, GroupMembership> = {};
    for (const [memberUuid, membership] of Object.entries(group.members ?? {})) {
      if (data.participants[memberUuid]) {
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

  const directMessages = (data.directMessages ?? []).filter(
    (message) => validParticipants.has(message.from) && validParticipants.has(message.to)
  );

  const groupMessages = (data.groupMessages ?? []).filter(
    (message) => validParticipants.has(message.from) && validGroups.has(message.groupUuid)
  );

  return {
    version: 2,
    participants: data.participants ?? {},
    presence: cleanedPresence,
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

function touchPresence(data: StoreData, uuid: string): void {
  if (data.participants[uuid]) {
    data.presence[uuid] = { lastSeen: Date.now() };
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

function activeAgentsFromData(data: StoreData): ActiveAgent[] {
  return Object.values(data.participants)
    .filter((participant) => participant.type === "agent" && data.presence[participant.uuid])
    .map((participant) => ({
      ...asPublicParticipant(participant),
      lastSeen: data.presence[participant.uuid].lastSeen,
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
          if (!participant) {
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
  return withLock(async () => {
    const data = await readData();

    if (participantUuid && data.participants[participantUuid]?.type === type) {
      if (name) {
        data.participants[participantUuid].name = name;
      }
      touchPresence(data, participantUuid);
      await writeData(data);
      return {
        uuid: participantUuid,
        name: data.participants[participantUuid].name,
        type,
      };
    }

    const existing = findParticipantByName(data, type, name);
    if (existing) {
      touchPresence(data, existing.uuid);
      await writeData(data);
      return { uuid: existing.uuid, name: existing.name, type };
    }

    const uuid = uuidv4();
    const participantName = name || `${type}-${uuid.slice(0, 8)}`;
    data.participants[uuid] = {
      uuid,
      type,
      name: participantName,
      createdAt: Date.now(),
    };
    touchPresence(data, uuid);
    await writeData(data);

    return { uuid, name: participantName, type };
  });
}

export async function sendDirectMessage(
  fromUuid: string,
  toUuid: string,
  content: string
): Promise<SendResult> {
  return withLock(async () => {
    const data = await readData();

    if (!ensureParticipantExists(data, fromUuid)) {
      return { success: false, error: `Sender ${fromUuid} not found` };
    }

    if (!ensureParticipantExists(data, toUuid)) {
      return { success: false, error: `Recipient ${toUuid} not found` };
    }

    touchPresence(data, fromUuid);
    data.directMessages.push({
      id: uuidv4(),
      from: fromUuid,
      to: toUuid,
      content,
      timestamp: Date.now(),
      readAt: null,
    });

    await writeData(data);
    return { success: true };
  });
}

export async function createGroup(
  creatorUuid: string,
  name?: string
): Promise<GroupActionResult> {
  return withLock(async () => {
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

    touchPresence(data, creatorUuid);
    await writeData(data);

    return {
      success: true,
      group: groupsForParticipant(data, creatorUuid).find((group) => group.uuid === groupUuid),
    };
  });
}

export async function joinGroup(
  participantUuid: string,
  groupUuid: string
): Promise<GroupActionResult> {
  return withLock(async () => {
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

    touchPresence(data, participantUuid);
    await writeData(data);

    return {
      success: true,
      group: groupsForParticipant(data, participantUuid).find((entry) => entry.uuid === groupUuid),
    };
  });
}

export async function leaveGroup(
  participantUuid: string,
  groupUuid: string
): Promise<GroupActionResult> {
  return withLock(async () => {
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
    touchPresence(data, participantUuid);
    await writeData(data);

    return { success: true };
  });
}

export async function sendGroupMessage(
  fromUuid: string,
  groupUuid: string,
  content: string
): Promise<SendResult> {
  return withLock(async () => {
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

    touchPresence(data, fromUuid);
    await writeData(data);
    return { success: true };
  });
}

export async function listGroups(participantUuid: string): Promise<GroupSummary[]> {
  return withLock(async () => {
    const data = await readData();
    if (!ensureParticipantExists(data, participantUuid)) {
      return [];
    }

    touchPresence(data, participantUuid);
    await writeData(data);
    return groupsForParticipant(data, participantUuid);
  });
}

export async function getGroupThread(
  participantUuid: string,
  groupUuid: string,
  markRead: boolean = true
): Promise<GroupThreadResult | null> {
  return withLock(async () => {
    const data = await readData();
    const group = ensureGroupMember(data, groupUuid, participantUuid);
    if (!group) {
      return null;
    }

    touchPresence(data, participantUuid);
    const messages = data.groupMessages
      .filter((message) => message.groupUuid === groupUuid)
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => groupMessageSummaryFromData(data, message));

    if (markRead) {
      group.members[participantUuid].lastReadSequence = group.lastSequence;
    }

    await writeData(data);

    return {
      group: groupsForParticipant(data, participantUuid).find((entry) => entry.uuid === groupUuid) ?? {
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
  });
}

export async function listActiveAgents(): Promise<ActiveAgent[]> {
  return withLock(async () => {
    const data = await readData();
    await writeData(data);
    return activeAgentsFromData(data);
  });
}

export async function getParticipant(
  participantUuid: string
): Promise<PublicParticipant | null> {
  return withLock(async () => {
    const data = await readData();
    const participant = data.participants[participantUuid];
    if (!participant) {
      return null;
    }

    touchPresence(data, participantUuid);
    await writeData(data);
    return asPublicParticipant(participant);
  });
}

export async function receive(
  participantUuid: string,
  clear: boolean = true
): Promise<ReceiveResult | null> {
  return withLock(async () => {
    const data = await readData();
    if (!ensureParticipantExists(data, participantUuid)) {
      return null;
    }

    touchPresence(data, participantUuid);

    const directMessages = data.directMessages
      .filter((message) => message.to === participantUuid && message.readAt === null)
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((message) => directMessageSummaryFromData(data, message));

    const groupMessages = unreadGroupMessagesForParticipant(data, participantUuid);

    if (clear) {
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
    }

    const result: ReceiveResult = {
      directMessages,
      groupMessages,
      groups: groupsForParticipant(data, participantUuid),
      activeAgents: activeAgentsFromData(data),
    };

    await writeData(data);
    return result;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMessages(
  participantUuid: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 2000
): Promise<WaitResult | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await receive(participantUuid, false);
    if (!result) {
      return null;
    }

    if (result.directMessages.length > 0 || result.groupMessages.length > 0) {
      const finalResult = await receive(participantUuid, true);
      return finalResult ? { ...finalResult, timedOut: false } : null;
    }

    await sleep(pollIntervalMs);
  }

  const finalResult = await receive(participantUuid, false);
  return finalResult ? { ...finalResult, timedOut: true } : null;
}

export async function getEventSnapshot(
  participantUuid: string
): Promise<EventSnapshot | null> {
  return withLock(async () => {
    const data = await readData();
    if (!ensureParticipantExists(data, participantUuid)) {
      return null;
    }

    touchPresence(data, participantUuid);

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
      activeAgentsFromData(data).map((agent) => ({ uuid: agent.uuid, lastSeen: agent.lastSeen }))
    );

    await writeData(data);

    return {
      directUnreadCount: unreadDirectCount,
      groupsFingerprint,
      messagesFingerprint,
      activeAgentsFingerprint,
    };
  });
}
