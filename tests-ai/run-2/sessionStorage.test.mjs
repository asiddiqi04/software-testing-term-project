import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

// The module's default storage captures IndexedDB when it is imported.
const defaultIndexedDB = new IDBFactory();
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

let sessionStorage;
try {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: defaultIndexedDB,
  });
  sessionStorage = await import('../../frontend/src/lib/sessionStorage.js');
} finally {
  if (originalIndexedDB) {
    Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  } else {
    delete globalThis.indexedDB;
  }
}

const {
  validateSession,
  createSessionStorage,
  saveSession,
  listSessions,
  getSession,
} = sessionStorage;

const INVALID =
  'Invalid workout summary. Your existing history has not been changed.';
const UNAVAILABLE =
  'Browser history is unavailable. Enable site storage and retry.';
const OPEN_FAILED =
  'Cannot open browser history. Close other ShadowBoxer tabs or enable site storage, then retry.';
const TRANSACTION_FAILED =
  'Browser history could not be saved or read. Check available storage and retry.';

function summary(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'workout-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:03:00.000Z',
    roundDurationSeconds: 180,
    durationSeconds: 180,
    comboStats: {
      succeeded: 8,
      failed: 2,
      total: 10,
    },
    details: {
      speed: 'casual',
      punchCounts: {
        jab: 12,
        cross: 10,
        hook: 6,
        uppercut: 4,
      },
    },
    ...overrides,
  };
}

function setup(name = 'test-workouts') {
  const indexedDB = new IDBFactory();
  return {
    indexedDB,
    name,
    storage: createSessionStorage({ indexedDB, name }),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function rawPut(indexedDB, name, value) {
  const db = await openDatabase(indexedDB, name);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
      tx.objectStore('sessions').put(value);
    });
  } finally {
    db.close();
  }
}

test('validateSession returns a fresh summary without mutating its input', () => {
  const input = deepFreeze(summary());
  const result = validateSession(input);

  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.comboStats, input.comboStats);
  assert.notStrictEqual(result.details, input.details);
  assert.notStrictEqual(result.details.punchCounts, input.details.punchCounts);

  result.comboStats.succeeded = 99;
  result.details.speed = 'intense';
  result.details.punchCounts.jab = 99;

  assert.equal(input.comboStats.succeeded, 8);
  assert.equal(input.details.speed, 'casual');
  assert.equal(input.details.punchCounts.jab, 12);
});

test('validateSession removes unversioned fields at every object level', () => {
  const input = summary({
    recording: new Uint8Array([1, 2, 3]),
    arbitrary: { private: true },
  });
  input.comboStats.extra = 42;
  input.details.recording = ['frame'];
  input.details.arbitrary = true;
  input.details.punchCounts.kick = 100;

  const before = structuredClone(input);
  assert.deepEqual(validateSession(input), summary());
  assert.deepEqual(input, before);
});

test('validateSession accepts supported speeds and duration boundaries', () => {
  for (const speed of ['form', 'casual', 'intense']) {
    for (const durationSeconds of [0, 0.5, 179.999, 180]) {
      const input = summary({ durationSeconds });
      input.details.speed = speed;
      assert.deepEqual(validateSession(input), input);
    }
  }
});

test('validateSession accepts zero counts and safe integer limits', () => {
  const zero = summary({
    comboStats: { succeeded: 0, failed: 0, total: 0 },
  });
  zero.details.punchCounts = { jab: 0, cross: 0, hook: 0, uppercut: 0 };
  assert.deepEqual(validateSession(zero), zero);

  const maximum = summary({
    comboStats: {
      succeeded: Number.MAX_SAFE_INTEGER,
      failed: 0,
      total: Number.MAX_SAFE_INTEGER,
    },
  });
  for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
    maximum.details.punchCounts[key] = Number.MAX_SAFE_INTEGER;
  }
  assert.deepEqual(validateSession(maximum), maximum);
});

test('validateSession preserves valid IDs and date strings as supplied', () => {
  const input = summary({
    id: '  workout with spaces  ',
    startedAt: '2026-01-01T05:00:00-05:00',
    endedAt: '2026-01-01T05:03:00-05:00',
  });
  assert.deepEqual(validateSession(input), input);
});

test('validateSession rejects missing and non-session inputs', () => {
  for (const input of [undefined, null, false, true, 0, 42, '', 'session', {}, []]) {
    assert.throws(() => validateSession(input), {
      name: 'Error',
      message: INVALID,
    });
  }
});

