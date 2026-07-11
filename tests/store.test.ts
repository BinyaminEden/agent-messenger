import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath as realpathAsync, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Repo root resolved from the compiled test location (dist/tests/store.test.js).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INBOX_HOOK = path.join(REPO_ROOT, 'skill', 'scripts', 'inbox-hook.js');
const SESSION_HOOK = path.join(REPO_ROOT, 'skill', 'scripts', 'session-hook.js');

function runSessionHook(dir: string, input: Record<string, unknown>): { stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env, AGENT_MESSENGER_DATA_DIR: dir };
  delete env.AGENT_MESSENGER_NAME;
  const result = spawnSync(process.execPath, [SESSION_HOOK], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '' };
}

function readSessions(dir: string): Record<string, any> {
  const parsed = JSON.parse(readFileSync(path.join(dir, 'identities.json'), 'utf8'));
  return (parsed && parsed.sessions) || {};
}

function deriveIdentityName(cwd: string): string {
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 6);
  return `${path.basename(cwd)}-${hash}`;
}

function runInboxHook(dir: string, input: Record<string, unknown>): { stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env, AGENT_MESSENGER_DATA_DIR: dir };
  delete env.AGENT_MESSENGER_NAME;
  const result = spawnSync(process.execPath, [INBOX_HOOK], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '' };
}

