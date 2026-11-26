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

const WALL_NOW = 1_700_000_000_000
const DETECTED_AT = new Date(WALL_NOW).toISOString()

function makeState(overrides = {}) {
  return Object.freeze({
    currentCombo: Object.freeze(['jab', 'cross']),
    comboStepIndex: 0,
    comboLockedUntil: null,
    comboResult: 'idle',
    comboStats: Object.freeze({ succeeded: 2, failed: 3, total: 5 }),
    lastPunchEvent: null,
    unrelated: Object.freeze({ preserved: true }),
    ...overrides,
  })
}

function makePunch(type = 'jab') {
  return Object.freeze({ type, side: 'left', score: 0.92 })
}

function makeOptions(overrides = {}) {
  return {
    nowMs: 1000,
    wallNowMs: WALL_NOW,
    id: 'event-1',
    random: () => 0.4,
    ...overrides,
  }
}

function expectedEvent(overrides = {}) {
  return {
    id: 'event-1',
    punch: 'jab',
    side: 'left',
    score: 0.92,
    expected: 'jab',
    expectedIndex: 0,
    matched: true,
    comboLocked: false,
    detectedAt: DETECTED_AT,
    ...overrides,
  }
}

test('comboLibrary contains the supported combinations', () => {
  assert.deepEqual(comboLibrary, [
    ['jab', 'cross'],
    ['jab', 'cross', 'hook'],
    ['uppercut', 'hook'],
    ['jab', 'jab', 'cross'],
    ['cross', 'hook', 'uppercut'],
  ])
})

test('comboToKey joins punches without modifying the combination', () => {
  assert.equal(comboToKey([]), '')
  assert.equal(comboToKey(['jab']), 'jab')
  assert.equal(comboToKey(['jab', 'jab', 'cross']), 'jab-jab-cross')

  const combo = Object.freeze(['uppercut', 'hook'])
  assert.equal(comboToKey(combo), 'uppercut-hook')
  assert.deepEqual(combo, ['uppercut', 'hook'])
})

test('pickRandomCombo selects each library entry and returns a copy', () => {
  const originalLibrary = comboLibrary.map((combo) => [...combo])

  for (let index = 0; index < comboLibrary.length; index += 1) {
    let calls = 0
    const result = pickRandomCombo([], () => {
      calls += 1
      return (index + 0.5) / comboLibrary.length
    })

    assert.deepEqual(result, comboLibrary[index])
    assert.notStrictEqual(result, comboLibrary[index])
    assert.equal(calls, 1)

    result.push('changed')
    assert.deepEqual(comboLibrary, originalLibrary)
  }

  assert.deepEqual(pickRandomCombo([], () => 0), comboLibrary[0])
  assert.deepEqual(
    pickRandomCombo([], () => 1 - Number.EPSILON),
    comboLibrary.at(-1),
  )
})

test('pickRandomCombo defaults to an empty previous combo and Math.random', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.4)

  assert.deepEqual(pickRandomCombo(), comboLibrary[2])
  assert.equal(random.mock.callCount(), 1)
})

test('pickRandomCombo retries combinations matching the previous key', () => {
  const previous = Object.freeze([...comboLibrary[0]])
  const draws = [0, 0, 0.4]
  let calls = 0

  const result = pickRandomCombo(previous, () => {
    assert.ok(calls < draws.length, 'unexpected extra random draw')
    return draws[calls++]
  })

  assert.deepEqual(result, comboLibrary[2])
  assert.equal(calls, 3)
  assert.deepEqual(previous, comboLibrary[0])
})

