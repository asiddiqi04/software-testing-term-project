import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletionQueue } from '../../frontend/src/lib/completionQueue.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('starts empty and ignores falsy sessions', async () => {
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => changes.push(snapshot),
  )

  assert.equal(queue.hasUnsaved(), false)

  for (const value of [undefined, null, false, 0, '', NaN]) {
    assert.equal(queue.add(value), undefined)
  }

  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(calls, [])
  assert.deepEqual(changes, [])
  assert.equal(queue.hasUnsaved(), false)
})

test('add immediately starts saving and notifies before invoking save', async () => {
  const session = Object.freeze({ id: 'one', score: 10 })
  const pending = deferred()
  const events = []
  const queue = createCompletionQueue(
    (received) => {
      events.push({ type: 'save', session: received })
      return pending.promise
    },
    (snapshot) => events.push({ type: 'change', snapshot }),
  )

  assert.equal(queue.add(session), undefined)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(events, [
    { type: 'change', snapshot: [{ session, status: 'saving' }] },
    { type: 'save', session },
  ])
  assert.strictEqual(events[1].session, session)

  pending.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(events[2], {
    type: 'change',
    snapshot: [{ session, status: 'saved' }],
  })
})

test('supports synchronous save functions and the default onChange callback', async () => {
  const session = { id: 'sync' }
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

test('synchronous save exceptions become errors and can be retried', async () => {
  const session = { id: 'throws' }
  const changes = []
  let attempts = 0
  const queue = createCompletionQueue(
    (received) => {
      assert.strictEqual(received, session)
      attempts += 1
      if (attempts === 1) throw new Error('save failed')
    },
    (snapshot) => changes.push(snapshot),
  )

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes, [
    [{ session, status: 'saving' }],
    [{ session, status: 'error' }],
  ])

  const retry = queue.retry()
  assert.equal(attempts, 2)
  assert.deepEqual(changes.at(-1), [{ session, status: 'saving' }])

  assert.deepEqual(await retry, [undefined])
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.at(-1), [{ session, status: 'saved' }])
})

test('rejected saves remain retryable, and retry resolves even if saving fails again', async () => {
  const session = { id: 'rejects' }
  const changes = []
  let attempts = 0
  const queue = createCompletionQueue(
    () => {
      attempts += 1
      return attempts < 3 ? Promise.reject('unavailable') : Promise.resolve()
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [{ session, status: 'error' }])

  assert.deepEqual(await queue.retry(), [undefined])
  assert.equal(attempts, 2)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [{ session, status: 'error' }])

  await queue.retry()

  assert.equal(attempts, 3)
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(
    changes.map((snapshot) => snapshot[0].status),
    ['saving', 'error', 'saving', 'error', 'saving', 'saved'],
  )
})

test('duplicate IDs never replace or resubmit an existing session', async () => {
  const original = Object.freeze({ id: 'same', score: 1 })
  const replacement = { id: 'same', score: 99 }
  const firstAttempt = deferred()
  const secondAttempt = deferred()
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return calls.length === 1 ? firstAttempt.promise : secondAttempt.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(original)
  queue.add(original)
  queue.add(replacement)

  assert.equal(calls.length, 1)
  assert.equal(changes.length, 1)

  firstAttempt.reject(new Error('failed'))
  await flush()

  queue.add(replacement)

  assert.equal(calls.length, 1)
  assert.equal(changes.length, 2)

  const retry = queue.retry()
  queue.add(replacement)

  assert.equal(calls.length, 2)
  assert.strictEqual(calls[0], original)
  assert.strictEqual(calls[1], original)
  assert.equal(changes.length, 3)

  secondAttempt.resolve()
  await retry

  queue.add(replacement)
  await queue.retry()

  assert.equal(calls.length, 2)
  assert.equal(changes.length, 4)
  assert.equal(queue.hasUnsaved(), false)
  for (const snapshot of changes) {
    assert.strictEqual(snapshot[0].session, original)
  }
})