async function withStore<T>(run: (store: typeof import('../src/store.js'), dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-'));
  process.env.AGENT_MESSENGER_DATA_DIR = dir;
  const moduleUrl = new URL(`../src/store.js?ts=${Date.now()}-${Math.random()}`, import.meta.url);
  const store = (await import(moduleUrl.href)) as typeof import('../src/store.js');

  try {
    return await run(store, dir);
  } finally {
    delete process.env.AGENT_MESSENGER_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
}

test('migrates legacy data without losing direct messages', async () => {
  await withStore(async (store, dir) => {
    const legacy = {
      agents: {
        'agent-a': { name: 'Alice', lastSeen: Date.now() },
        'agent-b': { name: 'Bob', lastSeen: Date.now() },
      },
      messages: [
        {
          id: 'legacy-message',
          from: 'agent-a',
          to: 'agent-b',
          content: 'hello from v1',
          timestamp: Date.now(),
        },
      ],
    };
    await writeFile(path.join(dir, 'data.json'), JSON.stringify(legacy, null, 2));

    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    const inbox = await store.receive(bob.uuid, false);

    assert.equal(alice.uuid, 'agent-a');
    assert.equal(bob.uuid, 'agent-b');
    assert.equal(inbox?.directMessages.length, 1);
    assert.equal(inbox?.directMessages[0].content, 'hello from v1');
  });
});

test('agent identity is persistent even after presence expires', async () => {
  await withStore(async (store, dir) => {
    const first = await store.registerAgent('Persistent Agent');
    const presencePath = path.join(dir, 'presence.json');
    await writeFile(
      presencePath,
      JSON.stringify({ version: 1, presence: { [first.uuid]: { lastSeen: 0 } } }, null, 2)
    );

    const second = await store.registerAgent('Persistent Agent');
    assert.equal(second.uuid, first.uuid);
  });
});

test('direct messages survive offline recipients', async () => {
  await withStore(async (store, dir) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    await store.sendDirectMessage(alice.uuid, bob.uuid, 'offline ping');

    const presencePath = path.join(dir, 'presence.json');
    await writeFile(
      presencePath,
      JSON.stringify({ version: 1, presence: { [bob.uuid]: { lastSeen: 0 } } }, null, 2)
    );

    const inbox = await store.receive(bob.uuid, false);
    assert.equal(inbox?.directMessages.length, 1);
    assert.equal(inbox?.directMessages[0].content, 'offline ping');
  });
});

test('group history is shared and read state is per member', async () => {
  await withStore(async (store) => {
    const human = await store.registerHuman('Eden');
    const alpha = await store.registerAgent('Alpha');
    const beta = await store.registerAgent('Beta');

    const created = await store.createGroup(human.uuid, 'team-room');
    const groupUuid = created.group?.uuid;
    assert.ok(groupUuid);

    await store.sendGroupMessage(human.uuid, groupUuid!, 'initial brief');
    await store.joinGroup(alpha.uuid, groupUuid!);
    await store.joinGroup(beta.uuid, groupUuid!);

    const alphaThread = await store.getGroupThread(alpha.uuid, groupUuid!, true);
    assert.equal(alphaThread?.messages.length, 1);
    assert.equal(alphaThread?.messages[0].content, 'initial brief');

    await store.sendGroupMessage(alpha.uuid, groupUuid!, 'alpha follow-up');

    const humanGroups = await store.listGroups(human.uuid);
    const betaGroups = await store.listGroups(beta.uuid);
    const alphaGroups = await store.listGroups(alpha.uuid);

    assert.equal(alphaGroups[0].unreadCount, 0);
    assert.equal(humanGroups[0].unreadCount, 1);
    assert.equal(betaGroups[0].unreadCount, 2);
  });
});

test('waitForMessages wakes for group traffic', async () => {
  await withStore(async (store) => {
    const alpha = await store.registerAgent('Alpha');
    const beta = await store.registerAgent('Beta');
    const created = await store.createGroup(alpha.uuid, 'async-room');
    const groupUuid = created.group?.uuid;
    assert.ok(groupUuid);
    await store.joinGroup(beta.uuid, groupUuid!);

    const waitPromise = store.waitForMessages(beta.uuid, 1000, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await store.sendGroupMessage(alpha.uuid, groupUuid!, 'wake up');

    const result = await waitPromise;
    assert.equal(result?.timedOut, false);
    assert.equal(result?.groupMessages.length, 1);
    assert.equal(result?.groupMessages[0].content, 'wake up');
  });
});

test('migrates v2 data to v3 losslessly (presence moved, replyTo defaulted)', async () => {
  await withStore(async (store, dir) => {
    const now = Date.now();
    const v2 = {
      version: 2,
      participants: {
        'p-alice': { uuid: 'p-alice', type: 'agent', name: 'Alice', createdAt: now },
        'p-bob': { uuid: 'p-bob', type: 'agent', name: 'Bob', createdAt: now },
      },
      groups: {},
      directMessages: [
        {
          id: 'dm-1',
          from: 'p-alice',
          to: 'p-bob',
          content: 'v2 ping',
          timestamp: now,
          readAt: null,
          // NOTE: no replyTo field on disk
        },
      ],
      groupMessages: [],
      presence: {
        'p-alice': { lastSeen: now },
        'p-bob': { lastSeen: now },
      },
    };
    await writeFile(path.join(dir, 'data.json'), JSON.stringify(v2, null, 2));

    // A lock-free read normalizes in memory and best-effort moves presence out.
    const inbox = await store.receive('p-bob', false);
    assert.equal(inbox?.directMessages.length, 1);
    assert.equal(inbox?.directMessages[0].content, 'v2 ping');
    assert.equal(inbox?.directMessages[0].replyTo, null);

    // Presence lands in presence.json, migrated from the v2 data.json field.
    const presence = JSON.parse(await readFile(path.join(dir, 'presence.json'), 'utf8'));
    assert.equal(presence.version, 1);
    assert.ok(presence.presence['p-alice']);
    assert.ok(presence.presence['p-bob']);

    // A real mutation rewrites data.json in the v3 shape (no presence key).
    await store.sendDirectMessage('p-alice', 'p-bob', 'v3 followup');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
    assert.equal(onDisk.version, 3);
    assert.equal('presence' in onDisk, false);
    assert.equal(onDisk.directMessages.length, 2);
    for (const message of onDisk.directMessages) {
      assert.equal('replyTo' in message, true);
    }
    assert.equal(onDisk.directMessages[0].replyTo, null);
  });
});

test('resolveParticipantRef resolves by uuid, unique name, and reports errors', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    await store.registerAgent('Bob');

    // uuid passthrough
    const byUuid = await store.resolveParticipantRef(alice.uuid);
    assert.deepEqual(byUuid, { uuid: alice.uuid });

    // unique name
    const byName = await store.resolveParticipantRef('Alice');
    assert.deepEqual(byName, { uuid: alice.uuid });

    // unknown name
    const unknown = await store.resolveParticipantRef('Nobody');
    assert.ok('error' in unknown && unknown.error.includes("No participant named 'Nobody'"));

    // ambiguous name: two participants sharing a name
    const dupe = await store.registerHuman('Alice');
    const ambiguous = await store.resolveParticipantRef('Alice');
    assert.ok('error' in ambiguous && ambiguous.error.includes("Ambiguous name 'Alice'"));
    assert.ok(
      'error' in ambiguous &&
        ambiguous.error.includes(alice.uuid) &&
        ambiguous.error.includes(dupe.uuid)
    );
  });
});

