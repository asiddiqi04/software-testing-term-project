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

test('add ignores falsy sessions', async () => {
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => notifications.push(snapshot),
  )

  for (const value of [undefined, null, false, 0, '', NaN]) {
    queue.add(value)
  }

  await flush()

  assert.deepEqual(calls, [])
  assert.deepEqual(notifications, [])
  assert.equal(queue.hasUnsaved(), false)
})

test('add saves immediately and notifies saving followed by saved', async () => {
  const session = Object.freeze({ id: 'first', result: 'complete' })
  const pending = deferred()
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (value) => {
      calls.push(value)
      return pending.promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(session)

  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0], session)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications, [[{ session, status: 'saving' }]])

  pending.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications, [
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])
  assert.strictEqual(notifications[1][0].session, session)
  assert.notStrictEqual(notifications[0], notifications[1])
  assert.notStrictEqual(notifications[0][0], notifications[1][0])
})

test('onChange is optional and save may return synchronously', async () => {
  const session = { id: 'synchronous' }
  const calls = []
  const queue = createCompletionQueue((value) => {
    calls.push(value)
    return 'saved'
  })

  queue.add(session)

  assert.deepEqual(calls, [session])
  assert.equal(queue.hasUnsaved(), true)

  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(calls.length, 1)
})

test('duplicate IDs never replace or resave the original session', async () => {
  const original = Object.freeze({ id: 'duplicate', result: 'original' })
  const replacement = { id: 'duplicate', result: 'replacement' }
  const pending = deferred()
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return pending.promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(original)
  queue.add(original)
  queue.add(replacement)

  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0], original)
  assert.equal(notifications.length, 1)

  pending.reject(new Error('save failed'))
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications.at(-1), [
    { session: original, status: 'error' },
  ])

  queue.add(replacement)
  assert.equal(calls.length, 1)
  assert.equal(notifications.length, 2)
})

test('synchronous save exceptions become retryable errors', async () => {
  const session = { id: 'throws' }
  const notifications = []
  let attempts = 0
  const queue = createCompletionQueue(
    (value) => {
      assert.strictEqual(value, session)
      attempts += 1
      if (attempts === 1) throw new Error('temporary failure')
    },
    (snapshot) => notifications.push(snapshot),
  )

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(
    notifications.map((snapshot) => snapshot[0].status),
    ['saving', 'error'],
  )

  await queue.retry()

  assert.equal(attempts, 2)
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(
    notifications.map((snapshot) => snapshot[0].status),
    ['saving', 'error', 'saving', 'saved'],
  )

  queue.add({ id: session.id, result: 'replacement' })
  await queue.retry()

  assert.equal(attempts, 2)
  assert.equal(notifications.length, 4)
})

test('repeated asynchronous failures retain the same session and ID', async () => {
  const session = Object.freeze({ id: 'retry-me', result: 'immutable' })
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    async (value) => {
      calls.push(value)
      if (calls.length <= 2) throw new Error('temporary failure')
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(session)
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.equal(notifications.at(-1)[0].status, 'error')

  await assert.doesNotReject(queue.retry())
  assert.equal(queue.hasUnsaved(), true)
  assert.equal(notifications.at(-1)[0].status, 'error')

  await assert.doesNotReject(queue.retry())
  assert.equal(queue.hasUnsaved(), false)

  assert.equal(calls.length, 3)
  for (const value of calls) {
    assert.strictEqual(value, session)
    assert.equal(value.id, 'retry-me')
  }
  assert.deepEqual(
    notifications.map((snapshot) => snapshot[0].status),
    ['saving', 'error', 'saving', 'error', 'saving', 'saved'],
  )

  await queue.retry()
  assert.equal(calls.length, 3)
  assert.equal(notifications.length, 6)
})

test('distinct sessions save independently and remain in insertion order', async () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  const firstSave = deferred()
  const secondSave = deferred()
  const calls = []
  const notifications = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return session === first ? firstSave.promise : secondSave.promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(first)
  queue.add(second)

  assert.deepEqual(calls, [first, second])
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saving' },
    { session: second, status: 'saving' },
  ])

  secondSave.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saving' },
    { session: second, status: 'saved' },
  ])

  firstSave.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
  ])

  const third = { id: 'third' }
  queue.add(third)
  await flush()

  assert.deepEqual(calls, [first, second, third])
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
    { session: third, status: 'saved' },
  ])
  assert.equal(queue.hasUnsaved(), false)
})

test('retry selects only errors and overlapping retries do not duplicate saves', async () => {
  const failed = { id: 'failed' }
  const saving = { id: 'saving' }
  const saved = { id: 'saved' }
  const activeSave = deferred()
  const retriedSave = deferred()
  const calls = []
  const notifications = []
  let failedAttempts = 0
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      if (session === saving) return activeSave.promise
      if (session === failed) {
        failedAttempts += 1
        if (failedAttempts === 1) return Promise.reject(new Error('failed'))
        return retriedSave.promise
      }
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(failed)
  queue.add(saving)
  queue.add(saved)
  await flush()

  assert.deepEqual(notifications.at(-1), [
    { session: failed, status: 'error' },
    { session: saving, status: 'saving' },
    { session: saved, status: 'saved' },
  ])

  const retry = queue.retry()
  const notificationCount = notifications.length

  assert.deepEqual(calls, [failed, saving, saved, failed])
  assert.equal(notifications.at(-1)[0].status, 'saving')
  assert.deepEqual(await queue.retry(), [])
  assert.equal(notifications.length, notificationCount)
  assert.equal(failedAttempts, 2)

  retriedSave.resolve()
  await retry()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(await queue.retry(), [])
  assert.deepEqual(calls, [failed, saving, saved, failed])

  activeSave.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
})

test('retry waits for every selected save and absorbs individual failures', async () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  const retries = new Map([
    [first, deferred()],
    [second, deferred()],
  ])
  const attempts = new Map()
  const notifications = []
  const queue = createCompletionQueue(
    (session) => {
      const count = (attempts.get(session) ?? 0) + 1
      attempts.set(session, count)
      if (count === 1) return Promise.reject(new Error('initial failure'))
      return retries.get(session).promise
    },
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(first)
  queue.add(second)
  await flush()

  let settled = false
  const retry = queue.retry().then((result) => {
    settled = true
    return result
  })

  assert.equal(attempts.get(first), 2)
  assert.equal(attempts.get(second), 2)

  retries.get(first).resolve()
  await flush()

  assert.equal(settled, false)
  assert.equal(queue.hasUnsaved(), true)

  retries.get(second).reject(new Error('retry failed'))
  await assert.doesNotReject(retry)

  assert.equal(settled, true)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(notifications.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'error' },
  ])
})

test('mutating notification containers and status fields cannot alter queue state', async () => {
  const session = { id: 'snapshot' }
  const pending = deferred()
  const notifications = []
  const queue = createCompletionQueue(
    () => pending.promise,
    (snapshot) => notifications.push(snapshot),
  )

  queue.add(session)

  notifications[0][0].status = 'saved'
  notifications[0].push({ session: { id: 'injected' }, status: 'error' })

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(await queue.retry(), [])

  pending.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(notifications[1], [{ session, status: 'saved' }])

  notifications[1][0].status = 'error'
  notifications[1].length = 0

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(notifications.length, 2)
})
