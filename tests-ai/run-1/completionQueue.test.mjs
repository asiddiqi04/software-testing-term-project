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
  const changes = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => changes.push(snapshot),
  )

  assert.equal(queue.hasUnsaved(), false)
  const retry = queue.retry()
  assert.ok(retry instanceof Promise)
  assert.deepEqual(await retry, [])
  assert.deepEqual(calls, [])
  assert.deepEqual(changes, [])
})

test('falsy sessions are ignored without saving or notifying', async () => {
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => changes.push(snapshot),
  )

  for (const value of [undefined, null, false, 0, '', NaN]) {
    queue.add(value)
  }

  await flush()
  assert.deepEqual(calls, [])
  assert.deepEqual(changes, [])
  assert.equal(queue.hasUnsaved(), false)
})

test('add immediately saves the original session and reports saving then saved', async () => {
  const pending = deferred()
  const session = Object.freeze({ id: 'first', result: 'complete' })
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (value) => {
      calls.push(value)
      return pending.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)

  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0], session)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes, [[{ session, status: 'saving' }]])

  pending.resolve()
  await flush()

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes, [
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])
  assert.strictEqual(changes[1][0].session, session)
  assert.notStrictEqual(changes[0], changes[1])
  assert.notStrictEqual(changes[0][0], changes[1][0])
})

test('onChange is optional and synchronous saves are supported', async () => {
  const session = { id: 'sync' }
  const calls = []
  const queue = createCompletionQueue((value) => {
    calls.push(value)
  })

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  await flush()

  assert.deepEqual(calls, [session])
  assert.equal(queue.hasUnsaved(), false)
  await queue.retry()
  assert.equal(calls.length, 1)
})

test('a rejected save becomes an error and retry preserves the session and ID', async () => {
  const first = deferred()
  const second = deferred()
  const session = Object.freeze({ id: 'retry-me', result: 42 })
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (value) => {
      calls.push(value)
      return calls.length === 1 ? first.promise : second.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)
  first.reject(new Error('offline'))
  await flush()

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [{ session, status: 'error' }])

  const retry = queue.retry()
  assert.equal(calls.length, 2)
  assert.strictEqual(calls[0], session)
  assert.strictEqual(calls[1], session)
  assert.equal(calls[1].id, 'retry-me')
  assert.deepEqual(changes.at(-1), [{ session, status: 'saving' }])

  second.resolve()
  await retry

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.map(([entry]) => entry.status), [
    'saving',
    'error',
    'saving',
    'saved',
  ])

  await queue.retry()
  assert.equal(calls.length, 2)
  assert.equal(changes.length, 4)
})

test('synchronous throws and repeated retry failures are caught', async () => {
  const session = { id: 'throws' }
  const changes = []
  let attempts = 0
  const queue = createCompletionQueue(
    () => {
      attempts += 1
      if (attempts < 3) throw new Error('save failed')
    },
    (snapshot) => changes.push(snapshot),
  )

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.map(([entry]) => entry.status), ['saving', 'error'])

  await assert.doesNotReject(queue.retry())
  assert.equal(attempts, 2)
  assert.equal(queue.hasUnsaved(), true)
  assert.equal(changes.at(-1)[0].status, 'error')

  await queue.retry()
  assert.equal(attempts, 3)
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.map(([entry]) => entry.status), [
    'saving',
    'error',
    'saving',
    'error',
    'saving',
    'saved',
  ])
})

test('duplicate IDs are ignored while saving, after failure, and after success', async () => {
  const first = deferred()
  const second = deferred()
  const original = Object.freeze({ id: 'duplicate', result: 'original' })
  const replacement = { id: 'duplicate', result: 'replacement' }
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return calls.length === 1 ? first.promise : second.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  const checkDuplicate = () => {
    const callCount = calls.length
    const changeCount = changes.length
    queue.add(original)
    queue.add(replacement)
    assert.equal(calls.length, callCount)
    assert.equal(changes.length, changeCount)
    assert.strictEqual(changes.at(-1)[0].session, original)
  }

  queue.add(original)
  checkDuplicate()

  first.reject(new Error('try again'))
  await flush()
  checkDuplicate()

  const retry = queue.retry()
  checkDuplicate()
  second.resolve()
  await retry
  checkDuplicate()

  assert.equal(calls.length, 2)
  assert.ok(calls.every((session) => session === original))
  assert.equal(queue.hasUnsaved(), false)
})

test('distinct IDs save independently and snapshots retain insertion order', async () => {
  const first = deferred()
  const second = deferred()
  const a = Object.freeze({ id: 'a', result: 'round one' })
  const b = Object.freeze({ id: 'b', result: 'round two' })
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      calls.push(session)
      return session.id === 'a' ? first.promise : second.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(a)
  queue.add(b)
  assert.deepEqual(calls, [a, b])
  assert.deepEqual(changes.at(-1), [
    { session: a, status: 'saving' },
    { session: b, status: 'saving' },
  ])

  second.resolve()
  await flush()
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: a, status: 'saving' },
    { session: b, status: 'saved' },
  ])

  first.resolve()
  await flush()
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.at(-1), [
    { session: a, status: 'saved' },
    { session: b, status: 'saved' },
  ])

  const c = Object.freeze({ id: 'c', result: 'round three' })
  queue.add(c)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: a, status: 'saved' },
    { session: b, status: 'saved' },
    { session: c, status: 'saving' },
  ])
  await flush()
  assert.equal(queue.hasUnsaved(), false)
  assert.strictEqual(changes.at(-1)[0].session, a)
  assert.strictEqual(changes.at(-1)[1].session, b)
})

test('retry only retries errors, prevents overlapping attempts, and awaits all retries', async () => {
  const sessions = ['saved', 'saving', 'error-a', 'error-b'].map((id) => ({ id }))
  const attempts = new Map()
  const initial = new Map(sessions.map(({ id }) => [id, deferred()]))
  const retried = new Map([
    ['error-a', deferred()],
    ['error-b', deferred()],
  ])
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      const count = (attempts.get(session.id) ?? 0) + 1
      attempts.set(session.id, count)
      return count === 1
        ? initial.get(session.id).promise
        : retried.get(session.id).promise
    },
    (snapshot) => changes.push(snapshot),
  )

  sessions.forEach((session) => queue.add(session))
  initial.get('saved').resolve()
  initial.get('error-a').reject(new Error('a failed'))
  initial.get('error-b').reject(new Error('b failed'))
  await flush()

  let retrySettled = false
  const retry = queue.retry().then(() => {
    retrySettled = true
  })

  assert.deepEqual([...attempts], [
    ['saved', 1],
    ['saving', 1],
    ['error-a', 2],
    ['error-b', 2],
  ])

  const changeCount = changes.length
  assert.deepEqual(await queue.retry(), [])
  assert.equal(changes.length, changeCount)
  assert.equal(retrySettled, false)
  assert.equal(attempts.get('error-a'), 2)
  assert.equal(attempts.get('error-b'), 2)

  retried.get('error-a').resolve()
  await flush()
  assert.equal(retrySettled, false)
  assert.equal(queue.hasUnsaved(), true)

  retried.get('error-b').resolve()
  await retry
  assert.equal(retrySettled, true)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1).map(({ status }) => status), [
    'saved',
    'saving',
    'saved',
    'saved',
  ])

  initial.get('saving').resolve()
  await flush()
  assert.equal(queue.hasUnsaved(), false)
  assert.ok(changes.at(-1).every(({ status }) => status === 'saved'))
})
