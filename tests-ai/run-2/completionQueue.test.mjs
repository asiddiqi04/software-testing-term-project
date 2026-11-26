import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletionQueue } from '../../frontend/src/lib/completionQueue.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('an empty queue has no unsaved entries and retry does nothing', async () => {
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => notifications.push(snapshot),
  )

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(calls, [])
  assert.deepEqual(notifications, [])
})

test('add ignores falsy sessions without saving or notifying', async () => {
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => notifications.push(snapshot),
  )

  for (const session of [undefined, null, false, 0, '', NaN]) {
    assert.equal(queue.add(session), undefined)
  }

  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(notifications, [])
})

test('add immediately saves the original session and reports saving then saved', async () => {
  const operation = deferred()
  const session = Object.freeze({
    id: 'completion-1',
    result: Object.freeze({ score: 12 }),
  })
  const events = []
  const notifications = []
  const queue = createCompletionQueue(
    (received) => {
      events.push('save')
      assert.strictEqual(received, session)
      return operation.promise
    },
    (snapshot) => {
      events.push(snapshot[0].status)
      notifications.push(snapshot)
    },
  )

  assert.equal(queue.add(session), undefined)
  assert.deepEqual(events, ['saving', 'save'])
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications, [[{ session, status: 'saving' }]])

  operation.resolve()
  await flush()

  assert.deepEqual(events, ['saving', 'save', 'saved'])
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications, [
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])
  assert.deepEqual(session, {
    id: 'completion-1',
    result: { score: 12 },
  })
})

test('the default onChange works with a synchronous save', async () => {
  const session = { id: 'sync-success' }
  const calls = []
  const queue = createCompletionQueue((received) => {
    calls.push(received)
    return 42
  })

  queue.add(session)

  assert.deepEqual(calls, [session])
  assert.equal(queue.hasUnsaved(), true)

  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(calls, [session])
})

test('a synchronous save exception becomes an error and can be retried', async () => {
  const session = { id: 'sync-failure' }
  const notifications = []
  const calls = []
  const queue = createCompletionQueue(
    (received) => {
      calls.push(received)
      if (calls.length === 1) throw new Error('save failed')
    },
    (snapshot) => notifications.push(snapshot),
  )

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications, [
    [{ session, status: 'saving' }],
    [{ session, status: 'error' }],
  ])

  assert.deepEqual(await queue.retry(), [undefined])

  assert.deepEqual(calls, [session, session])
  assert.strictEqual(calls[1], session)
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications, [
    [{ session, status: 'saving' }],
    [{ session, status: 'error' }],
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])
})

test('rejected saves remain retryable and retry resolves even when saving fails', async () => {
  const session = { id: 'repeated-failure' }
  const operations = [deferred(), deferred(), deferred()]
  const calls = []
  const statuses = []
  const queue = createCompletionQueue(
    (received) => {
      calls.push(received)
      return operations[calls.length - 1].promise
    },
    (snapshot) => statuses.push(snapshot[0].status),
  )

  queue.add(session)
  operations[0].reject(new Error('first failure'))
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(statuses, ['saving', 'error'])

  const failedRetry = queue.retry()
  assert.deepEqual(statuses, ['saving', 'error', 'saving'])

  operations[1].reject(undefined)
  assert.deepEqual(await failedRetry, [undefined])
  assert.equal(queue.hasUnsaved(), true)

  const successfulRetry = queue.retry()
  operations[2].resolve()
  assert.deepEqual(await successfulRetry, [undefined])

  assert.equal(queue.hasUnsaved(), false)
  assert.equal(calls.length, 3)
  for (const received of calls) {
    assert.strictEqual(received, session)
    assert.equal(received.id, 'repeated-failure')
  }
  assert.deepEqual(statuses, [
    'saving', 'error',
    'saving', 'error',
    'saving', 'saved',
  ])
})

test('duplicate IDs are ignored while saving, after failure, and after success', async () => {
  const original = { id: 'duplicate', result: 'original' }
  const replacement = { id: 'duplicate', result: 'replacement' }
  const initial = deferred()
  const retryOperation = deferred()
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return calls.length === 1 ? initial.promise : retryOperation.promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(original)
  queue.add(original)
  queue.add(replacement)

  assert.deepEqual(calls, [original])
  assert.equal(notifications.length, 1)

  initial.reject(new Error('initial failure'))
  await flush()

  queue.add(replacement)
  assert.deepEqual(calls, [original])
  assert.equal(notifications.length, 2)
  assert.equal(queue.hasUnsaved(), true)

  const retry = queue.retry()
  queue.add(replacement)

  assert.deepEqual(calls, [original, original])
  assert.equal(notifications.length, 3)

  retryOperation.resolve()
  await retry

  queue.add(original)
  queue.add(replacement)
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(calls, [original, original])
  assert.equal(notifications.length, 4)
  for (const snapshot of notifications) {
    assert.equal(snapshot.length, 1)
    assert.strictEqual(snapshot[0].session, original)
  }
})

