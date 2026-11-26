import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'

// The module captures globalThis.indexedDB when creating its default storage.
const defaultIndexedDB = new IDBFactory()
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

let sessionStorage
try {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: defaultIndexedDB,
  })
  sessionStorage = await import('../../frontend/src/lib/sessionStorage.js')
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
} = sessionStorage

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
    endedAt: '2026-01-01T12:02:00.000Z',
    roundDurationSeconds: 180,
    durationSeconds: 120,
    comboStats: { succeeded: 3, failed: 2, total: 5 },
    details: {
      speed: 'casual',
      punchCounts: { jab: 4, cross: 3, hook: 2, uppercut: 1 },
    },
    ...overrides,
  }
}

function createFixture() {
  const indexedDB = new IDBFactory()
  const name = 'session-storage-test'
  return {
    indexedDB,
    name,
    storage: createSessionStorage({ indexedDB, name }),
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function openRawDatabase(indexedDB, name) {
  const request = indexedDB.open(name, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('sessions', { keyPath: 'id' })
  }
  return requestResult(request)
}

async function putRaw(indexedDB, name, values) {
  const db = await openRawDatabase(indexedDB, name)
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.oncomplete = resolve
      tx.onabort = tx.onerror = () => reject(tx.error)
      const store = tx.objectStore('sessions')
      for (const value of values) store.put(value)
    })
  } finally {
    db.close()
  }
}

async function readRaw(indexedDB, name, id) {
  const db = await openRawDatabase(indexedDB, name)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly')
      let value
      tx.oncomplete = () => resolve(value)
      tx.onabort = tx.onerror = () => reject(tx.error)
      tx.objectStore('sessions').get(id).onsuccess = (event) => {
        value = event.target.result
      }
    })
  } finally {
    db.close()
  }
}

test('validateSession accepts every supported speed and returns independent objects', () => {
  for (const speed of ['form', 'casual', 'intense']) {
    const input = makeSession()
    input.details.speed = speed

    const result = validateSession(input)

    assert.deepEqual(result, input)
    assert.notStrictEqual(result, input)
    assert.notStrictEqual(result.comboStats, input.comboStats)
    assert.notStrictEqual(result.details, input.details)
    assert.notStrictEqual(result.details.punchCounts, input.details.punchCounts)

    result.comboStats.succeeded = 99
    result.details.punchCounts.jab = 99
    assert.equal(input.comboStats.succeeded, 3)
    assert.equal(input.details.punchCounts.jab, 4)
  }
})

test('validateSession accepts duration boundaries, fractional durations, and safe count boundaries', () => {
  for (const durationSeconds of [0, 0.25, 179.999, 180]) {
    const input = makeSession({ durationSeconds })
    assert.deepEqual(validateSession(input), input)
  }

  for (const count of [0, Number.MAX_SAFE_INTEGER]) {
    const input = makeSession({
      comboStats: { succeeded: count, failed: 0, total: count },
      details: {
        speed: 'form',
        punchCounts: {
          jab: count,
          cross: count,
          hook: count,
          uppercut: count,
        },
      },
    })
    assert.deepEqual(validateSession(input), input)
  }
})

test('validateSession preserves accepted strings without normalizing them', () => {
  const input = makeSession({
    id: '  session with spaces  ',
    startedAt: '2026-01-01T07:00:00-05:00',
    endedAt: '2026-01-01T07:02:00-05:00',
  })
  assert.deepEqual(validateSession(input), input)
})

test('validateSession strips unversioned fields without mutating its input', () => {
  const input = makeSession()
  input.recording = new Uint8Array([1, 2, 3])
  input.extra = { private: true }
  input.comboStats.extra = 42
  input.details.recording = ['frame']
  input.details.extra = 'discard'
  input.details.punchCounts.kick = 8

  const before = structuredClone(input)
  const result = validateSession(input)

  assert.deepEqual(result, makeSession())
  assert.deepEqual(input, before)
})

test('validateSession rejects invalid root values', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'session', [], {}]) {
    assert.throws(() => validateSession(value), {
      name: 'Error',
      message: INVALID,
    })
  }
})

