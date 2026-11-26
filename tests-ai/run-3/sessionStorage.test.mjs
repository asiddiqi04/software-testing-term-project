import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'

// The module's convenience exports capture IndexedDB during initialization.
const defaultIndexedDB = new IDBFactory()
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
let sessionStorageModule

try {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: defaultIndexedDB,
  })
  sessionStorageModule = await import('../../frontend/src/lib/sessionStorage.js')
} finally {
  if (originalIndexedDB) {
    Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
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

function session(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'workout-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:03:00.000Z',
    roundDurationSeconds: 180,
    durationSeconds: 180,
    comboStats: { succeeded: 3, failed: 2, total: 5 },
    details: {
      speed: 'casual',
      punchCounts: { jab: 8, cross: 6, hook: 4, uppercut: 2 },
    },
    ...overrides,
  }
}

function fixture() {
  const indexedDB = new IDBFactory()
  const name = 'session-storage-test'
  return {
    indexedDB,
    name,
    storage: createSessionStorage({ indexedDB, name }),
  }
}

function openRaw(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

async function rawTransaction(indexedDB, name, mode, operation) {
  const db = await openRaw(indexedDB, name)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode)
      let result
      tx.oncomplete = () => resolve(result)
      tx.onabort = tx.onerror = () => reject(tx.error)
      operation(tx.objectStore('sessions'), (value) => {
        result = value
      })
    })
  } finally {
    db.close()
  }
}

function seed(indexedDB, name, value) {
  return rawTransaction(indexedDB, name, 'readwrite', (store) => {
    store.put(value)
  })
}

function readRaw(indexedDB, name, id) {
  return rawTransaction(indexedDB, name, 'readonly', (store, done) => {
    store.get(id).onsuccess = (event) => done(event.target.result)
  })
}

function controlledBackend() {
  const openRequest = {}
  const dataRequest = {}
  const calls = []
  let closes = 0

  const store = {
    get(id) {
      calls.push(['get', id])
      return dataRequest
    },
    getAll() {
      calls.push(['getAll'])
      return dataRequest
    },
    add(value) {
      calls.push(['add', value])
      return {}
    },
  }
  const tx = {
    objectStore(name) {
      calls.push(['objectStore', name])
      return store
    },
  }
  const db = {
    transaction(name, mode) {
      calls.push(['transaction', name, mode])
      return tx
    },
    close() {
      closes += 1
    },
  }
  openRequest.result = db

  const indexedDB = {
    open(name, version) {
      calls.push(['open', name, version])
      return openRequest
    },
  }

  return {
    storage: createSessionStorage({ indexedDB, name: 'controlled-history' }),
    openRequest,
    dataRequest,
    tx,
    db,
    calls,
    get closes() {
      return closes
    },
  }
}

test('validateSession accepts supported speeds and duration boundaries', () => {
  for (const speed of ['form', 'casual', 'intense']) {
    for (const durationSeconds of [0, 0.25, 179.999, 180]) {
      const value = session({ durationSeconds })
      value.details.speed = speed
      assert.deepEqual(validateSession(value), value)
    }
  }

  const zero = session({
    comboStats: { succeeded: 0, failed: 0, total: 0 },
    details: {
      speed: 'form',
      punchCounts: { jab: 0, cross: 0, hook: 0, uppercut: 0 },
    },
  })
  assert.deepEqual(validateSession(zero), zero)

  const maximum = session({
    comboStats: {
      succeeded: Number.MAX_SAFE_INTEGER,
      failed: 0,
      total: Number.MAX_SAFE_INTEGER,
    },
    details: {
      speed: 'intense',
      punchCounts: Object.fromEntries(
        ['jab', 'cross', 'hook', 'uppercut'].map((key) => [
          key,
          Number.MAX_SAFE_INTEGER,
        ]),
      ),
    },
  })
  assert.deepEqual(validateSession(maximum), maximum)
})

test('validateSession preserves valid strings without normalizing them', () => {
  const value = session({
    id: '  workout-id  ',
    startedAt: '2026-01-01T05:00:00-05:00',
    endedAt: '2026-01-01T05:03:00-05:00',
  })
  assert.deepEqual(validateSession(value), value)
})