test('independent saves run concurrently and snapshots retain insertion order', async () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  const firstOperation = deferred()
  const secondOperation = deferred()
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return session === first
        ? firstOperation.promise
        : secondOperation.promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(first)
  queue.add(second)

  assert.deepEqual(calls, [first, second])
  assert.equal(queue.hasUnsaved(), true)

  secondOperation.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), true)

  firstOperation.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications, [
    [{ session: first, status: 'saving' }],
    [
      { session: first, status: 'saving' },
      { session: second, status: 'saving' },
    ],
    [
      { session: first, status: 'saving' },
      { session: second, status: 'saved' },
    ],
    [
      { session: first, status: 'saved' },
      { session: second, status: 'saved' },
    ],
  ])
})

test('saved completions are retained when subsequent rounds are added', async () => {
  const first = { id: 'round-1' }
  const second = { id: 'round-2' }
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(first)
  await flush()
  assert.equal(queue.hasUnsaved(), false)

  queue.add(second)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saving' },
  ])

  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
  ])
  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(calls, [first, second])
})

test('retry selects only errors, starts them concurrently, and waits for all selected saves', async () => {
  const saved = { id: 'saved' }
  const saving = { id: 'saving' }
  const failedA = { id: 'failed-a' }
  const failedB = { id: 'failed-b' }
  const pendingSave = deferred()
  const retryA = deferred()
  const retryB = deferred()
  const attempts = new Map()
  const calls = []
  let latestSnapshot
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      const count = (attempts.get(session) ?? 0) + 1
      attempts.set(session, count)

      if (session === saved) return
      if (session === saving) return pendingSave.promise
      if (count === 1) return Promise.reject(new Error('initial failure'))
      return session === failedA ? retryA.promise : retryB.promise
    },
    (snapshot) => {
      latestSnapshot = snapshot
    },
  )

  for (const session of [saved, saving, failedA, failedB]) {
    queue.add(session)
  }
  await flush()

  assert.deepEqual(latestSnapshot.map(({ status }) => status), [
    'saved', 'saving', 'error', 'error',
  ])

  let retryFinished = false
  const retry = queue.retry()
  const observedRetry = retry.then((result) => {
    retryFinished = true
    return result
  })

  assert.deepEqual(calls, [
    saved, saving, failedA, failedB, failedA, failedB,
  ])
  assert.deepEqual(latestSnapshot.map(({ status }) => status), [
    'saved', 'saving', 'saving', 'saving',
  ])

  const snapshotBeforeOverlappingRetry = latestSnapshot
  assert.deepEqual(await queue.retry(), [])
  assert.strictEqual(latestSnapshot, snapshotBeforeOverlappingRetry)
  assert.equal(calls.length, 6)

  retryB.resolve()
  await flush()

  assert.equal(retryFinished, false)
  assert.equal(queue.hasUnsaved(), true)

  retryA.resolve()
  assert.deepEqual(await observedRetry, [undefined, undefined])
  assert.equal(retryFinished, true)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(latestSnapshot.map(({ status }) => status), [
    'saved', 'saving', 'saved', 'saved',
  ])

  pendingSave.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(calls.length, 6)
})

test('notifications contain fresh arrays and records without exposing entry state', async () => {
  const session = { id: 'snapshot' }
  const operation = deferred()
  const notifications = []
  const queue = createCompletionQueue(
    () => operation.promise,
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(session)

  const savingSnapshot = notifications[0]
  const savingRecord = savingSnapshot[0]
  assert.deepEqual(Object.keys(savingRecord).sort(), ['session', 'status'])
  assert.strictEqual(savingRecord.session, session)

  operation.resolve()
  await flush()

  const savedSnapshot = notifications[1]
  assert.notStrictEqual(savedSnapshot, savingSnapshot)
  assert.notStrictEqual(savedSnapshot[0], savingRecord)
  assert.equal(savingRecord.status, 'saving')
  assert.equal(savedSnapshot[0].status, 'saved')

  savedSnapshot[0].status = 'error'
  savedSnapshot[0].session = { id: 'replacement' }
  savedSnapshot.push({ session: { id: 'injected' }, status: 'error' })
  savingSnapshot.length = 0

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(notifications.length, 2)
})

test('IDs use Map key semantics without string coercion', async () => {
  const sessions = [
    { id: 1 },
    { id: '1' },
    { id: '__proto__' },
    { id: 'constructor' },
    { id: 0 },
  ]
  const calls = []
  const queue = createCompletionQueue((session) => calls.push(session))

  for (const session of sessions) {
    queue.add(session)
  }
  for (const session of sessions) {
    queue.add({ id: session.id })
  }

  await flush()

  assert.deepEqual(calls, sessions)
  assert.equal(queue.hasUnsaved(), false)
})
