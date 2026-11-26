import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'

// Install IndexedDB before importing so the module's default instance captures it.
const defaultIndexedDB = new IDBFactory()
const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
let sessionStorageModule

try {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: defaultIndexedDB,
  })
  sessionStorageModule = await import('../../frontend/src/lib/sessionStorage.js')
} finally {
  if (previousIndexedDB) {
    Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB)
  } else {
    delete globalThis.indexedDB
  }
}

const {
  validateSession,
  createSessionStorage,
  saveSession,
  listSessions,
  getSession,
} = sessionStorageModule

const INVALID =
  'Invalid workout summary. Your existing history has not been changed.'
const UNAVAILABLE =
  'Browser history is unavailable. Enable site storage and retry.'
const OPEN_FAILED =
  'Cannot open browser history. Close other ShadowBoxer tabs or enable site storage, then retry.'
const TRANSACTION_FAILED =
  'Browser history could not be saved or read. Check available storage and retry.'

function makeSession(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'session-1',
    startedAt: '2026-01-01T12:00:00.000Z',
    endedAt: '2026-01-01T12:03:00.000Z',
    roundDurationSeconds: 180,
    durationSeconds: 180,
    comboStats: { succeeded: 2, failed: 1, total: 3 },
    details: {
      speed: 'casual',
      punchCounts: { jab: 4, cross: 3, hook: 2, uppercut: 1 },
    },
    ...overrides,
  }
}

function makeStorage() {
  const indexedDB = new IDBFactory()
  const name = 'test-workouts'
  return {
    indexedDB,
    name,
    storage: createSessionStorage({ indexedDB, name }),
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

async function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function rawTransaction(indexedDB, name, mode, operation) {
  const db = await openDatabase(indexedDB, name)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode)
      const request = operation(tx.objectStore('sessions'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () => {
        reject(tx.error ?? new Error('Raw transaction failed'))
      }
    })
  } finally {
    db.close()
  }
}

test('validateSession accepts supported speeds and duration boundaries', () => {
  for (const speed of ['form', 'casual', 'intense']) {
    for (const durationSeconds of [0, 0.5, 179.999, 180]) {
      const session = makeSession({ durationSeconds })
      session.details.speed = speed
      assert.deepEqual(validateSession(session), session)
    }
  }
})

test('validateSession accepts zero counts and safe-integer boundaries', () => {
  for (const count of [0, Number.MAX_SAFE_INTEGER]) {
    const session = makeSession({
      comboStats: { succeeded: count, failed: 0, total: count },
    })
    session.details.punchCounts = {
      jab: count,
      cross: count,
      hook: count,
      uppercut: count,
    }
    assert.deepEqual(validateSession(session), session)
  }

  const session = makeSession({
    comboStats: {
      succeeded: 0,
      failed: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    },
  })
  assert.deepEqual(validateSession(session), session)
})

test('validateSession preserves valid IDs and date strings exactly', () => {
  const session = makeSession({
    id: '  preserved-id  ',
    startedAt: '2026-01-01T07:00:00-05:00',
    endedAt: '2026-01-01T07:03:00-05:00',
  })
  assert.deepEqual(validateSession(session), session)
})

test('validateSession strips extra data without mutating or aliasing its input', () => {
  const session = makeSession()
  session.recording = ['private recording']
  session.extra = { arbitrary: true }
  session.comboStats.extra = 99
  session.details.recording = ['private details']
  session.details.punchCounts.extra = 99

  const before = structuredClone(session)
  deepFreeze(session)

  const result = validateSession(session)
  assert.deepEqual(result, makeSession())
  assert.deepEqual(session, before)
  assert.notStrictEqual(result, session)
  assert.notStrictEqual(result.comboStats, session.comboStats)
  assert.notStrictEqual(result.details, session.details)
  assert.notStrictEqual(result.details.punchCounts, session.details.punchCounts)

  result.comboStats.succeeded = 100
  result.details.punchCounts.jab = 100
  assert.deepEqual(session, before)
})

test('validateSession rejects invalid top-level inputs', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'session', [], {}]) {
    assert.throws(() => validateSession(value), {
      name: 'Error',
      message: INVALID,
    })
  }
})

test('validateSession rejects missing required fields', () => {
  for (const key of Object.keys(makeSession())) {
    const session = makeSession()
    delete session[key]
    assert.throws(() => validateSession(session), { message: INVALID }, key)
  }

  for (const key of ['succeeded', 'failed', 'total']) {
    const session = makeSession()
    delete session.comboStats[key]
    assert.throws(() => validateSession(session), { message: INVALID }, key)
  }

  for (const key of ['speed', 'punchCounts']) {
    const session = makeSession()
    delete session.details[key]
    assert.throws(() => validateSession(session), { message: INVALID }, key)
  }

  for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
    const session = makeSession()
    delete session.details.punchCounts[key]
    assert.throws(() => validateSession(session), { message: INVALID }, key)
  }
})