test('validateSession rejects invalid scalar fields', async (t) => {
  const invalidFields = {
    schemaVersion: [undefined, null, 0, 2, '1', true],
    id: [undefined, null, '', ' \t\n', 123, {}, new String('id')],
    startedAt: [undefined, null, '', 'not-a-date', Infinity, 0, new Date()],
    endedAt: [undefined, null, '', 'not-a-date', Infinity, 0, new Date()],
    roundDurationSeconds: [undefined, null, 0, 179, 181, '180', NaN, Infinity],
    durationSeconds: [
      undefined, null, -1, -Number.MIN_VALUE, 180.001, '120',
      NaN, Infinity, -Infinity, true,
    ],
  }

  for (const [field, values] of Object.entries(invalidFields)) {
    await t.test(field, () => {
      for (const value of values) {
        assert.throws(
          () => validateSession(makeSession({ [field]: value })),
          { name: 'Error', message: INVALID },
          `${field} must reject ${String(value)}`,
        )
      }
    })
  }
})

test('validateSession requires valid nested objects and every count', () => {
  for (const value of [undefined, null, {}, false, 'invalid']) {
    const missingStats = makeSession({ comboStats: value })
    assert.throws(() => validateSession(missingStats), { message: INVALID })

    const missingDetails = makeSession({ details: value })
    assert.throws(() => validateSession(missingDetails), { message: INVALID })

    const missingCounts = makeSession()
    missingCounts.details.punchCounts = value
    assert.throws(() => validateSession(missingCounts), { message: INVALID })
  }
})

test('validateSession rejects invalid integer counts in every position', async (t) => {
  const invalidCounts = [
    undefined, null, -1, 0.5, '0', false, NaN, Infinity,
    -Infinity, Number.MAX_SAFE_INTEGER + 1,
  ]

  for (const key of ['succeeded', 'failed', 'total']) {
    await t.test(`comboStats.${key}`, () => {
      for (const value of invalidCounts) {
        const input = makeSession()
        input.comboStats[key] = value
        assert.throws(() => validateSession(input), { message: INVALID })
      }
    })
  }

  for (const key of ['jab', 'cross', 'hook', 'uppercut']) {
    await t.test(`details.punchCounts.${key}`, () => {
      for (const value of invalidCounts) {
        const input = makeSession()
        input.details.punchCounts[key] = value
        assert.throws(() => validateSession(input), { message: INVALID })
      }
    })
  }
})

test('validateSession requires total to equal succeeded plus failed', () => {
  for (const total of [0, 4, 6]) {
    const input = makeSession({
      comboStats: { succeeded: 3, failed: 2, total },
    })
    assert.throws(() => validateSession(input), { message: INVALID })
  }
})

test('validateSession rejects unsupported speeds, including inherited property names', () => {
  for (const speed of [
    undefined, null, '', 'fast', 'Casual', ' casual ', 1,
    {}, 'toString', 'constructor', '__proto__',
  ]) {
    const input = makeSession()
    input.details.speed = speed
    assert.throws(() => validateSession(input), { message: INVALID })
  }
})

test('new storage lists no sessions and returns null for an unknown ID', async () => {
  const { storage } = createFixture()
  assert.deepEqual(await storage.listSessions(), [])
  assert.equal(await storage.getSession('missing'), null)
})

test('saveSession persists only the versioned summary and returns detached data', async () => {
  const { storage, indexedDB, name } = createFixture()
  const input = makeSession()
  input.recording = ['private frame']
  input.comboStats.extra = 10
  input.details.recording = ['another frame']
  input.details.punchCounts.kick = 9

  const expected = makeSession()
  const saved = await storage.saveSession(input)

  assert.deepEqual(saved, expected)
  assert.deepEqual(await readRaw(indexedDB, name, input.id), expected)

  input.details.punchCounts.jab = 100
  saved.comboStats.total = 100
  saved.details.punchCounts.cross = 100

  const fetched = await storage.getSession(expected.id)
  assert.deepEqual(fetched, expected)
  fetched.details.speed = 'intense'

  const listed = await storage.listSessions()
  assert.deepEqual(listed, [expected])
  listed[0].details.punchCounts.hook = 100
  assert.deepEqual(await storage.getSession(expected.id), expected)
})

test('listSessions sorts by parsed endedAt descending, not ID or insertion order', async () => {
  const { storage } = createFixture()
  const oldest = makeSession({
    id: 'z-oldest',
    endedAt: '2026-01-01T10:00:00Z',
  })
  const newest = makeSession({
    id: 'a-newest',
    endedAt: '2026-01-01T07:30:00-05:00',
  })
  const middle = makeSession({
    id: 'm-middle',
    endedAt: '2026-01-01T12:00:00Z',
  })

  for (const value of [middle, oldest, newest]) {
    await storage.saveSession(value)
  }

  assert.deepEqual(await storage.listSessions(), [newest, middle, oldest])
  assert.deepEqual(await storage.getSession(middle.id), middle)
})