test('resolveIdentity honors env name and derives a stable per-cwd name otherwise', async () => {
  await withStore(async (store) => {
    const cwd = '/some/fixed/project';
    const previousName = process.env.AGENT_MESSENGER_NAME;

    // Explicit env name adopts that identity.
    process.env.AGENT_MESSENGER_NAME = 'ExplicitName';
    try {
      const explicit = await store.resolveIdentity(cwd);
      assert.equal(explicit.name, 'ExplicitName');
      assert.equal(explicit.type, 'agent');
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }

    // Without env, derive deterministic basename-hash, stable across calls.
    delete process.env.AGENT_MESSENGER_NAME;
    const first = await store.resolveIdentity(cwd);
    const second = await store.resolveIdentity(cwd);
    assert.equal(first.name, deriveIdentityName(cwd));
    assert.equal(first.uuid, second.uuid);

    // Different cwd sharing a basename gets a distinct suffix/uuid.
    const other = await store.resolveIdentity('/other/fixed/project');
    assert.notEqual(other.name, first.name);
    assert.notEqual(other.uuid, first.uuid);

    // Zero-setup: send using an auto-resolved identity, no explicit register.
    const bob = await store.registerAgent('Bob');
    const sent = await store.sendDirectMessage(first.uuid, bob.uuid, 'auto-identity works');
    assert.equal(sent.success, true);
    assert.ok(sent.messageId);
  });
});

test('waitForReply only unblocks on the correlated reply', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    const carol = await store.registerAgent('Carol');

    // Alice asks Bob; capture the correlation id.
    const ask = await store.sendDirectMessage(alice.uuid, bob.uuid, 'what is the status?');
    assert.ok(ask.messageId);
    const askId = ask.messageId!;

    const waitPromise = store.waitForReply(alice.uuid, askId, 1500);

    // Unrelated traffic from Carol must NOT unblock the correlated wait.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await store.sendDirectMessage(carol.uuid, alice.uuid, 'unrelated hello');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The correlated reply unblocks.
    const reply = await store.replyToMessage(bob.uuid, askId, 'status is green');

    const result = await waitPromise;
    assert.equal(result.timedOut, false);
    assert.ok(result.message);
    assert.equal(result.message!.content, 'status is green');
    assert.equal(result.message!.replyTo, askId);
    assert.equal(result.message!.id, reply.messageId);

    // The unrelated message was never consumed and is still deliverable.
    const inbox = await store.receive(alice.uuid, true);
    const contents = inbox?.directMessages.map((m) => m.content) ?? [];
    assert.ok(contents.includes('unrelated hello'));
    assert.ok(!contents.includes('status is green'));
  });
});

test('waitForReply times out when no correlated reply arrives', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    const ask = await store.sendDirectMessage(alice.uuid, bob.uuid, 'ping');
    const result = await store.waitForReply(alice.uuid, ask.messageId!, 250);
    assert.equal(result.timedOut, true);
    assert.equal(result.message, null);
  });
});

test('replyToMessage targets the original sender and errors on unknown id', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');

    const ask = await store.sendDirectMessage(alice.uuid, bob.uuid, 'question');
    const reply = await store.replyToMessage(bob.uuid, ask.messageId!, 'answer');
    assert.equal(reply.success, true);

    // The reply is addressed back to the original sender (Alice) with correlation.
    const inbox = await store.receive(alice.uuid, false);
    const replies = inbox?.directMessages.filter((m) => m.replyTo === ask.messageId) ?? [];
    assert.equal(replies.length, 1);
    assert.equal(replies[0].from, bob.uuid);
    assert.equal(replies[0].content, 'answer');

    // Unknown original message id yields an error.
    const bad = await store.replyToMessage(bob.uuid, 'no-such-message', 'nope');
    assert.equal(bad.success, false);
    assert.ok(bad.error);
  });
});

test('channels create-on-join, are idempotent, and deliver as group messages', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');

    const first = await store.joinChannel(alice.uuid, 'general');
    assert.equal(first.success, true);
    const channelUuid = first.group?.uuid;
    assert.ok(channelUuid);

    // Same name join is idempotent — same underlying group uuid.
    const again = await store.joinChannel(alice.uuid, 'general');
    assert.equal(again.group?.uuid, channelUuid);

    await store.joinChannel(bob.uuid, 'general');
    const sent = await store.sendChannelMessage(alice.uuid, 'general', 'hello channel');
    assert.equal(sent.success, true);

    // Bob receives it as a group message.
    const inbox = await store.receive(bob.uuid, false);
    const groupMsgs = inbox?.groupMessages ?? [];
    assert.equal(groupMsgs.length, 1);
    assert.equal(groupMsgs[0].content, 'hello channel');
    assert.equal(groupMsgs[0].groupUuid, channelUuid);

    // A pre-existing group created via group_create is reused by channel name.
    const room = await store.createGroup(alice.uuid, 'ops-room');
    const roomUuid = room.group?.uuid;
    const joined = await store.joinChannel(bob.uuid, 'ops-room');
    assert.equal(joined.group?.uuid, roomUuid);
  });
});