test('retains saved sessions across later additions and preserves insertion order', async () => {
  const first = Object.freeze({ id: 'first' })
  const second = Object.freeze({ id: 'second' })
  const third = Object.freeze({ id: 'third' })
  const pending = new Map(
    [first, second, third].map((session) => [session.id, deferred()]),
  )
  const changes = []
  const queue = createCompletionQueue(
    (session) => pending.get(session.id).promise,
    (snapshot) => changes.push(snapshot),
  )

  queue.add(first)
  pending.get(first.id).resolve()
  await flush()
  assert.equal(queue.hasUnsaved(), false)

  queue.add(second)
  queue.add(third)

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saving' },
    { session: third, status: 'saving' },
  ])

  pending.get(third.id).resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saving' },
    { session: third, status: 'saved' },
  ])

  pending.get(second.id).resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
    { session: third, status: 'saved' },
  ])
})

test('retry starts all failed entries, skips saving and saved entries, and waits for its attempts', async () => {
  const sessions = ['saved', 'saving', 'error-a', 'error-b'].map((id) => ({ id }))
  const initial = new Map(sessions.map(({ id }) => [id, deferred()]))
  const retries = new Map([
    ['error-a', deferred()],
    ['error-b', deferred()],
  ])
  const counts = new Map()
  const changes = []
  const queue = createCompletionQueue(
    ({ id }) => {
      const count = (counts.get(id) ?? 0) + 1
      counts.set(id, count)
      return count === 1 ? initial.get(id).promise : retries.get(id).promise
    },
    (snapshot) => changes.push(snapshot),
  )

  for (const session of sessions) queue.add(session)

  initial.get('saved').resolve()
  initial.get('error-a').reject(new Error('a failed'))
  initial.get('error-b').reject(new Error('b failed'))
  await flush()

  let retryFinished = false
  const retry = queue.retry().then((result) => {
    retryFinished = true
    return result
  })

  assert.deepEqual([...counts], [
    ['saved', 1],
    ['saving', 1],
    ['error-a', 2],
    ['error-b', 2],
  ])
  assert.deepEqual(
    changes.at(-1).map(({ status }) => status),
    ['saved', 'saving', 'saving', 'saving'],
  )

  const notificationCount = changes.length
  assert.deepEqual(await queue.retry(), [])
  assert.equal(changes.length, notificationCount)
  assert.equal(counts.get('error-a'), 2)
  assert.equal(counts.get('error-b'), 2)

  retries.get('error-a').resolve()
  await flush()
  assert.equal(retryFinished, false)

  retries.get('error-b').resolve()
  assert.deepEqual(await retry, [undefined, undefined])
  assert.equal(retryFinished, true)
  assert.equal(queue.hasUnsaved(), true)

  initial.get('saving').resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(
    changes.at(-1).map(({ status }) => status),
    ['saved', 'saved', 'saved', 'saved'],
  )
})

test('notifications contain fresh arrays and wrappers without exposing internal entries', async () => {
  const session = { id: 'snapshot' }
  const pending = deferred()
  const changes = []
  const queue = createCompletionQueue(
    () => pending.promise,
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)
  const savingSnapshot = changes[0]
  const savingItem = savingSnapshot[0]

  pending.resolve()
  await flush()

  const savedSnapshot = changes[1]
  assert.notStrictEqual(savedSnapshot, savingSnapshot)
  assert.notStrictEqual(savedSnapshot[0], savingItem)
  assert.deepEqual(savingSnapshot, [{ session, status: 'saving' }])
  assert.deepEqual(savedSnapshot, [{ session, status: 'saved' }])
  assert.strictEqual(savedSnapshot[0].session, session)

  savedSnapshot[0].status = 'error'
  savedSnapshot[0].session = { id: 'replacement' }
  savedSnapshot.push({ session: { id: 'extra' }, status: 'error' })

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(changes.length, 2)
})