const invalidFields = [
  ['schemaVersion', [undefined, null, 0, 2, '1', true]],
  ['id', [undefined, null, 1, true, '', ' ', '\t\n', new String('id')]],
  ['startedAt', [undefined, null, 0, new Date(), '', 'not-a-date']],
  ['endedAt', [undefined, null, 0, new Date(), '', 'not-a-date']],
  ['roundDurationSeconds', [undefined, null, 0, 179, 181, '180', NaN, Infinity]],
  [
    'durationSeconds',
    [undefined, null, -1, -0.001, 180.001, 181, '180', true, NaN, Infinity, -Infinity],
  ],
];

for (const [field, values] of invalidFields) {
  test(`validateSession rejects invalid ${field}`, () => {
    for (const value of values) {
      assert.throws(() => validateSession(summary({ [field]: value })), {
        name: 'Error',
        message: INVALID,
      });
    }

    const missing = summary();
    delete missing[field];
    assert.throws(() => validateSession(missing), { message: INVALID });
  });
}

const invalidCounts = [
  undefined,
  null,
  -1,
  0.5,
  '1',
  true,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
];

for (const key of ['succeeded', 'failed', 'total']) {
  test(`validateSession rejects invalid comboStats.${key}`, () => {
    for (const value of invalidCounts) {
      const input = summary({
        comboStats: { succeeded: 0, failed: 0, total: 0 },
      });

      // Keep the arithmetic consistent where possible so integer validation
      // is exercised independently of the total-equality check.
      input.comboStats[key] = value;
      if (key === 'total') input.comboStats.succeeded = value;
      else input.comboStats.total = value;

      assert.throws(() => validateSession(input), { message: INVALID });
    }

    const missing = summary();
    delete missing.comboStats[key];
    assert.throws(() => validateSession(missing), { message: INVALID });
  });
}

for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
  test(`validateSession rejects invalid details.punchCounts.${key}`, () => {
    for (const value of invalidCounts) {
      const input = summary();
      input.details.punchCounts[key] = value;
      assert.throws(() => validateSession(input), { message: INVALID });
    }

    const missing = summary();
    delete missing.details.punchCounts[key];
    assert.throws(() => validateSession(missing), { message: INVALID });
  });
}

test('validateSession rejects missing nested objects and invalid speeds', () => {
  for (const value of [undefined, null, {}, [], 'invalid']) {
    assert.throws(
      () => validateSession(summary({ comboStats: value })),
      { message: INVALID },
    );
    assert.throws(
      () => validateSession(summary({ details: value })),
      { message: INVALID },
    );

    const input = summary();
    input.details.punchCounts = value;
    assert.throws(() => validateSession(input), { message: INVALID });
  }

  for (const speed of [
    undefined, null, '', 'fast', 'Casual', ' casual ', 'toString',
    'constructor', '__proto__', 1, true, new String('casual'),
  ]) {
    const input = summary();
    input.details.speed = speed;
    assert.throws(() => validateSession(input), { message: INVALID });
  }
});

test('validateSession requires total to equal succeeded plus failed', () => {
  for (const total of [0, 9, 11]) {
    assert.throws(
      () => validateSession(summary({
        comboStats: { succeeded: 8, failed: 2, total },
      })),
      { message: INVALID },
    );
  }

  assert.throws(
    () => validateSession(summary({
      comboStats: {
        succeeded: Number.MAX_SAFE_INTEGER,
        failed: 1,
        total: Number.MAX_SAFE_INTEGER + 1,
      },
    })),
    { message: INVALID },
  );
});

test('new storage lists no sessions and returns null for unknown IDs', async () => {
  const { storage } = setup();
  assert.deepEqual(await storage.listSessions(), []);
  assert.equal(await storage.getSession('missing'), null);
});

test('saveSession persists only the sanitized summary', async () => {
  const { storage, indexedDB, name } = setup();
  const input = summary({ recording: ['private-frame'], extra: true });
  input.comboStats.extra = true;
  input.details.recording = ['private-frame'];
  input.details.punchCounts.kick = 3;

  const before = structuredClone(input);
  assert.deepEqual(await storage.saveSession(input), summary());
  assert.deepEqual(input, before);
  assert.deepEqual(await storage.getSession(input.id), summary());
  assert.deepEqual(await storage.listSessions(), [summary()]);

  const db = await openDatabase(indexedDB, name);
  try {
    assert.equal(db.version, 1);
    assert.deepEqual(Array.from(db.objectStoreNames), ['sessions']);

    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      assert.equal(store.keyPath, 'id');
      const request = store.get(input.id);
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    assert.deepEqual(stored, summary());
  } finally {
    db.close();
  }
});

test('saveSession keeps the first saved value for an existing ID', async () => {
  const { storage } = setup();
  const first = summary();
  const retry = summary({
    durationSeconds: 42,
    endedAt: '2026-02-01T10:03:00.000Z',
  });
  retry.details.speed = 'intense';

  assert.deepEqual(await storage.saveSession(first), first);
  assert.deepEqual(await storage.saveSession(retry), first);
  assert.deepEqual(await storage.getSession(first.id), first);
  assert.deepEqual(await storage.listSessions(), [first]);
});