test('sendChannelMessage requires membership', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    await store.joinChannel(alice.uuid, 'secret');
    const denied = await store.sendChannelMessage(bob.uuid, 'secret', 'intrusion');
    assert.equal(denied.success, false);
    assert.ok(denied.error);
  });
});

test('lock-free reads do not rewrite data.json but touch presence.json', async () => {
  await withStore(async (store, dir) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    await store.sendDirectMessage(alice.uuid, bob.uuid, 'unread ping');

    const dataPath = path.join(dir, 'data.json');
    const presencePath = path.join(dir, 'presence.json');

    // Backdate presence so a fresh write is observable.
    await writeFile(
      presencePath,
      JSON.stringify({ version: 1, presence: { [bob.uuid]: { lastSeen: 1 } } }, null, 2)
    );

    const before = await readFile(dataPath, 'utf8');
    const beforeMtime = (await stat(dataPath)).mtimeMs;

    await store.receive(bob.uuid, false);
    await store.listGroups(bob.uuid);
    await store.getParticipant(bob.uuid);

    const after = await readFile(dataPath, 'utf8');
    assert.equal(after, before, 'lock-free reads must not modify data.json content');
    assert.equal((await stat(dataPath)).mtimeMs, beforeMtime);

    // Presence WAS refreshed by the reads.
    const presence = JSON.parse(await readFile(presencePath, 'utf8'));
    assert.ok(presence.presence[bob.uuid].lastSeen > 1);

    // A clearing receive DOES mutate data.json.
    await store.receive(bob.uuid, true);
    const afterClear = await readFile(dataPath, 'utf8');
    assert.notEqual(afterClear, before, 'receive(clear=true) must mutate data.json');
  });
});

test('waitForMessages wakes well before the fallback poll interval', async () => {
  await withStore(async (store) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');

    const start = Date.now();
    // Long timeout, long fallback poll: only an event can wake it quickly.
    const waitPromise = store.waitForMessages(bob.uuid, 5000, 5000);
    setTimeout(() => {
      void store.sendDirectMessage(alice.uuid, bob.uuid, 'fast wake');
    }, 50);

    const result = await waitPromise;
    const elapsed = Date.now() - start;
    assert.equal(result?.timedOut, false);
    assert.equal(result?.directMessages.length, 1);
    assert.equal(result?.directMessages[0].content, 'fast wake');
    assert.ok(elapsed < 4000, `expected event-driven wake, took ${elapsed}ms`);
  });
});

test('inbox-hook blocks on unread, allows when clear, and never consumes messages', async () => {
  await withStore(async (store, dir) => {
    const cwd = '/hooked/project/dir';
    const previousName = process.env.AGENT_MESSENGER_NAME;
    delete process.env.AGENT_MESSENGER_NAME;

    try {
      // Register the identity the hook will derive from cwd.
      const me = await store.resolveIdentity(cwd);
      assert.equal(me.name, deriveIdentityName(cwd));
      const sender = await store.registerAgent('Sender');
      await store.sendDirectMessage(sender.uuid, me.uuid, 'unread one');
      await store.sendDirectMessage(sender.uuid, me.uuid, 'unread two');

      // unread > 0 → block with a reason.
      const blocked = runInboxHook(dir, { cwd, stop_hook_active: false, hook_event_name: 'Stop' });
      const decision = JSON.parse(blocked.stdout);
      assert.equal(decision.decision, 'block');
      assert.ok(decision.reason.includes('2 unread'));

      // The hook did NOT clear anything — messages still deliverable.
      const inbox = await store.receive(me.uuid, false);
      assert.equal(inbox?.directMessages.length, 2);

      // stop_hook_active === true → allow even with unread (loop safety).
      const looped = runInboxHook(dir, { cwd, stop_hook_active: true, hook_event_name: 'Stop' });
      assert.equal(looped.stdout.trim(), '');

      // Consume the messages; unread == 0 → allow (no output).
      await store.receive(me.uuid, true);
      const cleared = runInboxHook(dir, { cwd, stop_hook_active: false, hook_event_name: 'Stop' });
      assert.equal(cleared.stdout.trim(), '');
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }
  });
});

