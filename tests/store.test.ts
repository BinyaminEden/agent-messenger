import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    const filePath = path.join(dir, 'data.json');
    const data = JSON.parse(await readFile(filePath, 'utf8')) as import('../src/store.js').StoreData;
    data.presence[first.uuid].lastSeen = 0;
    await writeFile(filePath, JSON.stringify(data, null, 2));

    const second = await store.registerAgent('Persistent Agent');
    assert.equal(second.uuid, first.uuid);
  });
});

test('direct messages survive offline recipients', async () => {
  await withStore(async (store, dir) => {
    const alice = await store.registerAgent('Alice');
    const bob = await store.registerAgent('Bob');
    await store.sendDirectMessage(alice.uuid, bob.uuid, 'offline ping');

    const filePath = path.join(dir, 'data.json');
    const data = JSON.parse(await readFile(filePath, 'utf8')) as import('../src/store.js').StoreData;
    data.presence[bob.uuid].lastSeen = 0;
    await writeFile(filePath, JSON.stringify(data, null, 2));

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
