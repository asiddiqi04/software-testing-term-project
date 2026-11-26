import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  validateSession,
  createSessionStorage,
  saveSession,
  listSessions,
  getSession,
} from '../../frontend/src/lib/sessionStorage.js'

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
    id: 'session-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:03:00.000Z',
    roundDurationSeconds: 180,
    durationSeconds: 175.5,
    comboStats: { succeeded: 3, failed: 2, total: 5 },
    details: {
      speed: 'casual',
      punchCounts: { jab: 10, cross: 8, hook: 6, uppercut: 4 },
    },
    ...overrides,
  }
}

function isolatedStorage(name = 'test-workouts') {
  const indexedDB = new IDBFactory()
  return {
    indexedDB,
    name,
    storage: createSessionStorage({ indexedDB, name }),
  }
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putRaw(indexedDB, name, value) {
  const db = await openDatabase(indexedDB, name)
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.oncomplete = resolve
      tx.onabort = tx.onerror = () => reject(tx.error)
      tx.objectStore('sessions').put(value)
    })
  } finally {
    db.close()
  }
}

test('validateSession accepts all supported speeds and returns the summary', () => {
  for (const speed of ['form', 'casual', 'intense']) {
    const input = session()
    input.details.speed = speed
    assert.deepEqual(validateSession(input), input)
  }
})

