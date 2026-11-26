import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletionQueue } from '../../frontend/src/lib/completionQueue.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a new queue has no unsaved entries and retry does nothing', async () => {
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => changes.push(snapshot),
  )

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(await queue.retry(), [])
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(changes, [])
})

test('add ignores absent and falsy sessions', async () => {
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => calls.push(session),
    (snapshot) => changes.push(snapshot),
  )

  queue.add()
  for (const session of [undefined, null, false, 0, '', NaN]) {
    queue.add(session)
  }

  await queue.retry()
  assert.deepEqual(calls, [])
  assert.deepEqual(changes, [])
  assert.equal(queue.hasUnsaved(), false)
})

test('add immediately starts saving and reports saving followed by saved', async () => {
  const gate = deferred()
  const session = Object.freeze({ id: 'one', result: 'completed' })
  const calls = []
  const changes = []
  let queue

  queue = createCompletionQueue(
    (value) => {
      assert.equal(queue.hasUnsaved(), true)
      assert.deepEqual(changes, [[{ session, status: 'saving' }]])
      calls.push(value)
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)

  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0], session)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes, [[{ session, status: 'saving' }]])

  gate.resolve('ignored save result')
  await gate.promise

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes, [
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])

  await queue.retry()
  assert.equal(calls.length, 1)
  assert.equal(changes.length, 2)
})

test('the default onChange works with a synchronous save function', async () => {
  const calls = []
  const session = { id: 'sync' }
  const queue = createCompletionQueue((value) => {
    calls.push(value)
    return 42
  })

  queue.add(session)

  assert.deepEqual(calls, [session])
  assert.equal(queue.hasUnsaved(), true)

  await Promise.resolve()

  assert.equal(queue.hasUnsaved(), false)
  await queue.retry()
  assert.equal(calls.length, 1)
})

test('a synchronous save exception becomes an error and can be retried', async () => {
  const session = Object.freeze({ id: 'throws' })
  const calls = []
  const changes = []
  const queue = createCompletionQueue(
    (value) => {
      calls.push(value)
      if (calls.length === 1) throw new Error('save failed')
    },
    (snapshot) => changes.push(snapshot),
  )

  assert.doesNotThrow(() => queue.add(session))
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes, [
    [{ session, status: 'saving' }],
    [{ session, status: 'error' }],
  ])

  await queue.retry()

  assert.equal(calls.length, 2)
  assert.strictEqual(calls[0], session)
  assert.strictEqual(calls[1], session)
  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes, [
    [{ session, status: 'saving' }],
    [{ session, status: 'error' }],
    [{ session, status: 'saving' }],
    [{ session, status: 'saved' }],
  ])
})

test('asynchronous failures can be retried repeatedly with the original session', async () => {
  const session = Object.freeze({ id: 'retry', result: 'original' })
  const attempts = []
  const changes = []
  const queue = createCompletionQueue(
    (value) => {
      const gate = deferred()
      attempts.push({ session: value, gate })
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)
  attempts[0].gate.reject(new Error('first failure'))
  await Promise.resolve()

  assert.equal(queue.hasUnsaved(), true)
  assert.equal(changes.at(-1)[0].status, 'error')

  const firstRetry = queue.retry()
  assert.equal(attempts.length, 2)
  assert.equal(changes.at(-1)[0].status, 'saving')

  attempts[1].gate.reject(undefined)
  await firstRetry

  assert.equal(queue.hasUnsaved(), true)
  assert.equal(changes.at(-1)[0].status, 'error')

  const secondRetry = queue.retry()
  attempts[2].gate.resolve()
  await secondRetry

  assert.equal(queue.hasUnsaved(), false)
  assert.equal(attempts.length, 3)
  for (const attempt of attempts) {
    assert.strictEqual(attempt.session, session)
    assert.equal(attempt.session.id, 'retry')
  }
  assert.deepEqual(
    changes.map((snapshot) => snapshot[0].status),
    ['saving', 'error', 'saving', 'error', 'saving', 'saved'],
  )
})

test('duplicate IDs are ignored while saving, after failure, and after success', async () => {
  const original = Object.freeze({ id: 'same', result: 'original' })
  const replacement = { id: 'same', result: 'replacement' }
  const attempts = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      const gate = deferred()
      attempts.push({ session, gate })
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(original)
  queue.add(original)
  queue.add(replacement)

  assert.equal(attempts.length, 1)
  assert.equal(changes.length, 1)

  attempts[0].gate.reject(new Error('failed'))
  await Promise.resolve()

  queue.add(replacement)
  assert.equal(attempts.length, 1)
  assert.equal(changes.length, 2)
  assert.equal(queue.hasUnsaved(), true)

  const retry = queue.retry()
  assert.equal(attempts.length, 2)
  assert.strictEqual(attempts[1].session, original)

  queue.add(replacement)
  assert.equal(attempts.length, 2)
  assert.equal(changes.length, 3)

  attempts[1].gate.resolve()
  await retry

  queue.add(original)
  queue.add(replacement)
  await queue.retry()

  assert.equal(attempts.length, 2)
  assert.equal(changes.length, 4)
  assert.equal(queue.hasUnsaved(), false)
  for (const snapshot of changes) {
    assert.equal(snapshot.length, 1)
    assert.strictEqual(snapshot[0].session, original)
  }
})

test('distinct sessions save independently and remain in insertion order', async () => {
  const first = Object.freeze({ id: 'first' })
  const second = Object.freeze({ id: 'second' })
  const third = Object.freeze({ id: 'third' })
  const gates = new Map()
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      const gate = deferred()
      gates.set(session.id, gate)
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(first)
  queue.add(second)

  assert.equal(gates.size, 2)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saving' },
    { session: second, status: 'saving' },
  ])

  gates.get('second').resolve()
  await gates.get('second').promise

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saving' },
    { session: second, status: 'saved' },
  ])

  gates.get('first').resolve()
  await gates.get('first').promise
  assert.equal(queue.hasUnsaved(), false)

  queue.add(third)

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
    { session: third, status: 'saving' },
  ])

  gates.get('third').resolve()
  await gates.get('third').promise

  assert.equal(queue.hasUnsaved(), false)
  assert.deepEqual(changes.at(-1), [
    { session: first, status: 'saved' },
    { session: second, status: 'saved' },
    { session: third, status: 'saved' },
  ])
})

