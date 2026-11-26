import test from 'node:test'
import assert from 'node:assert/strict'
import {
  comboLibrary,
  comboToKey,
  pickRandomCombo,
  initialComboStats,
  releaseComboIfReady,
  applyPunchToCombo,
} from '../../frontend/src/training/comboService.js'

const WALL_NOW = Date.UTC(2025, 0, 2, 3, 4, 5, 678)
const DETECTED_AT = new Date(WALL_NOW).toISOString()

function makeState(overrides = {}) {
  const state = {
    currentCombo: ['jab', 'cross'],
    comboStepIndex: 0,
    comboLockedUntil: null,
    comboResult: 'idle',
    comboStats: initialComboStats(),
    lastPunchEvent: null,
    extra: 'preserved',
    ...overrides,
  }

  Object.freeze(state.currentCombo)
  Object.freeze(state.comboStats)
  return Object.freeze(state)
}

function makePunch(type = 'jab') {
  return Object.freeze({ type, side: 'left', score: 0.92 })
}

function makeOptions(overrides = {}) {
  return {
    nowMs: 1000,
    wallNowMs: WALL_NOW,
    id: 'event-1',
    ...overrides,
  }
}

function sequenceRandom(values) {
  let calls = 0
  return {
    random() {
      assert.ok(calls < values.length, 'unexpected extra random call')
      return values[calls++]
    },
    get calls() {
      return calls
    },
  }
}

function unexpectedRandom() {
  assert.fail('random must not be called')
}

test('comboLibrary contains the expected combinations', () => {
  assert.deepEqual(comboLibrary, [
    ['jab', 'cross'],
    ['jab', 'cross', 'hook'],
    ['uppercut', 'hook'],
    ['jab', 'jab', 'cross'],
    ['cross', 'hook', 'uppercut'],
  ])
})

test('comboToKey joins steps in order without mutating its input', () => {
  assert.equal(comboToKey([]), '')
  assert.equal(comboToKey(['jab']), 'jab')
  assert.equal(comboToKey(['jab', 'jab', 'cross']), 'jab-jab-cross')

  const combo = Object.freeze(['uppercut', 'hook'])
  assert.equal(comboToKey(combo), 'uppercut-hook')
  assert.deepEqual(combo, ['uppercut', 'hook'])
})

test('pickRandomCombo maps random bucket boundaries to library entries', () => {
  const samples = [
    [0, 0],
    [0.199999, 0],
    [0.2, 1],
    [0.399999, 1],
    [0.4, 2],
    [0.599999, 2],
    [0.6, 3],
    [0.799999, 3],
    [0.8, 4],
    [1 - Number.EPSILON, 4],
  ]

  for (const [value, index] of samples) {
    const rng = sequenceRandom([value])
    const result = pickRandomCombo([], rng.random)
    assert.deepEqual(result, comboLibrary[index])
    assert.notStrictEqual(result, comboLibrary[index])
    assert.equal(rng.calls, 1)
  }
})

test('pickRandomCombo uses default arguments and Math.random', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.45)
  assert.deepEqual(pickRandomCombo(), comboLibrary[2])
  assert.equal(random.mock.callCount(), 1)
})

test('pickRandomCombo retries equal combinations by value', () => {
  const previous = Object.freeze(['jab', 'cross'])
  const rng = sequenceRandom([0, 0.1, 0.25])

  assert.deepEqual(pickRandomCombo(previous, rng.random), comboLibrary[1])
  assert.equal(rng.calls, 3)
  assert.deepEqual(previous, ['jab', 'cross'])
})

test('pickRandomCombo limits retries to twelve after the initial draw', () => {
  const previous = Object.freeze([...comboLibrary[0]])
  const rng = sequenceRandom(Array(13).fill(0))

  const result = pickRandomCombo(previous, rng.random)

  assert.equal(rng.calls, 13)
  assert.deepEqual(result, previous)
  assert.notStrictEqual(result, previous)
  assert.notStrictEqual(result, comboLibrary[0])
})

test('pickRandomCombo accepts a different combo on the final allowed retry', () => {
  const rng = sequenceRandom([...Array(12).fill(0), 0.85])

  assert.deepEqual(
    pickRandomCombo([...comboLibrary[0]], rng.random),
    comboLibrary[4],
  )
  assert.equal(rng.calls, 13)
})

test('pickRandomCombo returns an independently mutable copy', () => {
  const original = [...comboLibrary[0]]
  const result = pickRandomCombo([], () => 0)

  result[0] = 'changed'
  result.push('extra')

  assert.deepEqual(comboLibrary[0], original)
})