test('concurrent saves across instances preserve one complete winning summary', async () => {
  const { indexedDB, name, storage } = setup();
  const other = createSessionStorage({ indexedDB, name });
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const value = summary({ durationSeconds: index + 1 });
    value.details.punchCounts.jab = index;
    return value;
  });

  const results = await Promise.all(
    candidates.map((value, index) =>
      (index % 2 ? other : storage).saveSession(value)),
  );

  const winner = results[0];
  assert.ok(candidates.some((candidate) =>
    candidate.durationSeconds === winner.durationSeconds &&
    candidate.details.punchCounts.jab === winner.details.punchCounts.jab,
  ));
  for (const result of results) assert.deepEqual(result, winner);
  assert.deepEqual(await storage.listSessions(), [winner]);
  assert.deepEqual(await other.getSession(winner.id), winner);
});

test('listSessions sorts by parsed endedAt descending, including timezone offsets', async () => {
  const { storage } = setup();
  const oldest = summary({
    id: 'z-oldest',
    endedAt: '2026-01-01T10:00:00Z',
  });
  const newest = summary({
    id: 'a-newest',
    endedAt: '2026-01-01T08:00:00-05:00',
  });
  const middle = summary({
    id: 'm-middle',
    endedAt: '2026-01-01T12:00:00Z',
  });

  for (const value of [middle, newest, oldest]) {
    await storage.saveSession(value);
  }

  assert.deepEqual(await storage.listSessions(), [newest, middle, oldest]);
});

test('instances share a database name and isolate different database names', async () => {
  const indexedDB = new IDBFactory();
  const first = createSessionStorage({ indexedDB, name: 'shared' });
  const second = createSessionStorage({ indexedDB, name: 'shared' });
  const isolated = createSessionStorage({ indexedDB, name: 'isolated' });
  const value = summary();

  await first.saveSession(value);
  assert.deepEqual(await second.getSession(value.id), value);
  assert.deepEqual(await second.listSessions(), [value]);
  assert.equal(await isolated.getSession(value.id), null);
  assert.deepEqual(await isolated.listSessions(), []);
});

test('mutating inputs and returned summaries does not change persisted data', async () => {
  const { storage } = setup();
  const input = summary();
  const expected = structuredClone(input);
  const saved = await storage.saveSession(input);

  input.comboStats.succeeded = 100;
  input.details.punchCounts.jab = 100;
  saved.details.speed = 'form';
  saved.details.punchCounts.cross = 100;

  const fetched = await storage.getSession(expected.id);
  assert.deepEqual(fetched, expected);
  fetched.comboStats.total = 999;

  const listed = await storage.listSessions();
  assert.deepEqual(listed, [expected]);
  listed[0].details.punchCounts.hook = 999;
  listed.push(summary({ id: 'not-persisted' }));

  assert.deepEqual(await storage.getSession(expected.id), expected);
  assert.deepEqual(await storage.listSessions(), [expected]);
});

test('invalid saves reject before opening IndexedDB', async () => {
  let opens = 0;
  const storage = createSessionStorage({
    indexedDB: {
      open() {
        opens += 1;
        throw new Error('Validation should run before opening storage');
      },
    },
  });

  await assert.rejects(storage.saveSession(summary({ durationSeconds: -1 })), {
    message: INVALID,
  });
  assert.equal(opens, 0);
});

test('invalid new sessions and retries leave existing history unchanged', async () => {
  const { storage } = setup();
  const existing = summary();
  await storage.saveSession(existing);

  for (const id of [existing.id, 'new-invalid-session']) {
    await assert.rejects(
      storage.saveSession(summary({ id, durationSeconds: 181 })),
      { message: INVALID },
    );
  }

  assert.deepEqual(await storage.listSessions(), [existing]);
});

test('stored extra fields are sanitized on reads and duplicate saves', async () => {
  const { storage, indexedDB, name } = setup();
  const stored = summary({ recording: ['legacy-recording'] });
  stored.comboStats.extra = true;
  stored.details.extra = true;
  stored.details.punchCounts.kick = 9;
  await rawPut(indexedDB, name, stored);

  assert.deepEqual(await storage.getSession(stored.id), summary());
  assert.deepEqual(await storage.listSessions(), [summary()]);
  assert.deepEqual(
    await storage.saveSession(summary({ durationSeconds: 5 })),
    summary(),
  );
});