test('retry selects only errors and concurrent retries do not duplicate saves', async () => {
  const failed = { id: 'failed' }
  const saved = { id: 'saved' }
  const pending = { id: 'pending' }
  const attempts = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      const gate = deferred()
      attempts.push({ session, gate })
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  queue.add(failed)
  queue.add(saved)
  queue.add(pending)

  attempts[0].gate.reject(new Error('failed'))
  attempts[1].gate.resolve()
  await Promise.resolve()

  assert.deepEqual(changes.at(-1), [
    { session: failed, status: 'error' },
    { session: saved, status: 'saved' },
    { session: pending, status: 'saving' },
  ])

  const retry = queue.retry()

  assert.equal(attempts.length, 4)
  assert.strictEqual(attempts[3].session, failed)
  assert.equal(queue.hasUnsaved(), true)

  const notificationCount = changes.length
  await queue.retry()

  assert.equal(attempts.length, 4)
  assert.equal(changes.length, notificationCount)

  attempts[3].gate.resolve()
  await retry

  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: failed, status: 'saved' },
    { session: saved, status: 'saved' },
    { session: pending, status: 'saving' },
  ])

  attempts[2].gate.resolve()
  await attempts[2].gate.promise

  assert.equal(queue.hasUnsaved(), false)
  await queue.retry()
  assert.equal(attempts.length, 4)
})

test('retry starts all failed entries and waits for every attempt, including failures', async () => {
  const sessions = [{ id: 'a' }, { id: 'b' }]
  const attempts = []
  const changes = []
  const queue = createCompletionQueue(
    (session) => {
      const gate = deferred()
      attempts.push({ session, gate })
      return gate.promise
    },
    (snapshot) => changes.push(snapshot),
  )

  sessions.forEach((session) => queue.add(session))
  attempts[0].gate.reject(new Error('initial a failure'))
  attempts[1].gate.reject(new Error('initial b failure'))
  await Promise.resolve()

  const retry = queue.retry()
  let retrySettled = false
  const observedRetry = retry.then(() => {
    retrySettled = true
  })

  assert.equal(attempts.length, 4)
  assert.strictEqual(attempts[2].session, sessions[0])
  assert.strictEqual(attempts[3].session, sessions[1])

  attempts[2].gate.resolve()
  await attempts[2].gate.promise
  await Promise.resolve()

  assert.equal(retrySettled, false)
  assert.equal(queue.hasUnsaved(), true)

  attempts[3].gate.reject(new Error('retry b failure'))
  await observedRetry

  assert.equal(retrySettled, true)
  assert.equal(queue.hasUnsaved(), true)
  assert.deepEqual(changes.at(-1), [
    { session: sessions[0], status: 'saved' },
    { session: sessions[1], status: 'error' },
  ])

  const finalRetry = queue.retry()
  assert.equal(attempts.length, 5)
  assert.strictEqual(attempts[4].session, sessions[1])

  attempts[4].gate.resolve()
  await finalRetry

  assert.equal(queue.hasUnsaved(), false)
})

test('notifications use fresh arrays and entry wrappers without exposing queue status', async () => {
  const session = Object.freeze({ id: 'snapshot' })
  const gate = deferred()
  const changes = []
  const queue = createCompletionQueue(
    () => gate.promise,
    (snapshot) => changes.push(snapshot),
  )

  queue.add(session)

  const savingSnapshot = changes[0]
  const savingEntry = savingSnapshot[0]
  savingEntry.status = 'saved'
  savingEntry.session = { id: 'replacement' }
  savingSnapshot.push({ session: { id: 'extra' }, status: 'error' })

  assert.equal(queue.hasUnsaved(), true)

  gate.resolve()
  await gate.promise

  const savedSnapshot = changes[1]
  assert.notStrictEqual(savedSnapshot, savingSnapshot)
  assert.notStrictEqual(savedSnapshot[0], savingEntry)
  assert.deepEqual(savedSnapshot, [{ session, status: 'saved' }])
  assert.strictEqual(savedSnapshot[0].session, session)

  savedSnapshot[0].status = 'error'
  savedSnapshot.length = 0

  assert.equal(queue.hasUnsaved(), false)
  await queue.retry()
  assert.equal(changes.length, 2)
})

test('separate queues maintain independent state even for the same session ID', async () => {
  const session = { id: 'shared-id' }
  const firstGate = deferred()
  const secondGate = deferred()
  const firstCalls = []
  const secondCalls = []
  const first = createCompletionQueue((value) => {
    firstCalls.push(value)
    return firstGate.promise
  })
  const second = createCompletionQueue((value) => {
    secondCalls.push(value)
    return secondGate.promise
  })

  first.add(session)
  second.add(session)

  assert.deepEqual(firstCalls, [session])
  assert.deepEqual(secondCalls, [session])

  firstGate.resolve()
  await firstGate.promise

  assert.equal(first.hasUnsaved(), false)
  assert.equal(second.hasUnsaved(), true)

  secondGate.resolve()
  await secondGate.promise

  assert.equal(first.hasUnsaved(), false)
  assert.equal(second.hasUnsaved(), false)
})