test('pickRandomCombo stops after twelve retries even if all draws repeat', () => {
  let calls = 0
  const previous = [...comboLibrary[0]]

  const result = pickRandomCombo(previous, () => {
    calls += 1
    assert.ok(calls <= 13, 'retry limit exceeded')
    return 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, previous)
  assert.notStrictEqual(result, previous)
  assert.notStrictEqual(result, comboLibrary[0])
})

test('pickRandomCombo returns a copy without retrying a single-entry library', () => {
  const originalEntries = [...comboLibrary]

  try {
    comboLibrary.splice(1)
    let calls = 0

    const result = pickRandomCombo([...comboLibrary[0]], () => {
      calls += 1
      return 0
    })

    assert.equal(calls, 1)
    assert.deepEqual(result, comboLibrary[0])
    assert.notStrictEqual(result, comboLibrary[0])
  } finally {
    comboLibrary.splice(0, comboLibrary.length, ...originalEntries)
  }
})

test('initialComboStats returns independent zeroed objects', () => {
  const first = initialComboStats()
  const second = initialComboStats()

  assert.deepEqual(first, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(second, first)
  assert.notStrictEqual(first, second)

  first.succeeded = 10
  assert.deepEqual(second, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(initialComboStats(), second)
})

test('releaseComboIfReady preserves state identity when no lock is active', () => {
  for (const comboLockedUntil of [null, undefined, 0]) {
    const state = makeState({ comboLockedUntil })
    const result = releaseComboIfReady(state, 1000, () => {
      assert.fail('an unlocked state must not select a new combination')
    })

    assert.strictEqual(result, state)
  }
})

test('releaseComboIfReady preserves state before the lock deadline', () => {
  const state = makeState({ comboLockedUntil: 1001 })

  assert.strictEqual(
    releaseComboIfReady(state, 1000, () => {
      assert.fail('an unexpired lock must not select a new combination')
    }),
    state,
  )
})

test('releaseComboIfReady resets the combination at and after the deadline', () => {
  for (const nowMs of [1000, 1001]) {
    const previousEvent = Object.freeze({ id: 'previous' })
    const state = makeState({
      comboStepIndex: 2,
      comboLockedUntil: 1000,
      comboResult: 'success',
      lastPunchEvent: previousEvent,
    })

    const result = releaseComboIfReady(state, nowMs, () => 0.4)

    assert.notStrictEqual(result, state)
    assert.deepEqual(result, {
      ...state,
      currentCombo: comboLibrary[2],
      comboStepIndex: 0,
      comboLockedUntil: null,
      comboResult: 'idle',
    })
    assert.notStrictEqual(result.currentCombo, comboLibrary[2])
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.lastPunchEvent, previousEvent)
    assert.strictEqual(result.unrelated, state.unrelated)
    assert.equal(state.comboStepIndex, 2)
    assert.equal(state.comboLockedUntil, 1000)
  }
})

test('releaseComboIfReady uses Math.random by default', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.4)
  const state = makeState({ comboLockedUntil: 1000 })

  const result = releaseComboIfReady(state, 1000)

  assert.deepEqual(result.currentCombo, comboLibrary[2])
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo advances a matching nonfinal punch without changing stats', () => {
  const state = makeState()
  const punch = makePunch()

  const result = applyPunchToCombo(state, punch, makeOptions())

  assert.notStrictEqual(result, state)
  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 1,
    comboResult: 'active',
    lastPunchEvent: expectedEvent(),
  })
  assert.strictEqual(result.currentCombo, state.currentCombo)
  assert.strictEqual(result.comboStats, state.comboStats)
  assert.strictEqual(result.unrelated, state.unrelated)
  assert.equal(state.comboStepIndex, 0)
  assert.equal(state.lastPunchEvent, null)
  assert.deepEqual(punch, { type: 'jab', side: 'left', score: 0.92 })
})

test('applyPunchToCombo completes a combination and uses the default lock delay', () => {
  const state = makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: Object.freeze({ succeeded: 2, failed: 3, total: 999 }),
  })

  const result = applyPunchToCombo(state, makePunch('cross'), makeOptions())

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 2,
    comboStats: { succeeded: 3, failed: 3, total: 6 },
    comboResult: 'success',
    comboLockedUntil: 1850,
    lastPunchEvent: expectedEvent({
      punch: 'cross',
      expected: 'cross',
      expectedIndex: 1,
    }),
  })
  assert.notStrictEqual(result.comboStats, state.comboStats)
  assert.deepEqual(state.comboStats, { succeeded: 2, failed: 3, total: 999 })
})

test('applyPunchToCombo can complete a single-punch combination with a custom delay', () => {
  const state = makeState({ currentCombo: Object.freeze(['jab']) })

  const result = applyPunchToCombo(
    state,
    makePunch(),
    makeOptions({ lockDelayMs: 250 }),
  )

  assert.equal(result.comboStepIndex, 1)
  assert.equal(result.comboResult, 'success')
  assert.equal(result.comboLockedUntil, 1250)
  assert.deepEqual(result.comboStats, { succeeded: 3, failed: 3, total: 6 })
  assert.deepEqual(result.lastPunchEvent, expectedEvent())
})