test('repeated saves preserve the first summary for an ID', async () => {
  const { storage } = createFixture()
  const first = makeSession()
  const replacement = makeSession({
    durationSeconds: 180,
    endedAt: '2026-02-01T12:03:00Z',
    comboStats: { succeeded: 10, failed: 0, total: 10 },
  })

  assert.deepEqual(await storage.saveSession(first), first)
  assert.deepEqual(await storage.saveSession(replacement), first)
  assert.deepEqual(await storage.getSession(first.id), first)
  assert.deepEqual(await storage.listSessions(), [first])
})

test('concurrent saves across storage instances choose one first completion', async () => {
  const { storage, indexedDB, name } = createFixture()
  const otherStorage = createSessionStorage({ indexedDB, name })
  const candidates = [30, 60, 90, 120].map((durationSeconds) =>
    makeSession({ durationSeconds }),
  )

  const results = await Promise.all(
    candidates.map((value, index) =>
      (index % 2 ? otherStorage : storage).saveSession(value),
    ),
  )

  const winner = await storage.getSession('session-1')
  assert.ok(candidates.some((value) => value.durationSeconds === winner.durationSeconds))
  for (const result of results) assert.deepEqual(result, winner)
  assert.deepEqual(await otherStorage.listSessions(), [winner])
})

test('storage instances share a database name and isolate different names', async () => {
  const { storage, indexedDB, name } = createFixture()
  const shared = createSessionStorage({ indexedDB, name })
  const separate = createSessionStorage({ indexedDB, name: `${name}-other` })
  const input = makeSession()

  await storage.saveSession(input)

  assert.deepEqual(await shared.getSession(input.id), input)
  assert.deepEqual(await shared.listSessions(), [input])
  assert.deepEqual(await separate.listSessions(), [])
  assert.equal(await separate.getSession(input.id), null)
})

test('invalid saves reject before opening IndexedDB', async () => {
  let opens = 0
  const storage = createSessionStorage({
    indexedDB: {
      open() {
        opens += 1
        throw new Error('Unexpected database access')
      },
    },
  })

  await assert.rejects(storage.saveSession(makeSession({ durationSeconds: -1 })), {
    name: 'Error',
    message: INVALID,
  })
  assert.equal(opens, 0)
})

test('invalid saves, including duplicate IDs, leave existing history unchanged', async () => {
  const { storage } = createFixture()
  const original = makeSession()
  await storage.saveSession(original)

  for (const id of [original.id, 'new-invalid-session']) {
    await assert.rejects(
      storage.saveSession(makeSession({ id, durationSeconds: 181 })),
      { message: INVALID },
    )
  }

  assert.deepEqual(await storage.listSessions(), [original])
  assert.equal(await storage.getSession('new-invalid-session'), null)
})

test('stored summaries are sanitized again when read or returned for a duplicate save', async () => {
  const { storage, indexedDB, name } = createFixture()
  const raw = makeSession()
  raw.recording = ['legacy data']
  raw.details.extra = 'discard'
  raw.comboStats.extra = 12
  raw.details.punchCounts.kick = 3
  await putRaw(indexedDB, name, [raw])

  const expected = makeSession()
  assert.deepEqual(await storage.getSession(raw.id), expected)
  assert.deepEqual(await storage.listSessions(), [expected])
  assert.deepEqual(
    await storage.saveSession(makeSession({ durationSeconds: 1 })),
    expected,
  )
})

test('corrupt persisted summaries reject reads and duplicate saves without replacement', async () => {
  const { storage, indexedDB, name } = createFixture()
  const corrupt = makeSession({ durationSeconds: 181 })
  await putRaw(indexedDB, name, [corrupt])

  await assert.rejects(storage.getSession(corrupt.id), { message: INVALID })
  await assert.rejects(storage.listSessions(), { message: INVALID })
  await assert.rejects(storage.saveSession(makeSession()), { message: INVALID })

  assert.deepEqual(await readRaw(indexedDB, name, corrupt.id), corrupt)
  assert.equal(await storage.getSession('missing'), null)
})

const operations = [
  ['saveSession', (storage) => storage.saveSession(makeSession()), 'readwrite'],
  ['listSessions', (storage) => storage.listSessions(), 'readonly'],
  ['getSession', (storage) => storage.getSession('session-1'), 'readonly'],
]

test('all storage operations report unavailable IndexedDB', async (t) => {
  for (const [label, invoke] of operations) {
    await t.test(label, async () => {
      const storage = createSessionStorage({ indexedDB: null })
      await assert.rejects(invoke(storage), {
        name: 'Error',
        message: UNAVAILABLE,
      })
    })
  }
})

