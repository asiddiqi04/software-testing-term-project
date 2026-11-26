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

const makeState = (overrides = {}) => ({
  currentCombo: ['jab', 'cross'],
  comboStepIndex: 0,
  comboLockedUntil: null,
  comboResult: 'idle',
  comboStats: initialComboStats(),
  lastPunchEvent: null,
  extra: 'preserved',
  ...overrides,
})

const makePunch = (type, overrides = {}) => ({
  type,
  side: 'left',
  score: 0.92,
  ...overrides,
})

const makeOptions = (overrides = {}) => ({
  nowMs: 1000,
  wallNowMs: 0,
  id: 'event-1',
  ...overrides,
})

const unexpectedRandom = () => {
  throw new Error('Randomness should not be used')
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('comboLibrary contains the expected ordered combinations', () => {
  assert.deepEqual(comboLibrary, [
    ['jab', 'cross'],
    ['jab', 'cross', 'hook'],
    ['uppercut', 'hook'],
    ['jab', 'jab', 'cross'],
    ['cross', 'hook', 'uppercut'],
  ])
})

test('comboToKey joins punches in order without changing the input', () => {
  assert.equal(comboToKey([]), '')
  assert.equal(comboToKey(['jab']), 'jab')
  assert.equal(comboToKey(['jab', 'jab', 'cross']), 'jab-jab-cross')
  assert.equal(comboToKey(['cross', 'jab']), 'cross-jab')

  const combo = Object.freeze(['jab', 'cross', 'hook'])
  assert.equal(comboToKey(combo), 'jab-cross-hook')
  assert.deepEqual(combo, ['jab', 'cross', 'hook'])
})

test('pickRandomCombo maps random values to each library entry and returns copies', () => {
  for (let index = 0; index < comboLibrary.length; index += 1) {
    for (const offset of [0, 0.5]) {
      const result = pickRandomCombo(
        [],
        () => (index + offset) / comboLibrary.length,
      )

      assert.deepEqual(result, comboLibrary[index])
      assert.notStrictEqual(result, comboLibrary[index])

      result.push('changed')
      assert.equal(comboLibrary[index].includes('changed'), false)
    }
  }

  assert.deepEqual(
    pickRandomCombo([], () => 0.9999999999999999),
    comboLibrary.at(-1),
  )
})

test('pickRandomCombo defaults to an empty previous combo and Math.random', (t) => {
  let calls = 0
  t.mock.method(Math, 'random', () => {
    calls += 1
    return 0
  })

  assert.deepEqual(pickRandomCombo(), comboLibrary[0])
  assert.equal(calls, 1)
})

test('pickRandomCombo retries matching combinations by value', () => {
  const previous = Object.freeze([...comboLibrary[0]])
  const draws = [0, 0.1, 0.4]
  let calls = 0

  const result = pickRandomCombo(previous, () => {
    assert.ok(calls < draws.length)
    return draws[calls++]
  })

  assert.deepEqual(result, comboLibrary[2])
  assert.equal(calls, 3)
  assert.deepEqual(previous, comboLibrary[0])
})

test('pickRandomCombo stops after twelve retries even if the combo repeats', () => {
  let calls = 0
  const result = pickRandomCombo(comboLibrary[0], () => {
    calls += 1
    assert.ok(calls <= 13, 'The retry guard must bound random calls')
    return 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, comboLibrary[0])
  assert.notStrictEqual(result, comboLibrary[0])
})

test('pickRandomCombo accepts a different combo on its final allowed retry', () => {
  let calls = 0
  const result = pickRandomCombo(comboLibrary[0], () => {
    calls += 1
    assert.ok(calls <= 13)
    return calls === 13 ? 0.8 : 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, comboLibrary[4])
})

test('pickRandomCombo handles a single-entry library without retrying', () => {
  const originalEntries = [...comboLibrary]

  try {
    comboLibrary.splice(1)
    let calls = 0
    const result = pickRandomCombo(comboLibrary[0], () => {
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
})

test('releaseComboIfReady preserves identity when there is no active deadline', () => {
  for (const comboLockedUntil of [null, undefined, 0]) {
    const state = deepFreeze(makeState({ comboLockedUntil }))
    assert.strictEqual(
      releaseComboIfReady(state, 1000, unexpectedRandom),
      state,
    )
  }
})

test('releaseComboIfReady preserves identity before the deadline', () => {
  const state = deepFreeze(makeState({
    comboLockedUntil: 1001,
    comboResult: 'failed',
  }))

  assert.strictEqual(
    releaseComboIfReady(state, 1000, unexpectedRandom),
    state,
  )
})

test('releaseComboIfReady resets combo fields at and after the deadline', () => {
  for (const nowMs of [1000, 1001, 5000]) {
    const state = deepFreeze(makeState({
      comboStepIndex: 2,
      comboLockedUntil: 1000,
      comboResult: 'success',
      comboStats: { succeeded: 2, failed: 1, total: 3 },
      lastPunchEvent: { id: 'previous-event' },
    }))

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
    assert.strictEqual(result.lastPunchEvent, state.lastPunchEvent)
  }
})

test('releaseComboIfReady uses Math.random by default', (t) => {
  t.mock.method(Math, 'random', () => 0.6)
  const state = makeState({ comboLockedUntil: 1000 })

  assert.deepEqual(
    releaseComboIfReady(state, 1000).currentCombo,
    comboLibrary[3],
  )
})

test('applyPunchToCombo advances a matching step and records complete event data', () => {
  const state = deepFreeze(makeState())
  const punch = deepFreeze(makePunch('jab'))
  const options = deepFreeze(makeOptions({ random: unexpectedRandom }))

  const result = applyPunchToCombo(state, punch, options)

  assert.notStrictEqual(result, state)
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
      detectedAt: '1970-01-01T00:00:00.000Z',
    },
  })
  assert.strictEqual(result.currentCombo, state.currentCombo)
  assert.strictEqual(result.comboStats, state.comboStats)
})

test('applyPunchToCombo completes a combo, increments successes, and locks by default', () => {
  const state = deepFreeze(makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: { succeeded: 2, failed: 3, total: 99 },
  }))

  const result = applyPunchToCombo(
    state,
    makePunch('cross', { side: 'right', score: 0 }),
    makeOptions(),
  )

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 2,
    comboStats: { succeeded: 3, failed: 3, total: 6 },
    comboResult: 'success',
    comboLockedUntil: 1850,
    lastPunchEvent: {
      id: 'event-1',
      punch: 'cross',
      side: 'right',
      score: 0,
      expected: 'cross',
      expectedIndex: 1,
      matched: true,
      comboLocked: false,
      detectedAt: '1970-01-01T00:00:00.000Z',
    },
  })
  assert.notStrictEqual(result.comboStats, state.comboStats)
})