test('pickRandomCombo handles a singleton library without retrying', () => {
  const original = [...comboLibrary]

  try {
    comboLibrary.splice(0, comboLibrary.length, original[0])
    const rng = sequenceRandom([0])

    const result = pickRandomCombo([...original[0]], rng.random)

    assert.deepEqual(result, original[0])
    assert.notStrictEqual(result, original[0])
    assert.equal(rng.calls, 1)
  } finally {
    comboLibrary.splice(0, comboLibrary.length, ...original)
  }
})

test('initialComboStats returns fresh, independent zeroed objects', () => {
  const first = initialComboStats()
  const second = initialComboStats()

  assert.deepEqual(first, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(second, first)
  assert.notStrictEqual(first, second)

  first.succeeded = 7
  first.failed = 3
  first.total = 10
  assert.deepEqual(second, { succeeded: 0, failed: 0, total: 0 })
})

test('releaseComboIfReady preserves identity when there is no truthy lock', () => {
  for (const comboLockedUntil of [undefined, null, 0, false]) {
    const state = makeState({ comboLockedUntil })

    assert.strictEqual(
      releaseComboIfReady(state, 1000, unexpectedRandom),
      state,
    )
  }
})

test('releaseComboIfReady preserves an unexpired lock and consumes no randomness', () => {
  const state = makeState({
    comboLockedUntil: 1001,
    comboResult: 'success',
    comboStepIndex: 2,
  })

  assert.strictEqual(
    releaseComboIfReady(state, 1000, unexpectedRandom),
    state,
  )
})

test('releaseComboIfReady releases at and after the deadline', () => {
  for (const nowMs of [1000, 1500]) {
    const lastPunchEvent = Object.freeze({ id: 'old-event' })
    const state = makeState({
      comboLockedUntil: 1000,
      comboStepIndex: 2,
      comboResult: 'success',
      comboStats: { succeeded: 3, failed: 2, total: 5 },
      lastPunchEvent,
    })

    const result = releaseComboIfReady(state, nowMs, () => 0.45)

    assert.deepEqual(result, {
      ...state,
      currentCombo: ['uppercut', 'hook'],
      comboStepIndex: 0,
      comboLockedUntil: null,
      comboResult: 'idle',
    })
    assert.notStrictEqual(result, state)
    assert.notStrictEqual(result.currentCombo, comboLibrary[2])
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.lastPunchEvent, lastPunchEvent)
  }
})

test('releaseComboIfReady uses Math.random when no generator is supplied', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.85)
  const state = makeState({ comboLockedUntil: 1000 })

  assert.deepEqual(
    releaseComboIfReady(state, 1000).currentCombo,
    comboLibrary[4],
  )
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo advances a matching intermediate step and records the event', () => {
  const state = makeState()
  const punch = makePunch()
  const result = applyPunchToCombo(
    state,
    punch,
    makeOptions({ random: unexpectedRandom }),
  )

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 1,
    comboResult: 'active',
    lastPunchEvent: {
      id: 'event-1',
      punch: 'jab',
      side: 'left',
      score: 0.92,
      expected: 'jab',
      expectedIndex: 0,
      matched: true,
      comboLocked: false,
      detectedAt: DETECTED_AT,
    },
  })
  assert.notStrictEqual(result, state)
  assert.strictEqual(result.currentCombo, state.currentCombo)
  assert.strictEqual(result.comboStats, state.comboStats)
})

test('applyPunchToCombo matches by type even with a different side and zero score', () => {
  const state = makeState({ currentCombo: ['jab', 'jab', 'cross'] })
  const punch = Object.freeze({ type: 'jab', side: 'right', score: 0 })

  const result = applyPunchToCombo(state, punch, makeOptions())

  assert.equal(result.comboStepIndex, 1)
  assert.equal(result.comboResult, 'active')
  assert.equal(result.lastPunchEvent.matched, true)
  assert.equal(result.lastPunchEvent.side, 'right')
  assert.equal(result.lastPunchEvent.score, 0)
})