test('open errors and blocked opens reject every storage operation', async (t) => {
  for (const event of ['onerror', 'onblocked']) {
    for (const [label, invoke] of operations) {
      await t.test(`${event}: ${label}`, async () => {
        const storage = createSessionStorage({
          name: 'requested-name',
          indexedDB: {
            open(name, version) {
              assert.equal(name, 'requested-name')
              assert.equal(version, 1)
              const request = {}
              queueMicrotask(() => request[event]())
              return request
            },
          },
        })

        await assert.rejects(invoke(storage), {
          name: 'Error',
          message: OPEN_FAILED,
        })
      })
    }
  }
})

test('an abandoned open closes a database that succeeds later', async () => {
  let request
  let closed = 0
  let transactions = 0
  const db = {
    close() {
      closed += 1
    },
    transaction() {
      transactions += 1
      throw new Error('An abandoned connection must not start a transaction')
    },
  }
  const storage = createSessionStorage({
    indexedDB: {
      open() {
        request = { result: db }
        queueMicrotask(() => request.onblocked())
        return request
      },
    },
  })

  await assert.rejects(storage.listSessions(), { message: OPEN_FAILED })
  request.onsuccess()

  assert.equal(closed, 1)
  assert.equal(transactions, 0)
})

test('transaction errors and aborts reject operations and close their connections', async (t) => {
  for (const event of ['onerror', 'onabort']) {
    for (const [label, invoke, expectedMode] of operations) {
      await t.test(`${event}: ${label}`, async () => {
        let closed = 0
        const db = {
          close() {
            closed += 1
          },
          transaction(storeName, mode) {
            assert.equal(storeName, 'sessions')
            assert.equal(mode, expectedMode)
            const tx = {
              objectStore(name) {
                assert.equal(name, 'sessions')
                return {
                  get: () => ({}),
                  getAll: () => ({}),
                }
              },
            }
            queueMicrotask(() => tx[event]())
            return tx
          },
        }
        const storage = createSessionStorage({
          indexedDB: {
            open() {
              const request = { result: db }
              queueMicrotask(() => request.onsuccess())
              return request
            },
          },
        })

        await assert.rejects(invoke(storage), {
          name: 'Error',
          message: TRANSACTION_FAILED,
        })
        assert.equal(closed, 1)
      })
    }
  }
})

test('operations wait for transaction completion and close on version changes', async () => {
  let tx
  let getAllRequest
  let closed = 0
  let operationStarted
  const started = new Promise((resolve) => {
    operationStarted = resolve
  })
  const db = {
    close() {
      closed += 1
    },
    transaction() {
      tx = {
        objectStore() {
          return {
            getAll() {
              getAllRequest = {}
              operationStarted()
              return getAllRequest
            },
          }
        },
      }
      return tx
    },
  }
  const storage = createSessionStorage({
    indexedDB: {
      open() {
        const request = { result: db }
        queueMicrotask(() => request.onsuccess())
        return request
      },
    },
  })

  let settled = false
  const pending = storage.listSessions()
  const observed = pending.then(() => {
    settled = true
  })

  await started
  getAllRequest.onsuccess({ target: { result: [makeSession()] } })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(closed, 0)

  assert.equal(typeof db.onversionchange, 'function')
  db.onversionchange()
  assert.equal(closed, 1)

  tx.oncomplete()
  assert.deepEqual(await pending, [makeSession()])
  await observed
  assert.equal(settled, true)
  assert.equal(closed, 2)
})

test('named default exports share the default database', async (t) => {
  t.after(async () => {
    await requestResult(defaultIndexedDB.deleteDatabase('shadowboxer-workouts'))
  })

  assert.equal(typeof saveSession, 'function')
  assert.equal(typeof listSessions, 'function')
  assert.equal(typeof getSession, 'function')
  assert.deepEqual(await listSessions(), [])
  assert.equal(await getSession('missing'), null)

  const input = makeSession({ id: 'default-export-session' })
  assert.deepEqual(await saveSession(input), input)
  assert.deepEqual(await getSession(input.id), input)
  assert.deepEqual(await listSessions(), [input])

  const sameDatabase = createSessionStorage({ indexedDB: defaultIndexedDB })
  assert.deepEqual(await sameDatabase.getSession(input.id), input)
  assert.deepEqual(
    await saveSession({ ...input, durationSeconds: 10 }),
    input,
  )
})