test('applyPunchToCombo fails an incorrect punch and records the original step', () => {
  const state = deepFreeze(makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: { succeeded: 4, failed: 2, total: 99 },
  }))

  const result = applyPunchToCombo(
    state,
    makePunch('hook'),
    makeOptions({ lockDelayMs: 250 }),
  )

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 0,
    comboStats: { succeeded: 4, failed: 3, total: 7 },
    comboResult: 'failed',
    comboLockedUntil: 1250,
    lastPunchEvent: {
      id: 'event-1',
      punch: 'hook',
      side: 'left',
      score: 0.92,
      expected: 'cross',
      expectedIndex: 1,
      matched: false,
      comboLocked: false,
      detectedAt: '1970-01-01T00:00:00.000Z',
    },
  })
})

test('applyPunchToCombo only updates the event while locked', () => {
  const cases = [
    { comboStepIndex: 0, comboResult: 'failed', type: 'jab', expected: 'jab' },
    { comboStepIndex: 2, comboResult: 'success', type: 'hook', expected: null },
  ]

  for (const { comboStepIndex, comboResult, type, expected } of cases) {
    const state = deepFreeze(makeState({
      comboStepIndex,
      comboResult,
      comboLockedUntil: 1001,
      comboStats: { succeeded: 2, failed: 1, total: 3 },
      lastPunchEvent: { id: 'old' },
    }))

    const result = applyPunchToCombo(
      state,
      makePunch(type),
      makeOptions({ random: unexpectedRandom }),
    )

    assert.notStrictEqual(result, state)
    assert.deepEqual(result, {
      ...state,
      lastPunchEvent: {
        id: 'event-1',
        punch: type,
        side: 'left',
        score: 0.92,
        expected,
        expectedIndex: comboStepIndex,
        matched: false,
        comboLocked: true,
        detectedAt: '1970-01-01T00:00:00.000Z',
      },
    })
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.currentCombo, state.currentCombo)
  }
})

test('applyPunchToCombo releases an expired lock before matching the current punch', () => {
  for (const nowMs of [1000, 1001]) {
    const state = deepFreeze(makeState({
      comboStepIndex: 2,
      comboResult: 'success',
      comboLockedUntil: 1000,
      comboStats: { succeeded: 1, failed: 0, total: 1 },
    }))

    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ nowMs, random: () => 0.4 }),
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
    assert.equal(result.extra, 'preserved')
  }
})