test('validateSession strips unknown fields and returns independent objects', () => {
  const value = session()
  value.recording = new Uint8Array([1, 2, 3])
  value.arbitrary = { private: true }
  value.comboStats.extra = 99
  value.details.recording = ['frame']
  value.details.punchCounts.kick = 10
  const before = structuredClone(value)

  const result = validateSession(value)

  assert.deepEqual(result, session())
  assert.deepEqual(value, before)
  assert.notStrictEqual(result, value)
  assert.notStrictEqual(result.comboStats, value.comboStats)
  assert.notStrictEqual(result.details, value.details)
  assert.notStrictEqual(result.details.punchCounts, value.details.punchCounts)

  result.comboStats.succeeded = 999
  result.details.punchCounts.jab = 999
  assert.equal(value.comboStats.succeeded, 3)
  assert.equal(value.details.punchCounts.jab, 8)
})

test('validateSession rejects missing, malformed, and inconsistent fields', () => {
  const invalidValues = [undefined, null, false, 0, '', 'session', [], {}]

  for (const schemaVersion of [undefined, null, '1', 0, 2]) {
    invalidValues.push(session({ schemaVersion }))
  }
  for (const id of [undefined, null, 1, {}, '', ' \t\n ']) {
    invalidValues.push(session({ id }))
  }
  for (const key of ['startedAt', 'endedAt']) {
    for (const value of [
      undefined,
      null,
      '',
      'not-a-date',
      '2026-99-99T00:00:00Z',
      0,
      new Date('2026-01-01'),
    ]) {
      invalidValues.push(session({ [key]: value }))
    }
  }
  for (const roundDurationSeconds of [undefined, null, '180', 0, 179, 181]) {
    invalidValues.push(session({ roundDurationSeconds }))
  }
  for (const durationSeconds of [
    undefined, null, '180', false, NaN, Infinity, -Infinity, -0.01, 180.01,
  ]) {
    invalidValues.push(session({ durationSeconds }))
  }
  for (const comboStats of [undefined, null, {}, []]) {
    invalidValues.push(session({ comboStats }))
  }
  invalidValues.push(
    session({ comboStats: { succeeded: 3, failed: 2, total: 4 } }),
    session({ comboStats: { succeeded: 3, failed: 2, total: 6 } }),
  )

  const invalidCounts = [
    undefined, null, '1', true, -1, 0.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]
  for (const key of ['succeeded', 'failed', 'total']) {
    for (const value of invalidCounts) {
      const candidate = session()
      candidate.comboStats[key] = value
      invalidValues.push(candidate)
    }
  }
  for (const details of [undefined, null, {}, []]) {
    invalidValues.push(session({ details }))
  }
  for (const speed of [
    undefined, null, '', 'CASUAL', 'fast', 'toString', '__proto__', 1,
  ]) {
    const candidate = session()
    candidate.details.speed = speed
    invalidValues.push(candidate)
  }
  for (const punchCounts of [undefined, null, {}, []]) {
    const candidate = session()
    candidate.details.punchCounts = punchCounts
    invalidValues.push(candidate)
  }
  for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
    for (const value of invalidCounts) {
      const candidate = session()
      candidate.details.punchCounts[key] = value
      invalidValues.push(candidate)
    }
  }

  for (const [index, value] of invalidValues.entries()) {
    assert.throws(
      () => validateSession(value),
      { name: 'Error', message: INVALID },
      `invalid case ${index}`,
    )
  }
})

test('new storage is empty and creates the versioned sessions store', async () => {
  const { indexedDB, name, storage } = fixture()

  assert.deepEqual(await storage.listSessions(), [])
  assert.equal(await storage.getSession('missing'), null)

  const db = await openRaw(indexedDB, name)
  try {
    assert.equal(db.version, 1)
    assert.deepEqual(Array.from(db.objectStoreNames), ['sessions'])
    const tx = db.transaction('sessions', 'readonly')
    assert.equal(tx.objectStore('sessions').keyPath, 'id')
    assert.equal(tx.objectStore('sessions').autoIncrement, false)
  } finally {
    db.close()
  }
})

test('saveSession persists only the summary and returns independent data', async () => {
  const { indexedDB, name, storage } = fixture()
  const input = session()
  input.recording = ['private-frame']
  input.comboStats.extra = 'discard'
  input.details.extra = 'discard'
  input.details.punchCounts.extra = 42
  const before = structuredClone(input)
  const expected = session()

  const saved = await storage.saveSession(input)
  assert.deepEqual(saved, expected)
  assert.deepEqual(input, before)
  assert.deepEqual(await readRaw(indexedDB, name, input.id), expected)

  input.details.punchCounts.jab = 999
  saved.comboStats.total = 999

  const fetched = await storage.getSession(expected.id)
  assert.deepEqual(fetched, expected)
  fetched.details.punchCounts.cross = 999

  const listed = await storage.listSessions()
  assert.deepEqual(listed, [expected])
  listed[0].details.speed = 'form'

  assert.deepEqual(await storage.getSession(expected.id), expected)
})