test('applyPunchToCombo completes a combo, increments success, and applies the default lock', () => {
  const state = makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: { succeeded: 4, failed: 2, total: 999 },
  })

  const result = applyPunchToCombo(state, makePunch('cross'), makeOptions())

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 2,
    comboResult: 'success',
    comboLockedUntil: 1850,
    comboStats: { succeeded: 5, failed: 2, total: 7 },
    lastPunchEvent: {
      id: 'event-1',
      punch: 'cross',
      side: 'left',
      score: 0.92,
      expected: 'cross',
      expectedIndex: 1,
      matched: true,
      comboLocked: false,
      detectedAt: DETECTED_AT,
    },
  })
  assert.notStrictEqual(result.comboStats, state.comboStats)
  assert.strictEqual(result.currentCombo, state.currentCombo)
})

test('applyPunchToCombo completes a one-step combo using a custom lock delay', () => {
  const result = applyPunchToCombo(
    makeState({ currentCombo: ['hook'] }),
    makePunch('hook'),
    makeOptions({ lockDelayMs: 125 }),
  )

  assert.equal(result.comboStepIndex, 1)
  assert.equal(result.comboResult, 'success')
  assert.equal(result.comboLockedUntil, 1125)
  assert.deepEqual(result.comboStats, { succeeded: 1, failed: 0, total: 1 })
})

test('applyPunchToCombo fails mismatches at the first or a later step', () => {
  for (const comboStepIndex of [0, 1]) {
    const state = makeState({
      comboStepIndex,
      comboResult: 'active',
      comboStats: { succeeded: 4, failed: 2, total: 999 },
    })

    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ lockDelayMs: 250 }),
    )

    assert.deepEqual(result, {
      ...state,
      comboStepIndex: 0,
      comboResult: 'failed',
      comboLockedUntil: 1250,
      comboStats: { succeeded: 4, failed: 3, total: 7 },
      lastPunchEvent: {
        id: 'event-1',
        punch: 'uppercut',
        side: 'left',
        score: 0.92,
        expected: state.currentCombo[comboStepIndex],
        expectedIndex: comboStepIndex,
        matched: false,
        comboLocked: false,
        detectedAt: DETECTED_AT,
      },
    })
    assert.notStrictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.currentCombo, state.currentCombo)
  }
})

test('applyPunchToCombo uses the default lock delay after failure', () => {
  const result = applyPunchToCombo(
    makeState(),
    makePunch('hook'),
    makeOptions(),
  )

  assert.equal(result.comboResult, 'failed')
  assert.equal(result.comboLockedUntil, 1850)
})

test('applyPunchToCombo records punches during a lock without changing progress or stats', () => {
  for (const comboStepIndex of [0, 2]) {
    const state = makeState({
      comboStepIndex,
      comboLockedUntil: 1001,
      comboResult: comboStepIndex === 0 ? 'failed' : 'success',
      comboStats: { succeeded: 3, failed: 2, total: 5 },
      lastPunchEvent: { id: 'old-event' },
    })

    const result = applyPunchToCombo(
      state,
      makePunch('jab'),
      makeOptions({ random: unexpectedRandom }),
    )

    assert.deepEqual(result, {
      ...state,
      lastPunchEvent: {
        id: 'event-1',
        punch: 'jab',
        side: 'left',
        score: 0.92,
        expected: comboStepIndex === 0 ? 'jab' : null,
        expectedIndex: comboStepIndex,
        matched: false,
        comboLocked: true,
        detectedAt: DETECTED_AT,
      },
    })
    assert.notStrictEqual(result, state)
    assert.strictEqual(result.currentCombo, state.currentCombo)
    assert.strictEqual(result.comboStats, state.comboStats)
  }
})

test('applyPunchToCombo releases an expired lock before matching the incoming punch', () => {
  for (const nowMs of [1000, 1200]) {
    const state = makeState({
      comboStepIndex: 2,
      comboLockedUntil: 1000,
      comboResult: 'success',
      comboStats: { succeeded: 1, failed: 0, total: 1 },
    })
    const rng = sequenceRandom([0, 0.45])

    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ nowMs, random: rng.random }),
    )

    assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
    assert.equal(result.comboStepIndex, 1)
    assert.equal(result.comboResult, 'active')
    assert.equal(result.comboLockedUntil, null)
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.equal(result.lastPunchEvent.expected, 'uppercut')
    assert.equal(result.lastPunchEvent.expectedIndex, 0)
    assert.equal(result.lastPunchEvent.matched, true)
    assert.equal(result.lastPunchEvent.comboLocked, false)
    assert.equal(rng.calls, 2)
  }
})