test('applyPunchToCombo fails against the newly selected combo after release', () => {
  const state = deepFreeze(makeState({
    comboLockedUntil: 1000,
    comboResult: 'failed',
    comboStats: { succeeded: 1, failed: 2, total: 3 },
  }))

  const result = applyPunchToCombo(
    state,
    makePunch('jab'),
    makeOptions({ random: () => 0.4, lockDelayMs: 100 }),
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

test('applyPunchToCombo treats a missing expected punch as a failure', () => {
  for (const overrides of [
    { currentCombo: [], comboStepIndex: 0 },
    { currentCombo: ['jab'], comboStepIndex: 1 },
  ]) {
    const state = deepFreeze(makeState(overrides))
    const result = applyPunchToCombo(state, makePunch('jab'), makeOptions())

    assert.equal(result.lastPunchEvent.expected, null)
    assert.equal(result.lastPunchEvent.expectedIndex, overrides.comboStepIndex)
    assert.equal(result.lastPunchEvent.matched, false)
    assert.equal(result.comboStepIndex, 0)
    assert.equal(result.comboResult, 'failed')
    assert.equal(result.comboLockedUntil, 1850)
    assert.deepEqual(result.comboStats, { succeeded: 0, failed: 1, total: 1 })
  }
})

test('applyPunchToCombo honors zero time, zero lock delay, and an empty explicit ID', () => {
  for (const type of ['jab', 'hook']) {
    const state = deepFreeze(makeState({ currentCombo: ['jab'] }))
    const result = applyPunchToCombo(
      state,
      makePunch(type),
      makeOptions({
        nowMs: 0,
        wallNowMs: 0,
        lockDelayMs: 0,
        id: '',
        random: unexpectedRandom,
      }),
    )

    assert.equal(result.comboLockedUntil, 0)
    assert.equal(result.comboResult, type === 'jab' ? 'success' : 'failed')
    assert.equal(result.lastPunchEvent.id, '')
    assert.equal(result.lastPunchEvent.detectedAt, '1970-01-01T00:00:00.000Z')
  }
})

test('applyPunchToCombo generates an ID from injected time and randomness', () => {
  const randomValue = 0.123456789
  let calls = 0

  const result = applyPunchToCombo(
    makeState(),
    makePunch('jab'),
    {
      nowMs: 1234,
      wallNowMs: 5678,
      random: () => {
        calls += 1
        return randomValue
      },
    },
  )

  assert.equal(
    result.lastPunchEvent.id,
    `1234-${randomValue.toString(36).slice(2, 8)}`,
  )
  assert.equal(calls, 1)
  assert.equal(result.lastPunchEvent.detectedAt, '1970-01-01T00:00:05.678Z')
})

test('applyPunchToCombo uses injected randomness for ID generation and combo release', () => {
  const draws = [0.123456789, 0.4]
  let calls = 0

  const result = applyPunchToCombo(
    makeState({ comboLockedUntil: 1000 }),
    makePunch('uppercut'),
    {
      nowMs: 1000,
      wallNowMs: 0,
      random: () => {
        assert.ok(calls < draws.length)
        return draws[calls++]
      },
    },
  )

  assert.equal(calls, 2)
  assert.equal(
    result.lastPunchEvent.id,
    `1000-${draws[0].toString(36).slice(2, 8)}`,
  )
  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.lastPunchEvent.matched, true)
})

test('applyPunchToCombo supplies clock, ID, and lock defaults when options are omitted', (t) => {
  const nowMs = 1700000000000
  const randomValue = 0.987654321
  t.mock.method(Date, 'now', () => nowMs)
  t.mock.method(Math, 'random', () => randomValue)

  const result = applyPunchToCombo(
    makeState({ currentCombo: ['jab'] }),
    makePunch('jab'),
  )

  assert.equal(result.comboResult, 'success')
  assert.equal(result.comboLockedUntil, nowMs + 850)
  assert.equal(
    result.lastPunchEvent.id,
    `${nowMs}-${randomValue.toString(36).slice(2, 8)}`,
  )
  assert.equal(result.lastPunchEvent.detectedAt, new Date(nowMs).toISOString())
})

test('applyPunchToCombo uses defaults for nullish option values', (t) => {
  t.mock.method(Date, 'now', () => 2000)
  t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(
    makeState({ currentCombo: ['jab'] }),
    makePunch('jab'),
    {
      nowMs: null,
      wallNowMs: null,
      lockDelayMs: null,
      id: null,
      random: null,
    },
  )

  assert.equal(result.comboLockedUntil, 2850)
  assert.equal(result.lastPunchEvent.id, '2000-i')
  assert.equal(result.lastPunchEvent.detectedAt, '1970-01-01T00:00:02.000Z')
})

test('applyPunchToCombo requires every repeated punch in a combo before succeeding', () => {
  let state = deepFreeze(makeState({
    currentCombo: ['jab', 'jab', 'cross'],
  }))

  for (const [index, type] of ['jab', 'jab', 'cross'].entries()) {
    const previous = state
    state = applyPunchToCombo(
      previous,
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
    assert.equal(state.comboLockedUntil, index === 2 ? 1852 : null)
    deepFreeze(state)
  }
})