test('corrupt stored summaries reject reads and duplicate saves', async () => {
  const { storage, indexedDB, name } = setup();
  const good = summary({ id: 'good' });
  await storage.saveSession(good);
  await rawPut(indexedDB, name, summary({ id: 'corrupt', schemaVersion: 2 }));

  await assert.rejects(storage.getSession('corrupt'), { message: INVALID });
  await assert.rejects(storage.listSessions(), { message: INVALID });
  await assert.rejects(
    storage.saveSession(summary({ id: 'corrupt' })),
    { message: INVALID },
  );
  assert.deepEqual(await storage.getSession('good'), good);
});

const operations = [
  ['saveSession', (storage) => storage.saveSession(summary())],
  ['listSessions', (storage) => storage.listSessions()],
  ['getSession', (storage) => storage.getSession('workout-1')],
];

for (const [method, invoke] of operations) {
  test(`${method} reports unavailable IndexedDB`, async () => {
    await assert.rejects(invoke(createSessionStorage({ indexedDB: null })), {
      name: 'Error',
      message: UNAVAILABLE,
    });
  });

  for (const event of ['onerror', 'onblocked']) {
    test(`${method} reports an IndexedDB open ${event}`, async () => {
      const indexedDB = {
        open() {
          const request = {};
          queueMicrotask(() => request[event]());
          return request;
        },
      };

      await assert.rejects(invoke(createSessionStorage({ indexedDB })), {
        name: 'Error',
        message: OPEN_FAILED,
      });
    });
  }

  for (const event of ['onabort', 'onerror']) {
    test(`${method} closes its database and rejects on transaction ${event}`, async () => {
      let closes = 0;
      const observedModes = [];
      const db = {
        close() { closes += 1; },
        transaction(storeName, mode) {
          assert.equal(storeName, 'sessions');
          observedModes.push(mode);
          const tx = {
            objectStore(name) {
              assert.equal(name, 'sessions');
              return {
                get() { return {}; },
                getAll() { return {}; },
              };
            },
          };
          queueMicrotask(() => tx[event]());
          return tx;
        },
      };
      const indexedDB = {
        open() {
          const request = { result: db };
          queueMicrotask(() => request.onsuccess());
          return request;
        },
      };

      await assert.rejects(invoke(createSessionStorage({ indexedDB })), {
        name: 'Error',
        message: TRANSACTION_FAILED,
      });
      assert.deepEqual(observedModes, [
        method === 'saveSession' ? 'readwrite' : 'readonly',
      ]);
      assert.equal(closes, 1);
    });
  }
}

for (const event of ['onblocked', 'onerror']) {
  test(`a late open success after ${event} closes the abandoned connection`, async () => {
    let closes = 0;
    let transactions = 0;
    const indexedDB = {
      open() {
        const request = {
          result: {
            close() { closes += 1; },
            transaction() { transactions += 1; },
          },
        };
        queueMicrotask(() => {
          request[event]();
          request.onsuccess();
        });
        return request;
      },
    };

    await assert.rejects(
      createSessionStorage({ indexedDB }).listSessions(),
      { message: OPEN_FAILED },
    );
    assert.equal(closes, 1);
    assert.equal(transactions, 0);
  });
}

test('operations resolve only when their transaction completes and close the connection', async () => {
  let request;
  let tx;
  let closes = 0;
  const db = {
    close() { closes += 1; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'sessions');
      assert.equal(mode, 'readonly');
      tx = {
        objectStore(name) {
          assert.equal(name, 'sessions');
          return {
            getAll() {
              request = {};
              return request;
            },
          };
        },
      };
      return tx;
    },
  };
  const indexedDB = {
    open() {
      const opening = { result: db };
      queueMicrotask(() => opening.onsuccess());
      return opening;
    },
  };

  let settled = false;
  const pending = createSessionStorage({ indexedDB }).listSessions();
  pending.then(() => { settled = true; });

  // Let the open promise resolve and the transaction start.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(request);
  request.onsuccess({ target: { result: [summary()] } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(closes, 0);
  assert.equal(typeof db.onversionchange, 'function');

  tx.oncomplete();
  assert.deepEqual(await pending, [summary()]);
  assert.equal(closes, 1);

  db.onversionchange();
  assert.equal(closes, 2);
});

test('default exported functions use the captured global IndexedDB and default database name', async () => {
  const value = summary({ id: 'default-export-session' });

  assert.deepEqual(await listSessions(), []);
  assert.equal(await getSession('missing'), null);
  assert.deepEqual(await saveSession(value), value);
  assert.deepEqual(await getSession(value.id), value);
  assert.deepEqual(await listSessions(), [value]);

  const sameDatabase = createSessionStorage({
    indexedDB: defaultIndexedDB,
    name: 'shadowboxer-workouts',
  });
  assert.deepEqual(await sameDatabase.listSessions(), [value]);
});