test('applyPunchToCombo fails a wrong punch, resets progress, and updates totals', () => {
  const state = makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: Object.freeze({ succeeded: 2, failed: 3, total: 999 }),
  })

  const result = applyPunchToCombo(
    state,
    makePunch('hook'),
    makeOptions({ lockDelayMs: 300 }),
  )

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 0,
    comboStats: { succeeded: 2, failed: 4, total: 6 },
    comboResult: 'failed',
    comboLockedUntil: 1300,
    lastPunchEvent: expectedEvent({
      punch: 'hook',
      expected: 'cross',
      expectedIndex: 1,
      matched: false,
    }),
  })
  assert.notStrictEqual(result.comboStats, state.comboStats)
  assert.equal(state.comboStepIndex, 1)
  assert.deepEqual(state.comboStats, { succeeded: 2, failed: 3, total: 999 })
})

test('applyPunchToCombo matches by exact type regardless of side or score', () => {
  const result = applyPunchToCombo(
    makeState(),
    { type: 'jab', side: 'right', score: 0 },
    makeOptions(),
  )

  assert.equal(result.comboStepIndex, 1)
  assert.deepEqual(result.lastPunchEvent, expectedEvent({ side: 'right', score: 0 }))

  const wrongCase = applyPunchToCombo(
    makeState(),
    makePunch('Jab'),
    makeOptions(),
  )
  assert.equal(wrongCase.comboResult, 'failed')
  assert.equal(wrongCase.lastPunchEvent.matched, false)
})

test('applyPunchToCombo records locked punches without changing progress or stats', () => {
  for (const comboResult of ['success', 'failed']) {
    const state = makeState({
      comboResult,
      comboStepIndex: comboResult === 'success' ? 2 : 0,
      comboLockedUntil: 2000,
      lastPunchEvent: Object.freeze({ id: 'previous' }),
    })

    const result = applyPunchToCombo(state, makePunch(), makeOptions())

    assert.notStrictEqual(result, state)
    assert.deepEqual(result, {
      ...state,
      lastPunchEvent: expectedEvent({
        expected: comboResult === 'success' ? null : 'jab',
        expectedIndex: state.comboStepIndex,
        matched: false,
        comboLocked: true,
      }),
    })
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.currentCombo, state.currentCombo)
    assert.deepEqual(state.lastPunchEvent, { id: 'previous' })
  }
})

test('applyPunchToCombo releases an expired lock before evaluating the punch', () => {
  for (const nowMs of [1000, 1001]) {
    const state = makeState({
      comboStepIndex: 2,
      comboResult: 'success',
      comboLockedUntil: 1000,
    })

    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ nowMs }),
    )

    assert.deepEqual(result, {
      ...state,
      currentCombo: comboLibrary[2],
      comboStepIndex: 1,
      comboResult: 'active',
      comboLockedUntil: null,
      lastPunchEvent: expectedEvent({
        punch: 'uppercut',
        expected: 'uppercut',
      }),
    })
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.notStrictEqual(result.currentCombo, comboLibrary[2])
  }
})

test('applyPunchToCombo evaluates mismatches against the newly released combination', () => {
  const state = makeState({
    comboResult: 'failed',
    comboLockedUntil: 1000,
  })

  const result = applyPunchToCombo(state, makePunch('jab'), makeOptions())

  assert.deepEqual(result.currentCombo, comboLibrary[2])
  assert.equal(result.comboStepIndex, 0)
  assert.equal(result.comboResult, 'failed')
  assert.equal(result.comboLockedUntil, 1850)
  assert.deepEqual(result.comboStats, { succeeded: 2, failed: 4, total: 6 })
  assert.deepEqual(
    result.lastPunchEvent,
    expectedEvent({ expected: 'uppercut', matched: false }),
  )
})