test('listSessions sorts by parsed end time, newest first', async () => {
  const { storage } = fixture()
  const oldest = session({
    id: 'z-oldest',
    endedAt: '2026-01-01T12:00:00+03:00',
  })
  const middle = session({
    id: 'a-middle',
    endedAt: '2026-01-01T10:00:00Z',
  })
  const newest = session({
    id: 'm-newest',
    endedAt: '2026-01-01T07:00:00-05:00',
  })

  for (const value of [middle, newest, oldest]) {
    await storage.saveSession(value)
  }

  assert.deepEqual(await storage.listSessions(), [newest, middle, oldest])
  assert.deepEqual(await storage.getSession(middle.id), middle)
})

test('the first saved completion wins across storage instances', async () => {
  const { indexedDB, name, storage } = fixture()
  const other = createSessionStorage({ indexedDB, name })
  const first = session()
  const retry = session({ durationSeconds: 20 })
  retry.details.speed = 'intense'

  assert.deepEqual(await storage.saveSession(first), first)
  assert.deepEqual(await other.saveSession(retry), first)
  assert.deepEqual(await storage.listSessions(), [first])
  assert.deepEqual(await other.getSession(first.id), first)
})

test('concurrent saves of one ID all return the same stored completion', async () => {
  const { indexedDB, name, storage } = fixture()
  const other = createSessionStorage({ indexedDB, name })
  const candidates = Array.from({ length: 12 }, (_, index) =>
    session({ durationSeconds: index }),
  )

  const results = await Promise.all(
    candidates.map((value, index) =>
      (index % 2 ? other : storage).saveSession(value),
    ),
  )
  const stored = await storage.getSession('workout-1')

  assert.ok(
    candidates.some((candidate) =>
      JSON.stringify(candidate) === JSON.stringify(stored),
    ),
  )
  for (const result of results) {
    assert.deepEqual(result, stored)
  }
  assert.deepEqual(await storage.listSessions(), [stored])
})

test('concurrent saves of different IDs retain every session', async () => {
  const { storage } = fixture()
  const values = Array.from({ length: 8 }, (_, index) =>
    session({ id: `workout-${index}` }),
  )

  await Promise.all(values.map((value) => storage.saveSession(value)))

  const actual = await storage.listSessions()
  assert.equal(actual.length, values.length)
  for (const value of values) {
    assert.deepEqual(await storage.getSession(value.id), value)
  }
})

test('different database names isolate histories', async () => {
  const indexedDB = new IDBFactory()
  const first = createSessionStorage({ indexedDB, name: 'first' })
  const second = createSessionStorage({ indexedDB, name: 'second' })

  await first.saveSession(session())
  assert.deepEqual(await second.listSessions(), [])
  assert.equal(await second.getSession('workout-1'), null)
})

test('invalid saves reject before opening IndexedDB and preserve history', async () => {
  let opens = 0
  const unavailable = createSessionStorage({
    indexedDB: {
      open() {
        opens += 1
        throw new Error('Unexpected database access')
      },
    },
  })

  await assert.rejects(
    unavailable.saveSession(session({ durationSeconds: -1 })),
    { message: INVALID },
  )
  assert.equal(opens, 0)

  const { storage } = fixture()
  const original = session()
  await storage.saveSession(original)

  await assert.rejects(
    storage.saveSession(session({ durationSeconds: 181 })),
    { message: INVALID },
  )
  await assert.rejects(
    storage.saveSession(session({ id: 'new-invalid', schemaVersion: 2 })),
    { message: INVALID },
  )
  assert.deepEqual(await storage.listSessions(), [original])
})

test('stored records are sanitized when read or returned for duplicate saves', async () => {
  const { indexedDB, name, storage } = fixture()
  const raw = session()
  raw.recording = ['frame']
  raw.comboStats.extra = 7
  raw.details.extra = 'private'
  raw.details.punchCounts.extra = 9
  await seed(indexedDB, name, raw)

  assert.deepEqual(await storage.getSession(raw.id), session())
  assert.deepEqual(await storage.listSessions(), [session()])
  assert.deepEqual(
    await storage.saveSession(session({ durationSeconds: 1 })),
    session(),
  )
})

test('corrupt stored records cause reads and duplicate saves to reject', async () => {
  const { indexedDB, name, storage } = fixture()
  const corrupt = session({ schemaVersion: 2 })
  await seed(indexedDB, name, corrupt)

  await assert.rejects(storage.getSession(corrupt.id), { message: INVALID })
  await assert.rejects(storage.listSessions(), { message: INVALID })
  await assert.rejects(storage.saveSession(session()), { message: INVALID })

  assert.deepEqual(await readRaw(indexedDB, name, corrupt.id), corrupt)
})