test('applyPunchToCombo can fail immediately against a newly released combo', () => {
  const state = makeState({
    comboLockedUntil: 1000,
    comboResult: 'failed',
    comboStats: { succeeded: 1, failed: 2, total: 3 },
  })

  const result = applyPunchToCombo(
    state,
    makePunch('jab'),
    makeOptions({ random: () => 0.45, lockDelayMs: 100 }),
  )

  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.comboStepIndex, 0)
  assert.equal(result.comboResult, 'failed')
  assert.equal(result.comboLockedUntil, 1100)
  assert.deepEqual(result.comboStats, { succeeded: 1, failed: 3, total: 4 })
  assert.equal(result.lastPunchEvent.expected, 'uppercut')
  assert.equal(result.lastPunchEvent.expectedIndex, 0)
  assert.equal(result.lastPunchEvent.matched, false)
  assert.equal(result.lastPunchEvent.comboLocked, false)
})

test('applyPunchToCombo treats a missing expected step as a failure', () => {
  for (const overrides of [
    { currentCombo: [] },
    { comboStepIndex: 2 },
    { comboStepIndex: 10 },
  ]) {
    const state = makeState(overrides)
    const result = applyPunchToCombo(state, makePunch(), makeOptions())

    assert.equal(result.lastPunchEvent.expected, null)
    assert.equal(result.lastPunchEvent.expectedIndex, state.comboStepIndex)
    assert.equal(result.lastPunchEvent.matched, false)
    assert.equal(result.comboStepIndex, 0)
    assert.equal(result.comboResult, 'failed')
    assert.equal(result.comboLockedUntil, 1850)
    assert.deepEqual(result.comboStats, { succeeded: 0, failed: 1, total: 1 })
  }
})

test('applyPunchToCombo preserves zero times, zero delay, and an empty explicit id', () => {
  for (const type of ['jab', 'hook']) {
    const result = applyPunchToCombo(
      makeState({ currentCombo: ['jab'] }),
      makePunch(type),
      {
        nowMs: 0,
        wallNowMs: 0,
        lockDelayMs: 0,
        id: '',
        random: unexpectedRandom,
      },
    )

    assert.equal(result.comboLockedUntil, 0)
    assert.equal(result.lastPunchEvent.id, '')
    assert.equal(result.lastPunchEvent.detectedAt, '1970-01-01T00:00:00.000Z')
    assert.equal(result.comboResult, type === 'jab' ? 'success' : 'failed')
  }
})

test('applyPunchToCombo generates an id from the injected clock and random source', () => {
  const value = 0.123456789
  const rng = sequenceRandom([value])

  const result = applyPunchToCombo(makeState(), makePunch(), {
    nowMs: 1234,
    wallNowMs: WALL_NOW,
    random: rng.random,
  })

  assert.equal(
    result.lastPunchEvent.id,
    `1234-${value.toString(36).slice(2, 8)}`,
  )
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
  assert.equal(rng.calls, 1)
})

test('applyPunchToCombo generates the id before drawing a replacement combo', () => {
  const rng = sequenceRandom([0.5, 0.45])
  const state = makeState({
    comboStepIndex: 2,
    comboLockedUntil: 1000,
    comboResult: 'success',
  })

  const result = applyPunchToCombo(state, makePunch('uppercut'), {
    nowMs: 1000,
    wallNowMs: WALL_NOW,
    random: rng.random,
  })

  assert.equal(result.lastPunchEvent.id, '1000-i')
  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.lastPunchEvent.matched, true)
  assert.equal(rng.calls, 2)
})

test('applyPunchToCombo supports omitted options with default clocks and randomness', (t) => {
  const times = [2000, WALL_NOW]
  let clockCalls = 0
  t.mock.method(Date, 'now', () => {
    assert.ok(clockCalls < times.length, 'unexpected extra clock call')
    return times[clockCalls++]
  })
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(
    makeState({ currentCombo: ['jab'] }),
    makePunch(),
  )

  assert.equal(result.comboResult, 'success')
  assert.equal(result.comboLockedUntil, 2850)
  assert.equal(result.lastPunchEvent.id, '2000-i')
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
  assert.equal(clockCalls, 2)
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo treats null option values as requests for defaults', (t) => {
  t.mock.method(Date, 'now', () => WALL_NOW)
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(
    makeState({ currentCombo: ['jab'] }),
    makePunch(),
    {
      nowMs: null,
      wallNowMs: null,
      lockDelayMs: null,
      id: null,
    },
  )

  assert.equal(result.comboLockedUntil, WALL_NOW + 850)
  assert.equal(result.lastPunchEvent.id, `${WALL_NOW}-i`)
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
  assert.equal(random.mock.callCount(), 1)
})