test('validateSession rejects invalid scalar fields', () => {
  const cases = {
    schemaVersion: [undefined, null, 0, 2, '1', true],
    id: [undefined, null, '', ' \t\n ', 1, {}, new String('id')],
    startedAt: [undefined, null, '', 'invalid date', 0, new Date()],
    endedAt: [undefined, null, '', 'invalid date', 0, new Date()],
    roundDurationSeconds: [undefined, null, 0, 179, 181, '180', Infinity],
    durationSeconds: [
      undefined,
      null,
      -1,
      -0.001,
      180.001,
      181,
      NaN,
      Infinity,
      -Infinity,
      '180',
      true,
      {},
    ],
  }

  for (const [field, values] of Object.entries(cases)) {
    for (const value of values) {
      assert.throws(
        () => validateSession(makeSession({ [field]: value })),
        { message: INVALID },
        `${field}: ${String(value)}`,
      )
    }
  }
})

test('validateSession rejects invalid combo counts and inconsistent totals', () => {
  const invalidCounts = [
    undefined,
    null,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    true,
    1n,
  ]

  for (const key of ['succeeded', 'failed', 'total']) {
    for (const value of invalidCounts) {
      const session = makeSession()
      session.comboStats[key] = value
      assert.throws(() => validateSession(session), { message: INVALID })
    }
  }

  for (const comboStats of [
    null,
    {},
    { succeeded: 2, failed: 1, total: 2 },
    { succeeded: 2, failed: 1, total: 4 },
    {
      succeeded: Number.MAX_SAFE_INTEGER,
      failed: 1,
      total: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    assert.throws(() => validateSession(makeSession({ comboStats })), {
      message: INVALID,
    })
  }
})

test('validateSession rejects invalid details, speeds, and punch counts', () => {
  for (const details of [null, {}, { speed: 'casual', punchCounts: null }]) {
    assert.throws(() => validateSession(makeSession({ details })), {
      message: INVALID,
    })
  }

  for (const speed of [
    undefined,
    null,
    '',
    'CASUAL',
    'unknown',
    'toString',
    '__proto__',
    1,
    new String('casual'),
  ]) {
    const session = makeSession()
    session.details.speed = speed
    assert.throws(() => validateSession(session), { message: INVALID })
  }

  for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
    for (const value of [
      undefined,
      null,
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      true,
      1n,
    ]) {
      const session = makeSession()
      session.details.punchCounts[key] = value
      assert.throws(() => validateSession(session), { message: INVALID })
    }
  }
})

test('new storage returns an empty list and null for missing IDs', async () => {
  const { storage } = makeStorage()
  assert.deepEqual(await storage.listSessions(), [])
  assert.equal(await storage.getSession('missing'), null)
})

test('saveSession persists only sanitized data and returns independent objects', async () => {
  const { indexedDB, name, storage } = makeStorage()
  const session = makeSession()
  session.recording = ['secret']
  session.comboStats.extra = 'secret'
  session.details.extra = 'secret'
  session.details.punchCounts.extra = 100
  const before = structuredClone(session)
  const expected = makeSession()

  const saved = await storage.saveSession(session)
  assert.deepEqual(saved, expected)
  assert.deepEqual(session, before)

  const raw = await rawTransaction(indexedDB, name, 'readonly', (store) =>
    store.get(session.id),
  )
  assert.deepEqual(raw, expected)

  session.details.punchCounts.jab = 999
  saved.comboStats.succeeded = 999
  saved.details.punchCounts.cross = 999

  const fetched = await storage.getSession(expected.id)
  assert.deepEqual(fetched, expected)
  fetched.details.punchCounts.hook = 999

  const listed = await storage.listSessions()
  assert.deepEqual(listed, [expected])
  listed[0].details.punchCounts.uppercut = 999

  assert.deepEqual(await storage.getSession(expected.id), expected)
})

test('saving an existing ID preserves the first completion', async () => {
  const { indexedDB, name, storage } = makeStorage()
  const first = makeSession()
  const replacement = makeSession({
    durationSeconds: 20,
    endedAt: '2026-02-01T12:03:00.000Z',
  })
  replacement.details.speed = 'intense'

  assert.deepEqual(await storage.saveSession(first), first)
  assert.deepEqual(await storage.saveSession(first), first)
  assert.deepEqual(await storage.saveSession(replacement), first)

  const secondClient = createSessionStorage({ indexedDB, name })
  assert.deepEqual(await secondClient.saveSession(replacement), first)
  assert.deepEqual(await secondClient.getSession(first.id), first)
  assert.deepEqual(await secondClient.listSessions(), [first])
})

test('concurrent retries across clients preserve one winning summary', async () => {
  const { indexedDB, name, storage } = makeStorage()
  const other = createSessionStorage({ indexedDB, name })
  const candidates = Array.from({ length: 8 }, (_, index) =>
    makeSession({ durationSeconds: index + 1 }),
  )

  const results = await Promise.all(
    candidates.map((session, index) =>
      (index % 2 ? storage : other).saveSession(session),
    ),
  )

  const winner = await storage.getSession('session-1')
  assert.ok(
    candidates.some(
      (candidate) => candidate.durationSeconds === winner.durationSeconds,
    ),
  )
  for (const result of results) {
    assert.deepEqual(result, winner)
  }
  assert.deepEqual(await other.listSessions(), [winner])
})

test('listSessions sorts by parsed end time, newest first', async () => {
  const { storage } = makeStorage()
  const oldest = makeSession({
    id: 'z-oldest',
    endedAt: '2026-01-01T10:00:00Z',
  })
  const middle = makeSession({
    id: 'a-middle',
    endedAt: '2026-01-01T08:00:00-04:00',
  })
  const newest = makeSession({
    id: 'm-newest',
    endedAt: '2026-01-01T13:00:00Z',
  })

  for (const session of [middle, oldest, newest]) {
    await storage.saveSession(session)
  }

  assert.deepEqual(await storage.listSessions(), [newest, middle, oldest])
  assert.deepEqual(await storage.getSession(middle.id), middle)
  assert.equal(await storage.getSession('absent'), null)
})

test('different database names isolate histories', async () => {
  const indexedDB = new IDBFactory()
  const first = createSessionStorage({ indexedDB, name: 'first' })
  const second = createSessionStorage({ indexedDB, name: 'second' })
  const a = makeSession({ durationSeconds: 10 })
  const b = makeSession({ durationSeconds: 20 })

  await first.saveSession(a)
  assert.deepEqual(await second.listSessions(), [])
  await second.saveSession(b)

  assert.deepEqual(await first.listSessions(), [a])
  assert.deepEqual(await second.listSessions(), [b])
})

test('invalid saves reject without changing existing history', async () => {
  const { storage } = makeStorage()
  const original = makeSession()
  await storage.saveSession(original)

  for (const id of [original.id, 'new-invalid-id']) {
    await assert.rejects(
      storage.saveSession(makeSession({ id, durationSeconds: -1 })),
      { message: INVALID },
    )
    assert.deepEqual(await storage.listSessions(), [original])
  }
  assert.equal(await storage.getSession('new-invalid-id'), null)
})

test('invalid saves are rejected before opening IndexedDB', async () => {
  let opens = 0
  const storage = createSessionStorage({
    indexedDB: {
      open() {
        opens += 1
        throw new Error('Must not open')
      },
    },
  })

  await assert.rejects(storage.saveSession(makeSession({ id: '' })), {
    message: INVALID,
  })
  assert.equal(opens, 0)
})

test('read operations and duplicate saves sanitize existing records', async () => {
  const { indexedDB, name, storage } = makeStorage()
  const raw = makeSession()
  raw.recording = ['secret']
  raw.comboStats.extra = 99
  raw.details.extra = 'secret'
  raw.details.punchCounts.extra = 99

  await rawTransaction(indexedDB, name, 'readwrite', (store) => store.put(raw))

  const expected = makeSession()
  assert.deepEqual(await storage.getSession(raw.id), expected)
  assert.deepEqual(await storage.listSessions(), [expected])
  assert.deepEqual(
    await storage.saveSession(makeSession({ durationSeconds: 1 })),
    expected,
  )
})

test('corrupt stored records reject without being overwritten', async () => {
  const { indexedDB, name, storage } = makeStorage()
  const corrupt = makeSession({ durationSeconds: -1 })
  await rawTransaction(indexedDB, name, 'readwrite', (store) =>
    store.put(corrupt),
  )

  await assert.rejects(storage.getSession(corrupt.id), { message: INVALID })
  await assert.rejects(storage.listSessions(), { message: INVALID })
  await assert.rejects(storage.saveSession(makeSession()), { message: INVALID })
  assert.equal(await storage.getSession('missing'), null)

  assert.deepEqual(
    await rawTransaction(indexedDB, name, 'readonly', (store) =>
      store.get(corrupt.id),
    ),
    corrupt,
  )
})

test('all operations report unavailable IndexedDB', async () => {
  const storage = createSessionStorage({ indexedDB: null })
  await assert.rejects(storage.saveSession(makeSession()), {
    message: UNAVAILABLE,
  })
  await assert.rejects(storage.listSessions(), { message: UNAVAILABLE })
  await assert.rejects(storage.getSession('id'), { message: UNAVAILABLE })
})

test('open errors and blocked opens reject; late connections are closed', async () => {
  for (const eventName of ['onerror', 'onblocked']) {
    let closed = 0
    let transactions = 0
    const calls = []
    const storage = createSessionStorage({
      name: 'blocked-test',
      indexedDB: {
        open(...args) {
          calls.push(args)
          const request = {
            result: {
              close() {
                closed += 1
              },
              transaction() {
                transactions += 1
                throw new Error('Abandoned connection must not be used')
              },
            },
          }
          queueMicrotask(() => {
            request[eventName]()
            request.onsuccess()
          })
          return request
        },
      },
    })

    await assert.rejects(storage.listSessions(), { message: OPEN_FAILED })
    assert.deepEqual(calls, [['blocked-test', 1]])
    assert.equal(closed, 1)
    assert.equal(transactions, 0)
  }
})

function controlledStorage() {
  const state = { closes: 0, mode: null, request: null, tx: null, db: null }
  let signalReady
  const ready = new Promise((resolve) => {
    signalReady = resolve
  })

  const store = {
    get() {
      state.request = {}
      signalReady()
      return state.request
    },
    getAll() {
      state.request = {}
      signalReady()
      return state.request
    },
  }

  state.db = {
    close() {
      state.closes += 1
    },
    transaction(storeName, mode) {
      assert.equal(storeName, 'sessions')
      state.mode = mode
      state.tx = {
        objectStore(name) {
          assert.equal(name, 'sessions')
          return store
        },
      }
      return state.tx
    },
  }

  const storage = createSessionStorage({
    indexedDB: {
      open() {
        const request = { result: state.db }
        queueMicrotask(() => request.onsuccess())
        return request
      },
    },
  })

  return { storage, state, ready }
}

test('operations reject transaction errors and aborts and close connections', async () => {
  for (const eventName of ['onerror', 'onabort']) {
    for (const method of ['saveSession', 'listSessions', 'getSession']) {
      const { storage, state, ready } = controlledStorage()
      const argument = method === 'saveSession' ? makeSession() : 'session-1'
      const pending = storage[method](argument)
      const rejection = assert.rejects(pending, {
        message: TRANSACTION_FAILED,
      })

      await ready
      assert.equal(state.mode, method === 'saveSession' ? 'readwrite' : 'readonly')
      state.tx[eventName]()
      await rejection
      assert.equal(state.closes, 1)
    }
  }
})

test('request success waits for transaction completion before resolving', async () => {
  const { storage, state, ready } = controlledStorage()
  let settled = false
  const pending = storage.listSessions().then((result) => {
    settled = true
    return result
  })

  await ready
  state.request.onsuccess({ target: { result: [makeSession()] } })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(state.closes, 0)

  state.tx.oncomplete()
  assert.deepEqual(await pending, [makeSession()])
  assert.equal(state.closes, 1)
})

test('a transaction abort after request success still rejects', async () => {
  const { storage, state, ready } = controlledStorage()
  const pending = storage.getSession('session-1')
  const rejection = assert.rejects(pending, { message: TRANSACTION_FAILED })

  await ready
  state.request.onsuccess({ target: { result: makeSession() } })
  state.tx.onabort()

  await rejection
  assert.equal(state.closes, 1)
})

test('open connections close when a version change is requested', async () => {
  const { storage, state, ready } = controlledStorage()
  const pending = storage.listSessions()

  await ready
  assert.equal(typeof state.db.onversionchange, 'function')
  state.db.onversionchange()
  assert.equal(state.closes, 1)

  state.request.onsuccess({ target: { result: [] } })
  state.tx.oncomplete()
  assert.deepEqual(await pending, [])
})

test('module-level exports share the default database', async () => {
  assert.deepEqual(await listSessions(), [])
  assert.equal(await getSession('missing-default'), null)

  const session = makeSession({ id: 'default-session' })
  assert.deepEqual(await saveSession(session), session)
  assert.deepEqual(await getSession(session.id), session)
  assert.deepEqual(await listSessions(), [session])

  const client = createSessionStorage({
    indexedDB: defaultIndexedDB,
    name: 'shadowboxer-workouts',
  })
  assert.deepEqual(await client.getSession(session.id), session)

  await assert.rejects(saveSession(makeSession({ id: '' })), {
    message: INVALID,
  })
  assert.deepEqual(await listSessions(), [session])
})