const operations = [
  {
    name: 'saveSession',
    mode: 'readwrite',
    run: (storage) => storage.saveSession(session()),
  },
  {
    name: 'listSessions',
    mode: 'readonly',
    run: (storage) => storage.listSessions(),
  },
  {
    name: 'getSession',
    mode: 'readonly',
    run: (storage) => storage.getSession('workout-1'),
  },
]

test('all storage operations reject when IndexedDB is unavailable', async () => {
  const storage = createSessionStorage({ indexedDB: null })
  for (const operation of operations) {
    await assert.rejects(operation.run(storage), { message: UNAVAILABLE })
  }
})

test('open errors and blocked opens reject every operation', async (t) => {
  for (const event of ['onerror', 'onblocked']) {
    for (const operation of operations) {
      await t.test(`${operation.name}: ${event}`, async () => {
        const backend = controlledBackend()
        const pending = operation.run(backend.storage)
        const rejected = assert.rejects(pending, { message: OPEN_FAILED })

        assert.deepEqual(backend.calls, [
          ['open', 'controlled-history', 1],
        ])
        backend.openRequest[event]()
        await rejected

        // An abandoned open may still succeed later; it must be closed.
        backend.openRequest.onsuccess()
        assert.equal(backend.closes, 1)
        assert.equal(backend.calls.length, 1)
      })
    }
  }
})

test('transaction errors and aborts reject and close the connection', async (t) => {
  for (const event of ['onerror', 'onabort']) {
    for (const operation of operations) {
      await t.test(`${operation.name}: ${event}`, async () => {
        const backend = controlledBackend()
        const pending = operation.run(backend.storage)
        const rejected = assert.rejects(pending, {
          message: TRANSACTION_FAILED,
        })

        backend.openRequest.onsuccess()
        await Promise.resolve()

        assert.deepEqual(backend.calls[1], [
          'transaction', 'sessions', operation.mode,
        ])
        assert.deepEqual(backend.calls[2], ['objectStore', 'sessions'])

        backend.tx[event]()
        await rejected
        assert.equal(backend.closes, 1)
      })
    }
  }
})

test('saveSession waits for transaction completion before resolving', async () => {
  const backend = controlledBackend()
  let settled = false
  const pending = backend.storage.saveSession(session())
  const observed = pending.then((value) => {
    settled = true
    return value
  })

  backend.openRequest.onsuccess()
  await Promise.resolve()

  backend.dataRequest.result = undefined
  backend.dataRequest.onsuccess()
  await Promise.resolve()

  assert.equal(settled, false)
  assert.equal(backend.closes, 0)
  assert.deepEqual(backend.calls.at(-1), ['add', session()])

  backend.tx.oncomplete()
  assert.deepEqual(await observed, session())
  assert.equal(backend.closes, 1)
})

test('a transaction abort after a successful request still rejects', async () => {
  const backend = controlledBackend()
  const pending = backend.storage.saveSession(session())
  const rejected = assert.rejects(pending, { message: TRANSACTION_FAILED })

  backend.openRequest.onsuccess()
  await Promise.resolve()

  backend.dataRequest.result = undefined
  backend.dataRequest.onsuccess()
  backend.tx.onabort()

  await rejected
  assert.equal(backend.closes, 1)
})

test('a version change closes an open database connection', async () => {
  const backend = controlledBackend()
  const pending = backend.storage.getSession('missing')

  backend.openRequest.onsuccess()
  await Promise.resolve()

  assert.equal(typeof backend.db.onversionchange, 'function')
  backend.db.onversionchange()
  assert.equal(backend.closes, 1)

  backend.dataRequest.onsuccess({ target: { result: undefined } })
  backend.tx.oncomplete()
  assert.equal(await pending, null)
})

test('module-level exports use the default database and support round trips', async () => {
  assert.equal(typeof saveSession, 'function')
  assert.equal(typeof listSessions, 'function')
  assert.equal(typeof getSession, 'function')

  assert.deepEqual(await listSessions(), [])
  assert.equal(await getSession('missing'), null)

  const value = session({ id: 'default-export-session' })
  assert.deepEqual(await saveSession(value), value)
  assert.deepEqual(await getSession(value.id), value)
  assert.deepEqual(await listSessions(), [value])

  const sameDatabase = createSessionStorage({
    indexedDB: defaultIndexedDB,
    name: 'shadowboxer-workouts',
  })
  assert.deepEqual(await sameDatabase.getSession(value.id), value)
})