test('inbox-hook recovers the server-pinned identity after the session cd\'s into a subdirectory', async () => {
  await withStore(async (store, dir) => {
    const previousName = process.env.AGENT_MESSENGER_NAME;
    delete process.env.AGENT_MESSENGER_NAME;

    // Real directories so the hook's realpath/ancestor walk is exercised.
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-proj-'));
    const subDir = path.join(projectDir, 'nested', 'subdir-B');
    await mkdir(subDir, { recursive: true });

    try {
      // The MCP server pins its identity to the directory it launched in.
      const me = await store.resolveIdentity(projectDir);
      const sender = await store.registerAgent('Sender');
      await store.sendDirectMessage(sender.uuid, me.uuid, 'unread drift');

      // The session later `cd`s deeper; the Stop hook fires with the live,
      // drifted cwd. It must still recover the SAME identity and block.
      const drifted = runInboxHook(dir, {
        cwd: subDir,
        stop_hook_active: false,
        hook_event_name: 'Stop',
      });
      const decision = JSON.parse(drifted.stdout);
      assert.equal(decision.decision, 'block');
      assert.ok(decision.reason.includes('1 unread'));

      // At the exact launch cwd there is no drift — still blocks (regression-safe).
      const atRoot = runInboxHook(dir, {
        cwd: projectDir,
        stop_hook_active: false,
        hook_event_name: 'Stop',
      });
      assert.equal(JSON.parse(atRoot.stdout).decision, 'block');

      // The hook never consumed anything.
      const inbox = await store.receive(me.uuid, false);
      assert.equal(inbox?.directMessages.length, 1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }
  });
});

test('agent_whoami reports the renamed identity instead of re-deriving a duplicate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-whoami-'));
  const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-whoami-cwd-'));
  const serverPath = path.join(REPO_ROOT, 'dist', 'src', 'index.js');

  // getDefaultEnvironment() only inherits a whitelist, so AGENT_MESSENGER_NAME
  // does NOT leak into the child — identity auto-resolves from cwd.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectDir,
    env: { AGENT_MESSENGER_DATA_DIR: dir },
  });
  const client = new Client({ name: 'whoami-test', version: '1.0.0' });

  try {
    await client.connect(transport);

    const parseTool = (result: unknown): Record<string, unknown> => {
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      return JSON.parse(content[0].text);
    };

    // Rename the auto-resolved identity to Alice (keeps the same uuid).
    const registered = parseTool(
      await client.callTool({ name: 'agent_register', arguments: { name: 'Alice' } })
    );
    assert.equal(registered.name, 'Alice');
    const aliceUuid = registered.uuid as string;

    // whoami must REPORT the renamed identity, not switch to a fresh duplicate.
    const who = parseTool(await client.callTool({ name: 'agent_whoami', arguments: {} }));
    assert.equal(who.uuid, aliceUuid);
    assert.equal(who.name, 'Alice');

    // A follow-up tool call still acts as the renamed identity.
    const whoAgain = parseTool(await client.callTool({ name: 'agent_whoami', arguments: {} }));
    assert.equal(whoAgain.uuid, aliceUuid);

    // No orphaned duplicate participant was left behind in data.json.
    const onDisk = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
    const agents = Object.values(onDisk.participants).filter(
      (participant: any) => participant.type === 'agent'
    );
    assert.equal(agents.length, 1);
    assert.equal((agents[0] as any).name, 'Alice');
  } finally {
    await client.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('session-hook registers a participant with uuid == session_id and records a session', async () => {
  await withStore(async (store, dir) => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-sess-'));
    try {
      const sessionId = crypto.randomUUID();
      runSessionHook(dir, {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'SessionStart',
        source: 'startup',
      });

      // The participant's uuid IS the session id, named <basename>-<sid6>.
      const participant = await store.getParticipant(sessionId);
      assert.ok(participant, 'participant registered under the session_id');
      assert.equal(participant!.uuid, sessionId);
      assert.equal(participant!.name, `${path.basename(projectDir)}-${sessionId.slice(0, 6)}`);

      // A session record was written (uuid == session_id, realpath cwd, numeric ppid).
      const sessions = readSessions(dir);
      const record = sessions[sessionId];
      assert.ok(record, 'session record present');
      assert.equal(record.uuid, sessionId);
      assert.equal(record.cwd, await realpathAsync(projectDir));
      assert.equal(typeof record.ppid, 'number');

      // Idempotent upsert on resume — same uuid, no duplicate participant.
      runSessionHook(dir, {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'SessionStart',
        source: 'resume',
      });
      const onDisk = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
      const matching = Object.values(onDisk.participants).filter(
        (p: any) => p.uuid === sessionId
      );
      assert.equal(matching.length, 1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

test('resolveIdentity picks the session whose ppid matches this process, then falls back to cwd', async () => {
  await withStore(async (store, dir) => {
    const previousName = process.env.AGENT_MESSENGER_NAME;
    delete process.env.AGENT_MESSENGER_NAME;

    const cwd = await mkdtemp(path.join(tmpdir(), 'agent-messenger-ppid-'));
    try {
      const ppidUuid = crypto.randomUUID();
      const cwdUuid = crypto.randomUUID();
      const realCwd = await realpathAsync(cwd);

      // Two session records: one matches this process's ppid, one only matches cwd.
      await writeFile(
        path.join(dir, 'identities.json'),
        JSON.stringify(
          {
            version: 1,
            identities: {},
            sessions: {
              [ppidUuid]: {
                session_id: ppidUuid,
                cwd: '/unrelated/dir',
                name: 'PpidAgent',
                uuid: ppidUuid,
                ppid: process.ppid,
                updatedAt: 2000,
              },
              [cwdUuid]: {
                session_id: cwdUuid,
                cwd: realCwd,
                name: 'CwdAgent',
                uuid: cwdUuid,
                ppid: 999999,
                updatedAt: 5000,
              },
            },
          },
          null,
          2
        )
      );

      // Priority (1): ppid match wins even though the cwd record is fresher.
      const byPpid = await store.resolveIdentity(cwd);
      assert.equal(byPpid.uuid, ppidUuid);
      assert.equal(byPpid.name, 'PpidAgent');

      // Priority (2): with no ppid match, the cwd-matching session resolves.
      await writeFile(
        path.join(dir, 'identities.json'),
        JSON.stringify(
          {
            version: 1,
            identities: {},
            sessions: {
              [cwdUuid]: {
                session_id: cwdUuid,
                cwd: realCwd,
                name: 'CwdAgent',
                uuid: cwdUuid,
                ppid: 999999,
                updatedAt: 5000,
              },
            },
          },
          null,
          2
        )
      );
      const byCwd = await store.resolveIdentity(cwd);
      assert.equal(byCwd.uuid, cwdUuid);
      assert.equal(byCwd.name, 'CwdAgent');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }
  });
});

test('resolveIdentity falls back to cwd-derivation when no session records exist', async () => {
  await withStore(async (store) => {
    const previousName = process.env.AGENT_MESSENGER_NAME;
    delete process.env.AGENT_MESSENGER_NAME;
    try {
      const cwd = '/no/hooks/project';
      const first = await store.resolveIdentity(cwd);
      assert.equal(first.name, deriveIdentityName(cwd));
      const second = await store.resolveIdentity(cwd);
      assert.equal(first.uuid, second.uuid);
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }
  });
});

test('inbox-hook resolves by session_id first, independent of cwd', async () => {
  await withStore(async (store, dir) => {
    const previousName = process.env.AGENT_MESSENGER_NAME;
    delete process.env.AGENT_MESSENGER_NAME;

    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-sid-'));
    try {
      const sessionId = crypto.randomUUID();
      runSessionHook(dir, {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'SessionStart',
        source: 'startup',
      });

      const sender = await store.registerAgent('Sender');
      await store.sendDirectMessage(sender.uuid, sessionId, 'unread by session');

      // A completely unrelated cwd — resolution must come from session_id alone.
      const blocked = runInboxHook(dir, {
        session_id: sessionId,
        cwd: '/totally/unrelated/place',
        stop_hook_active: false,
        hook_event_name: 'Stop',
      });
      const decision = JSON.parse(blocked.stdout);
      assert.equal(decision.decision, 'block');
      assert.ok(decision.reason.includes('1 unread'));

      // The hook never consumed the message.
      const inbox = await store.receive(sessionId, false);
      assert.equal(inbox?.directMessages.length, 1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      if (previousName === undefined) {
        delete process.env.AGENT_MESSENGER_NAME;
      } else {
        process.env.AGENT_MESSENGER_NAME = previousName;
      }
    }
  });
});

test('resolveParticipantRef resolves by unique uuid prefix and errors on ambiguous/too-short', async () => {
  await withStore(async (store) => {
    // Two participants with controlled uuids sharing a 6-char prefix.
    const p1 = await store.registerParticipant(
      'agent',
      'PrefixOne',
      'abcdef01-1111-1111-1111-111111111111'
    );
    const p2 = await store.registerParticipant(
      'agent',
      'PrefixTwo',
      'abcdef02-2222-2222-2222-222222222222'
    );
    assert.equal(p1.uuid, 'abcdef01-1111-1111-1111-111111111111');
    assert.equal(p2.uuid, 'abcdef02-2222-2222-2222-222222222222');

    // Unique 8-char prefix resolves.
    const unique = await store.resolveParticipantRef('abcdef01');
    assert.deepEqual(unique, { uuid: p1.uuid });

    // Ambiguous 6-char prefix (matches both) errors.
    const ambiguous = await store.resolveParticipantRef('abcdef');
    assert.ok('error' in ambiguous && ambiguous.error.includes('Ambiguous UUID prefix'));
    assert.ok('error' in ambiguous && ambiguous.error.includes(p1.uuid) && ambiguous.error.includes(p2.uuid));

    // Too-short prefix (matches exist but < 6 chars) errors clearly.
    const tooShort = await store.resolveParticipantRef('abc');
    assert.ok('error' in tooShort && tooShort.error.includes('too short'));

    // Names and full uuids still work.
    assert.deepEqual(await store.resolveParticipantRef('PrefixTwo'), { uuid: p2.uuid });
    assert.deepEqual(await store.resolveParticipantRef(p1.uuid), { uuid: p1.uuid });
  });
});

// ---------------------------------------------------------------------------
// Active wake mechanism (src/notify.ts).
// ---------------------------------------------------------------------------

// A fake wake adapter that appends its stdin JSON (one line) to OUT_FILE. Set as
// AGENT_MESSENGER_WAKE_CMD so a send that fires a wake lands a line in the file.
function writeFakeAdapter(dir: string): { script: string; out: string; cmd: string } {
  const script = path.join(dir, 'fake-adapter.mjs');
  const out = path.join(dir, 'wake-out.log');
  const body = `import fs from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { fs.appendFileSync(process.env.WAKE_OUT_FILE, raw.trim() + '\\n'); } catch {}
  process.exit(0);
});
`;
  writeFileSync(script, body);
  const cmd = `WAKE_OUT_FILE=${JSON.stringify(out)} ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  return { script, out, cmd };
}

function readWakeLines(out: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(out, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const WAKE_DELAY_MS = 200;

async function withWakeEnv<T>(cmd: string, run: () => Promise<T>): Promise<T> {
  const prevCmd = process.env.AGENT_MESSENGER_WAKE_CMD;
  const prevDelay = process.env.AGENT_MESSENGER_WAKE_DELAY_MS;
  if (cmd) {
    process.env.AGENT_MESSENGER_WAKE_CMD = cmd;
  } else {
    delete process.env.AGENT_MESSENGER_WAKE_CMD;
  }
  process.env.AGENT_MESSENGER_WAKE_DELAY_MS = String(WAKE_DELAY_MS);
  try {
    return await run();
  } finally {
    if (prevCmd === undefined) delete process.env.AGENT_MESSENGER_WAKE_CMD;
    else process.env.AGENT_MESSENGER_WAKE_CMD = prevCmd;
    if (prevDelay === undefined) delete process.env.AGENT_MESSENGER_WAKE_DELAY_MS;
    else process.env.AGENT_MESSENGER_WAKE_DELAY_MS = prevDelay;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('wake adapter fires once with the recipient session id after the delay', async () => {
  await withStore(async (store, dir) => {
    const { out, cmd } = writeFakeAdapter(dir);
    await withWakeEnv(cmd, async () => {
      // Register a session-backed recipient: uuid == session_id + a session record.
      const sessionId = crypto.randomUUID();
      runSessionHook(dir, {
        session_id: sessionId,
        cwd: dir,
        hook_event_name: 'SessionStart',
        source: 'startup',
      });
      const alice = await store.registerAgent('Alice');

      await store.sendDirectMessage(alice.uuid, sessionId, 'wake up');

      // Nothing before the delay.
      assert.equal(readWakeLines(out).length, 0);

      await sleep(WAKE_DELAY_MS + 400);
      const lines = readWakeLines(out);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].recipient_uuid, sessionId);
      assert.equal(lines[0].session_id, sessionId);
      assert.equal(lines[0].session_cwd, await realpathAsync(dir));
      assert.equal(lines[0].unread_count, 1);
      assert.deepEqual(lines[0].from_names, ['Alice']);
    });
  });
});

test('wake does not fire when the recipient reads within the delay', async () => {
  await withStore(async (store, dir) => {
    const { out, cmd } = writeFakeAdapter(dir);
    await withWakeEnv(cmd, async () => {
      const alice = await store.registerAgent('Alice');
      const bob = await store.registerAgent('Bob');

      await store.sendDirectMessage(alice.uuid, bob.uuid, 'quick');
      // Bob consumes his inbox before the debounce window elapses.
      await store.receive(bob.uuid, true);

      await sleep(WAKE_DELAY_MS + 400);
      assert.equal(readWakeLines(out).length, 0);
    });
  });
});

test('a burst of sends fires at most one wake per recipient', async () => {
  await withStore(async (store, dir) => {
    const { out, cmd } = writeFakeAdapter(dir);
    await withWakeEnv(cmd, async () => {
      const alice = await store.registerAgent('Alice');
      const bob = await store.registerAgent('Bob');

      await store.sendDirectMessage(alice.uuid, bob.uuid, 'one');
      await store.sendDirectMessage(alice.uuid, bob.uuid, 'two');
      await store.sendDirectMessage(alice.uuid, bob.uuid, 'three');

      await sleep(WAKE_DELAY_MS + 400);
      const lines = readWakeLines(out);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].unread_count, 3);
    });
  });
});

test('wake for a non-session recipient reports session_id null', async () => {
  await withStore(async (store, dir) => {
    const { out, cmd } = writeFakeAdapter(dir);
    await withWakeEnv(cmd, async () => {
      const alice = await store.registerAgent('Alice');
      const bob = await store.registerAgent('Bob'); // plain agent, no session record

      await store.sendDirectMessage(alice.uuid, bob.uuid, 'hi');

      await sleep(WAKE_DELAY_MS + 400);
      const lines = readWakeLines(out);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].recipient_uuid, bob.uuid);
      assert.equal(lines[0].session_id, null);
      assert.equal(lines[0].session_cwd, null);
    });
  });
});

test('a missing/crashing wake adapter never affects the send result', async () => {
  await withStore(async (store, dir) => {
    // A command that exits non-zero (crashes).
    const badCmd = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;
    await withWakeEnv(badCmd, async () => {
      const alice = await store.registerAgent('Alice');
      const bob = await store.registerAgent('Bob');

      const sent = await store.sendDirectMessage(alice.uuid, bob.uuid, 'still fine');
      assert.equal(sent.success, true);
      assert.ok(sent.messageId);

      // Give the (crashing) adapter time to run; the send already succeeded.
      await sleep(WAKE_DELAY_MS + 300);
      const inbox = await store.receive(bob.uuid, false);
      assert.equal(inbox?.directMessages.length, 1);
    });
  });
});

test('no wake configured does nothing and sends still succeed', async () => {
  await withStore(async (store, dir) => {
    // No AGENT_MESSENGER_WAKE_CMD, no config.json → no adapter.
    const { out } = writeFakeAdapter(dir);
    await withWakeEnv('', async () => {
      const alice = await store.registerAgent('Alice');
      const bob = await store.registerAgent('Bob');

      const sent = await store.sendDirectMessage(alice.uuid, bob.uuid, 'silent');
      assert.equal(sent.success, true);

      await sleep(WAKE_DELAY_MS + 300);
      assert.equal(readWakeLines(out).length, 0);
    });
  });
});

test('session-hook SessionEnd removes the session record but keeps the participant and messages', async () => {
  await withStore(async (store, dir) => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-messenger-end-'));
    try {
      const sessionId = crypto.randomUUID();
      runSessionHook(dir, {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'SessionStart',
        source: 'startup',
      });
      assert.ok(readSessions(dir)[sessionId], 'session present after start');

      // A durable message addressed to this session must survive the session end.
      const sender = await store.registerAgent('Sender');
      await store.sendDirectMessage(sender.uuid, sessionId, 'still deliverable');

      runSessionHook(dir, {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      });

      // Session record gone…
      assert.equal(readSessions(dir)[sessionId], undefined);

      // …but the participant and its unread message remain.
      const participant = await store.getParticipant(sessionId);
      assert.ok(participant);
      const inbox = await store.receive(sessionId, false);
      assert.equal(inbox?.directMessages.length, 1);
      assert.equal(inbox?.directMessages[0].content, 'still deliverable');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