test('applyPunchToCombo fails safely when no expected punch exists', () => {
  for (const state of [
    makeState({ currentCombo: Object.freeze([]) }),
    makeState({ comboStepIndex: 2 }),
  ]) {
    const result = applyPunchToCombo(state, makePunch(), makeOptions())

    assert.equal(result.comboResult, 'failed')
    assert.equal(result.comboStepIndex, 0)
    assert.equal(result.comboLockedUntil, 1850)
    assert.deepEqual(result.comboStats, { succeeded: 2, failed: 4, total: 6 })
    assert.deepEqual(
      result.lastPunchEvent,
      expectedEvent({
        expected: null,
        expectedIndex: state.comboStepIndex,
        matched: false,
      }),
    )
  }
})

test('applyPunchToCombo handles repeated punches in sequence', () => {
  let state = makeState({
    currentCombo: Object.freeze(['jab', 'jab', 'cross']),
    comboStats: Object.freeze(initialComboStats()),
  })

  for (const [index, type] of ['jab', 'jab', 'cross'].entries()) {
    state = applyPunchToCombo(
      state,
      makePunch(type),
      makeOptions({ nowMs: 1000 + index, id: `event-${index}` }),
    )

    assert.equal(state.comboStepIndex, index + 1)
    assert.equal(state.lastPunchEvent.expectedIndex, index)
    assert.equal(state.lastPunchEvent.matched, true)
    assert.equal(state.comboResult, index === 2 ? 'success' : 'active')
    assert.deepEqual(state.comboStats, {
      succeeded: index === 2 ? 1 : 0,
      failed: 0,
      total: index === 2 ? 1 : 0,
    })
  }

  assert.equal(state.comboLockedUntil, 1852)
})

test('applyPunchToCombo defaults to Date.now, Math.random, and an 850ms lock', (t) => {
  t.mock.method(Date, 'now', () => WALL_NOW)
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(makeState(), makePunch('hook'))

  assert.equal(result.comboLockedUntil, WALL_NOW + 850)
  assert.deepEqual(result.lastPunchEvent, expectedEvent({
    id: `${WALL_NOW}-i`,
    punch: 'hook',
    matched: false,
  }))
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo uses injected randomness to generate an ID', () => {
  let calls = 0
  const result = applyPunchToCombo(
    makeState(),
    makePunch(),
    makeOptions({
      id: undefined,
      random: () => {
        calls += 1
        return 0.5
      },
    }),
  )

  assert.equal(result.lastPunchEvent.id, '1000-i')
  assert.equal(calls, 1)
})

test('applyPunchToCombo consumes ID randomness before selecting a released combo', () => {
  const draws = [0.5, 0.4]
  let calls = 0
  const state = makeState({
    comboLockedUntil: 1000,
    comboResult: 'success',
    comboStepIndex: 2,
  })

  const result = applyPunchToCombo(
    state,
    makePunch('uppercut'),
    makeOptions({
      id: undefined,
      random: () => {
        assert.ok(calls < draws.length, 'unexpected extra random draw')
        return draws[calls++]
      },
    }),
  )

  assert.equal(calls, 2)
  assert.equal(result.lastPunchEvent.id, '1000-i')
  assert.deepEqual(result.currentCombo, comboLibrary[2])
  assert.equal(result.comboStepIndex, 1)
  assert.equal(result.lastPunchEvent.matched, true)
})

test('applyPunchToCombo preserves explicit zero and empty-string options', () => {
  const result = applyPunchToCombo(
    makeState(),
    makePunch('hook'),
    makeOptions({
      nowMs: 0,
      wallNowMs: 0,
      lockDelayMs: 0,
      id: '',
      random: () => {
        assert.fail('an explicit ID must not consume randomness')
      },
    }),
  )

  assert.equal(result.comboLockedUntil, 0)
  assert.equal(result.comboResult, 'failed')
  assert.deepEqual(result.lastPunchEvent, expectedEvent({
    id: '',
    punch: 'hook',
    matched: false,
    detectedAt: '1970-01-01T00:00:00.000Z',
  }))
})

test('applyPunchToCombo applies nullish option defaults', (t) => {
  t.mock.method(Date, 'now', () => WALL_NOW)
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(makeState(), makePunch('hook'), {
    nowMs: null,
    wallNowMs: null,
    lockDelayMs: null,
    id: null,
  })

  assert.equal(result.comboLockedUntil, WALL_NOW + 850)
  assert.equal(result.lastPunchEvent.id, `${WALL_NOW}-i`)
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
  assert.equal(random.mock.callCount(), 1)
})