test('validateSession accepts duration boundaries and safe integer boundaries', () => {
  for (const durationSeconds of [0, 0.25, 180]) {
    const input = session({ durationSeconds })
    assert.deepEqual(validateSession(input), input)
  }

  for (const count of [0, Number.MAX_SAFE_INTEGER]) {
    const input = session({
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

test('validateSession preserves valid IDs and date strings without normalization', () => {
  const input = session({
    id: '  workout α  ',
    startedAt: '2026-01-01T05:00:00-05:00',
    endedAt: '2026-01-01T05:03:00-05:00',
  })
  assert.deepEqual(validateSession(input), input)
})

test('validateSession rejects invalid top-level values and required fields', () => {
  for (const input of [undefined, null, false, 0, '', 'summary', [], {}]) {
    assert.throws(() => validateSession(input), {
      name: 'Error',
      message: INVALID,
    })
  }

  const invalidFields = {
    schemaVersion: [undefined, null, 0, 2, '1', true],
    id: [undefined, null, '', ' \t\n ', 123, {}, new String('id')],
    startedAt: [undefined, null, '', 'not-a-date', 0, new Date()],
    endedAt: [undefined, null, '', 'not-a-date', 0, new Date()],
    roundDurationSeconds: [undefined, null, 0, 179, 181, '180', NaN],
    durationSeconds: [
      undefined, null, -1, -Number.EPSILON, 180.001, NaN,
      Infinity, -Infinity, '175', true,
    ],
    comboStats: [undefined, null, {}, []],
    details: [undefined, null, {}, []],
  }

  for (const [field, values] of Object.entries(invalidFields)) {
    const missing = session()
    delete missing[field]
    assert.throws(
      () => validateSession(missing),
      { name: 'Error', message: INVALID },
      `missing ${field}`,
    )

    for (const value of values) {
      assert.throws(
        () => validateSession(session({ [field]: value })),
        { name: 'Error', message: INVALID },
        `invalid ${field}: ${String(value)}`,
      )
    }
  }
})

test('validateSession requires nonnegative safe integer combo statistics', () => {
  const invalidCounts = [
    undefined, null, -1, 0.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '3', true, 1n,
  ]

  for (const field of ['succeeded', 'failed', 'total']) {
    for (const value of invalidCounts) {
      const input = session()
      input.comboStats[field] = value
      assert.throws(
        () => validateSession(input),
        { name: 'Error', message: INVALID },
        `comboStats.${field}: ${String(value)}`,
      )
    }
  }

  for (const comboStats of [
    { succeeded: 3, failed: 2, total: 4 },
    { succeeded: 3, failed: 2, total: 6 },
    { succeeded: Number.MAX_SAFE_INTEGER, failed: 1, total: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => validateSession(session({ comboStats })), {
      name: 'Error',
      message: INVALID,
    })
  }
})

test('validateSession rejects unsupported speeds and invalid punch counts', () => {
  for (const speed of [
    undefined, null, '', 'fast', 'Casual', 'toString',
    'constructor', '__proto__', 1, new String('casual'),
  ]) {
    const input = session()
    input.details.speed = speed
    assert.throws(() => validateSession(input), {
      name: 'Error',
      message: INVALID,
    })
  }

  for (const punchCounts of [undefined, null, {}, []]) {
    const input = session()
    input.details.punchCounts = punchCounts
    assert.throws(() => validateSession(input), {
      name: 'Error',
      message: INVALID,
    })
  }

  for (const field of ['jab', 'cross', 'hook', 'uppercut']) {
    for (const value of [
      undefined, null, -1, 0.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1, '1', true, 1n,
    ]) {
      const input = session()
      input.details.punchCounts[field] = value
      assert.throws(
        () => validateSession(input),
        { name: 'Error', message: INVALID },
        `punchCounts.${field}: ${String(value)}`,
      )
    }
  }
})

test('validateSession strips arbitrary data, creates fresh objects, and does not mutate input', () => {
  const input = session()
  input.recording = { frames: [1, 2, 3] }
  input.extra = 'discard'
  input.comboStats.extra = 99
  input.details.recording = ['discard']
  input.details.punchCounts.kick = 12

  const before = structuredClone(input)
  Object.freeze(input.comboStats)
  Object.freeze(input.details.punchCounts)
  Object.freeze(input.details)
  Object.freeze(input)

  const result = validateSession(input)

  assert.deepEqual(result, session())
  assert.deepEqual(input, before)
  assert.notStrictEqual(result, input)
  assert.notStrictEqual(result.comboStats, input.comboStats)
  assert.notStrictEqual(result.details, input.details)
  assert.notStrictEqual(result.details.punchCounts, input.details.punchCounts)

  result.comboStats.succeeded = 100
  result.details.punchCounts.jab = 100
  assert.deepEqual(input, before)
})

test('new storage initializes an empty sessions store keyed by id', async () => {
  const { indexedDB, name, storage } = isolatedStorage()

  assert.deepEqual(await storage.listSessions(), [])
  assert.equal(await storage.getSession('missing'), null)

  const db = await openDatabase(indexedDB, name)
  try {
    assert.equal(db.version, 1)
    assert.deepEqual(Array.from(db.objectStoreNames), ['sessions'])
    const tx = db.transaction('sessions', 'readonly')
    assert.equal(tx.objectStore('sessions').keyPath, 'id')
  } finally {
    db.close()
  }
})

test('saveSession persists a sanitized summary and returns independent values', async () => {
  const { storage } = isolatedStorage()
  const input = session()
  input.recording = [1, 2]
  input.details.arbitrary = 'discard'
  input.comboStats.extra = true
  input.details.punchCounts.kick = 3

  const saved = await storage.saveSession(input)
  assert.deepEqual(saved, session())

  input.details.punchCounts.jab = 999
  saved.comboStats.succeeded = 999

  const fetched = await storage.getSession(input.id)
  assert.deepEqual(fetched, session())
  fetched.details.punchCounts.jab = 888

  const listed = await storage.listSessions()
  assert.deepEqual(listed, [session()])
  listed[0].details.speed = 'intense'

  assert.deepEqual(await storage.getSession(input.id), session())
  assert.equal(await storage.getSession('unknown'), null)
})

test('listSessions orders by parsed endedAt descending, including timezone offsets', async () => {
  const { storage } = isolatedStorage()
  const oldest = session({
    id: 'z-oldest',
    endedAt: '2026-01-01T12:00:00+02:00',
  })
  const middle = session({
    id: 'a-middle',
    endedAt: '2026-01-01T10:30:00Z',
  })
  const newest = session({
    id: 'm-newest',
    endedAt: '2026-01-01T06:00:00-05:00',
  })

  await storage.saveSession(middle)
  await storage.saveSession(oldest)
  await storage.saveSession(newest)

  assert.deepEqual(await storage.listSessions(), [newest, middle, oldest])
})

test('repeated saves preserve the first summary for an ID', async () => {
  const { storage } = isolatedStorage()
  const original = session()
  const replacement = session({
    durationSeconds: 30,
    endedAt: '2026-02-01T10:03:00Z',
    comboStats: { succeeded: 0, failed: 0, total: 0 },
  })

  assert.deepEqual(await storage.saveSession(original), original)
  assert.deepEqual(await storage.saveSession(replacement), original)
  assert.deepEqual(await storage.getSession(original.id), original)
  assert.deepEqual(await storage.listSessions(), [original])
})

test('concurrent saves across storage instances agree on one stored summary', async () => {
  const indexedDB = new IDBFactory()
  const name = 'shared-concurrent'
  const first = createSessionStorage({ indexedDB, name })
  const second = createSessionStorage({ indexedDB, name })

  await first.listSessions()
  const candidates = [
    session({ durationSeconds: 10 }),
    session({ durationSeconds: 20 }),
    session({ durationSeconds: 30 }),
  ]

  const results = await Promise.all([
    first.saveSession(candidates[0]),
    second.saveSession(candidates[1]),
    first.saveSession(candidates[2]),
  ])

  const stored = await second.getSession('session-1')
  assert.ok(candidates.some((candidate) =>
    candidate.durationSeconds === stored.durationSeconds))
  for (const result of results) assert.deepEqual(result, stored)
  assert.deepEqual(await first.listSessions(), [stored])
})

test('concurrent saves of different IDs retain every session', async () => {
  const { storage } = isolatedStorage()
  const inputs = Array.from({ length: 8 }, (_, index) =>
    session({ id: `session-${index}` }))

  assert.deepEqual(
    await Promise.all(inputs.map((input) => storage.saveSession(input))),
    inputs,
  )

  const listed = await storage.listSessions()
  assert.equal(listed.length, inputs.length)
  assert.deepEqual(
    listed.map((value) => value.id).sort(),
    inputs.map((value) => value.id).sort(),
  )
})

test('database names isolate history and instances sharing a name share history', async () => {
  const indexedDB = new IDBFactory()
  const first = createSessionStorage({ indexedDB, name: 'first' })
  const reopened = createSessionStorage({ indexedDB, name: 'first' })
  const second = createSessionStorage({ indexedDB, name: 'second' })

  await first.saveSession(session())
  assert.deepEqual(await reopened.getSession('session-1'), session())
  assert.deepEqual(await second.listSessions(), [])

  const defaults = createSessionStorage({ indexedDB })
  const explicitDefault = createSessionStorage({
    indexedDB,
    name: 'shadowboxer-workouts',
  })
  await defaults.saveSession(session({ id: 'default-name' }))
  assert.deepEqual(
    await explicitDefault.getSession('default-name'),
    session({ id: 'default-name' }),
  )
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

  await assert.rejects(storage.saveSession(session({ durationSeconds: -1 })), {
    name: 'Error',
    message: INVALID,
  })
  assert.equal(opens, 0)
})

test('invalid saves leave existing history intact, including duplicate IDs', async () => {
  const { storage } = isolatedStorage()
  await storage.saveSession(session())

  for (const id of ['session-1', 'invalid-new-session']) {
    await assert.rejects(
      storage.saveSession(session({ id, durationSeconds: 181 })),
      { name: 'Error', message: INVALID },
    )
  }

  assert.deepEqual(await storage.listSessions(), [session()])
})

test('read operations sanitize externally stored summaries', async () => {
  const { indexedDB, name, storage } = isolatedStorage()
  await storage.listSessions()

  const raw = session()
  raw.recording = [1, 2]
  raw.details.extra = 'discard'
  raw.details.punchCounts.kick = 4
  raw.comboStats.extra = 5
  await putRaw(indexedDB, name, raw)

  assert.deepEqual(await storage.getSession(raw.id), session())
  assert.deepEqual(await storage.listSessions(), [session()])
  assert.deepEqual(
    await storage.saveSession(session({ durationSeconds: 1 })),
    session(),
  )
})

test('corrupt persisted summaries reject reads and duplicate saves', async () => {
  const { indexedDB, name, storage } = isolatedStorage()
  await storage.saveSession(session({ id: 'valid' }))
  await putRaw(indexedDB, name, session({ id: 'corrupt', schemaVersion: 2 }))

  await assert.rejects(storage.getSession('corrupt'), {
    name: 'Error',
    message: INVALID,
  })
  await assert.rejects(storage.listSessions(), {
    name: 'Error',
    message: INVALID,
  })
  await assert.rejects(storage.saveSession(session({ id: 'corrupt' })), {
    name: 'Error',
    message: INVALID,
  })
  assert.deepEqual(await storage.getSession('valid'), session({ id: 'valid' }))
})

test('all storage operations report unavailable IndexedDB', async () => {
  const storage = createSessionStorage({ indexedDB: null })

  for (const operation of [
    () => storage.saveSession(session()),
    () => storage.listSessions(),
    () => storage.getSession('session-1'),
  ]) {
    await assert.rejects(operation(), {
      name: 'Error',
      message: UNAVAILABLE,
    })
  }
})

for (const event of ['onerror', 'onblocked']) {
  test(`open ${event} rejects and closes a late successful connection`, async () => {
    let closes = 0
    const storage = createSessionStorage({
      name: 'failed-open',
      indexedDB: {
        open(name, version) {
          assert.equal(name, 'failed-open')
          assert.equal(version, 1)
          const request = {
            result: { close() { closes += 1 } },
          }
          queueMicrotask(() => {
            request[event]()
            request.onsuccess()
          })
          return request
        },
      },
    })

    await assert.rejects(storage.listSessions(), {
      name: 'Error',
      message: OPEN_FAILED,
    })
    assert.equal(closes, 1)
  })
}

for (const event of ['onabort', 'onerror']) {
  test(`transaction ${event} rejects and closes the connection`, async () => {
    let closes = 0
    const db = {
      close() { closes += 1 },
      transaction(storeName, mode) {
        assert.equal(storeName, 'sessions')
        assert.equal(mode, 'readonly')
        const tx = {
          objectStore(name) {
            assert.equal(name, 'sessions')
            return { getAll() { return {} } }
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

    await assert.rejects(storage.listSessions(), {
      name: 'Error',
      message: TRANSACTION_FAILED,
    })
    assert.equal(closes, 1)
  })
}

test('reads wait for transaction completion and close on completion and version changes', async () => {
  let closes = 0
  let tx
  let readRequest
  let notifyReadStarted
  const readStarted = new Promise((resolve) => {
    notifyReadStarted = resolve
  })

  const db = {
    close() { closes += 1 },
    transaction(storeName, mode) {
      assert.equal(storeName, 'sessions')
      assert.equal(mode, 'readonly')
      tx = {
        objectStore() {
          return {
            getAll() {
              readRequest = {}
              notifyReadStarted()
              return readRequest
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
  pending.then(
    () => { settled = true },
    () => { settled = true },
  )

  await readStarted
  assert.equal(typeof db.onversionchange, 'function')
  readRequest.onsuccess({ target: { result: [session()] } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settled, false)
  assert.equal(closes, 0)

  tx.oncomplete()
  assert.deepEqual(await pending, [session()])
  assert.equal(closes, 1)

  db.onversionchange()
  assert.equal(closes, 2)
})

test('top-level exports use the default storage instance', async () => {
  assert.equal(typeof saveSession, 'function')
  assert.equal(typeof listSessions, 'function')
  assert.equal(typeof getSession, 'function')

  assert.deepEqual(await listSessions(), [])
  assert.equal(await getSession('missing-default'), null)

  const input = session({ id: 'default-export-session' })
  assert.deepEqual(await saveSession(input), input)
  assert.deepEqual(await getSession(input.id), input)
  assert.deepEqual(
    await saveSession({ ...input, durationSeconds: 1 }),
    input,
  )
  assert.deepEqual(await listSessions(), [input])
})
