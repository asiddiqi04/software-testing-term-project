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

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function makeState(overrides = {}) {
  return deepFreeze({
    currentCombo: ['jab', 'cross'],
    comboStepIndex: 0,
    comboLockedUntil: null,
    comboResult: 'idle',
    comboStats: { succeeded: 2, failed: 3, total: 5 },
    lastPunchEvent: { id: 'previous-event' },
    extra: { preserved: true },
    ...overrides,
  })
}

function makePunch(type, overrides = {}) {
  return deepFreeze({
    type,
    side: 'left',
    score: 0.92,
    ...overrides,
  })
}

function makeOptions(overrides = {}) {
  return {
    nowMs: 1000,
    wallNowMs: WALL_NOW,
    id: 'event-1',
    ...overrides,
  }
}

function unexpectedRandom() {
  assert.fail('Randomness should not be used')
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

test('comboToKey joins steps in order without changing its input', () => {
  for (const [combo, expected] of [
    [[], ''],
    [['jab'], 'jab'],
    [['jab', 'cross'], 'jab-cross'],
    [['jab', 'jab', 'cross'], 'jab-jab-cross'],
    [['cross', 'jab'], 'cross-jab'],
  ]) {
    assert.equal(comboToKey(Object.freeze(combo)), expected)
  }
})

test('pickRandomCombo maps random values to every library entry', () => {
  for (let index = 0; index < comboLibrary.length; index += 1) {
    for (const randomValue of [
      index / comboLibrary.length,
      (index + 0.5) / comboLibrary.length,
    ]) {
      let calls = 0
      const result = pickRandomCombo([], () => {
        calls += 1
        return randomValue
      })

      assert.deepEqual(result, comboLibrary[index])
      assert.notStrictEqual(result, comboLibrary[index])
      assert.equal(calls, 1)
    }
  }

  assert.deepEqual(
    pickRandomCombo([], () => 1 - Number.EPSILON),
    comboLibrary.at(-1),
  )
})

test('pickRandomCombo uses its default previous combo and Math.random', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.4)

  assert.deepEqual(pickRandomCombo(), ['uppercut', 'hook'])
  assert.equal(random.mock.callCount(), 1)
})

test('pickRandomCombo rerolls an equal previous combo by value', () => {
  const previous = Object.freeze(['jab', 'cross'])
  const values = [0, 0.1, 0.4]
  let calls = 0

  const result = pickRandomCombo(previous, () => {
    assert.ok(calls < values.length, 'Unexpected extra random call')
    return values[calls++]
  })

  assert.deepEqual(result, ['uppercut', 'hook'])
  assert.equal(calls, 3)
  assert.deepEqual(previous, ['jab', 'cross'])
})

test('pickRandomCombo stops after twelve rerolls even if it repeats', () => {
  let calls = 0
  const result = pickRandomCombo(['jab', 'cross'], () => {
    calls += 1
    return 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, ['jab', 'cross'])
  assert.notStrictEqual(result, comboLibrary[0])
})

test('pickRandomCombo can select a different combo on the final reroll', () => {
  let calls = 0
  const result = pickRandomCombo(['jab', 'cross'], () => {
    calls += 1
    return calls === 13 ? 0.8 : 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, ['cross', 'hook', 'uppercut'])
})

test('pickRandomCombo returns an independent array', () => {
  const original = [...comboLibrary[0]]
  const result = pickRandomCombo([], () => 0)
  result[0] = 'changed'
  result.push('extra')

  assert.deepEqual(comboLibrary[0], original)
})

test('pickRandomCombo handles a one-entry library without rerolling', () => {
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

test('initialComboStats returns fresh, independent zeroed statistics', () => {
  const first = initialComboStats()
  const second = initialComboStats()

  assert.deepEqual(first, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(second, first)
  assert.notStrictEqual(first, second)

  first.succeeded = 10
  assert.deepEqual(second, { succeeded: 0, failed: 0, total: 0 })
})

test('releaseComboIfReady preserves identity when no lock is set', () => {
  for (const comboLockedUntil of [null, undefined, 0, false]) {
    const state = makeState({ comboLockedUntil })
    assert.strictEqual(
      releaseComboIfReady(state, 1000, unexpectedRandom),
      state,
    )
  }
})

test('releaseComboIfReady preserves identity before lock expiration', () => {
  const state = makeState({
    comboLockedUntil: 1001,
    comboResult: 'failed',
  })

  assert.strictEqual(
    releaseComboIfReady(state, 1000, unexpectedRandom),
    state,
  )
})

test('releaseComboIfReady releases at and after the expiration boundary', () => {
  for (const nowMs of [1000, 1001, 5000]) {
    const state = makeState({
      comboStepIndex: 2,
      comboLockedUntil: 1000,
      comboResult: 'success',
    })
    const result = releaseComboIfReady(state, nowMs, () => 0.4)

    assert.notStrictEqual(result, state)
    assert.deepEqual(result, {
      ...state,
      currentCombo: ['uppercut', 'hook'],
      comboStepIndex: 0,
      comboLockedUntil: null,
      comboResult: 'idle',
    })
    assert.notStrictEqual(result.currentCombo, comboLibrary[2])
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.lastPunchEvent, state.lastPunchEvent)
    assert.strictEqual(result.extra, state.extra)
  }
})

test('releaseComboIfReady rerolls the previous combination', () => {
  let calls = 0
  const result = releaseComboIfReady(
    makeState({ comboLockedUntil: 1000 }),
    1000,
    () => (++calls === 1 ? 0 : 0.6),
  )

  assert.equal(calls, 2)
  assert.deepEqual(result.currentCombo, ['jab', 'jab', 'cross'])
})

test('releaseComboIfReady uses Math.random by default', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.4)
  const result = releaseComboIfReady(
    makeState({ comboLockedUntil: 1000 }),
    1000,
  )

  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo advances a matching intermediate step', () => {
  const state = makeState()
  const result = applyPunchToCombo(
    state,
    makePunch('jab'),
    makeOptions({ random: unexpectedRandom }),
  )

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
      detectedAt: DETECTED_AT,
    },
  })
  assert.strictEqual(result.comboStats, state.comboStats)
  assert.strictEqual(result.currentCombo, state.currentCombo)
})

test('applyPunchToCombo completes a combo and recomputes statistics', () => {
  const state = makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: { succeeded: 2, failed: 3, total: 999 },
  })
  const result = applyPunchToCombo(
    state,
    makePunch('cross', { side: 'right', score: 0 }),
    makeOptions({ lockDelayMs: 250 }),
  )

  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 2,
    comboStats: { succeeded: 3, failed: 3, total: 6 },
    comboResult: 'success',
    comboLockedUntil: 1250,
    lastPunchEvent: {
      id: 'event-1',
      punch: 'cross',
      side: 'right',
      score: 0,
      expected: 'cross',
      expectedIndex: 1,
      matched: true,
      comboLocked: false,
      detectedAt: DETECTED_AT,
    },
  })
  assert.notStrictEqual(result.comboStats, state.comboStats)
})

test('applyPunchToCombo completes a one-step combo using the default delay', () => {
  const result = applyPunchToCombo(
    makeState({ currentCombo: ['hook'] }),
    makePunch('hook'),
    makeOptions(),
  )

  assert.equal(result.comboStepIndex, 1)
  assert.equal(result.comboResult, 'success')
  assert.equal(result.comboLockedUntil, 1850)
  assert.deepEqual(result.comboStats, { succeeded: 3, failed: 3, total: 6 })
})

test('applyPunchToCombo fails mismatches at both initial and later steps', () => {
  for (const comboStepIndex of [0, 1]) {
    const state = makeState({
      comboStepIndex,
      comboStats: { succeeded: 2, failed: 3, total: 999 },
    })
    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ lockDelayMs: 400 }),
    )

    assert.deepEqual(result, {
      ...state,
      comboStepIndex: 0,
      comboStats: { succeeded: 2, failed: 4, total: 6 },
      comboResult: 'failed',
      comboLockedUntil: 1400,
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
  }
})

test('applyPunchToCombo fails safely when no expected step exists', () => {
  for (const overrides of [
    { currentCombo: [] },
    { comboStepIndex: 2 },
  ]) {
    const result = applyPunchToCombo(
      makeState(overrides),
      makePunch('jab'),
      makeOptions(),
    )

    assert.equal(result.lastPunchEvent.expected, null)
    assert.equal(result.lastPunchEvent.matched, false)
    assert.equal(result.comboStepIndex, 0)
    assert.equal(result.comboResult, 'failed')
    assert.equal(result.comboLockedUntil, 1850)
    assert.deepEqual(result.comboStats, { succeeded: 2, failed: 4, total: 6 })
  }
})

test('applyPunchToCombo only updates the event while a combo is locked', () => {
  for (const comboResult of ['success', 'failed']) {
    for (const type of ['cross', 'hook']) {
      const state = makeState({
        comboStepIndex: 1,
        comboResult,
        comboLockedUntil: 1001,
      })
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
          expected: 'cross',
          expectedIndex: 1,
          matched: false,
          comboLocked: true,
          detectedAt: DETECTED_AT,
        },
      })
      assert.strictEqual(result.comboStats, state.comboStats)
      assert.strictEqual(result.currentCombo, state.currentCombo)
    }
  }
})

test('applyPunchToCombo releases an expired lock before matching the punch', () => {
  for (const nowMs of [1000, 1001]) {
    const state = makeState({
      comboStepIndex: 2,
      comboResult: 'success',
      comboLockedUntil: 1000,
    })
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
  }
})

test('applyPunchToCombo can fail and relock immediately after release', () => {
  const result = applyPunchToCombo(
    makeState({
      comboStepIndex: 2,
      comboResult: 'success',
      comboLockedUntil: 1000,
    }),
    makePunch('jab'),
    makeOptions({ random: () => 0.4 }),
  )

  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.lastPunchEvent.expected, 'uppercut')
  assert.equal(result.lastPunchEvent.expectedIndex, 0)
  assert.equal(result.lastPunchEvent.comboLocked, false)
  assert.equal(result.lastPunchEvent.matched, false)
  assert.equal(result.comboStepIndex, 0)
  assert.equal(result.comboResult, 'failed')
  assert.equal(result.comboLockedUntil, 1850)
  assert.deepEqual(result.comboStats, { succeeded: 2, failed: 4, total: 6 })
})

test('applyPunchToCombo generates an ID from the supplied time and random source', () => {
  let calls = 0
  const randomValue = 0.123456789
  const result = applyPunchToCombo(
    makeState(),
    makePunch('jab'),
    makeOptions({
      id: undefined,
      random: () => {
        calls += 1
        return randomValue
      },
    }),
  )

  assert.equal(
    result.lastPunchEvent.id,
    `1000-${randomValue.toString(36).slice(2, 8)}`,
  )
  assert.equal(calls, 1)
})

test('applyPunchToCombo consumes randomness for the ID before releasing a combo', () => {
  const values = [0.5, 0, 0.4]
  let calls = 0
  const result = applyPunchToCombo(
    makeState({ comboLockedUntil: 1000 }),
    makePunch('uppercut'),
    makeOptions({
      id: undefined,
      random: () => {
        assert.ok(calls < values.length, 'Unexpected extra random call')
        return values[calls++]
      },
    }),
  )

  assert.equal(calls, 3)
  assert.equal(result.lastPunchEvent.id, '1000-i')
  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.lastPunchEvent.matched, true)
})

test('applyPunchToCombo supports omitted options and independent wall time', (t) => {
  const times = [2000, WALL_NOW]
  let timeCalls = 0
  t.mock.method(Date, 'now', () => {
    assert.ok(timeCalls < times.length, 'Unexpected extra clock call')
    return times[timeCalls++]
  })
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(makeState(), makePunch('hook'))

  assert.equal(timeCalls, 2)
  assert.equal(random.mock.callCount(), 1)
  assert.equal(result.lastPunchEvent.id, '2000-i')
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
  assert.equal(result.comboLockedUntil, 2850)
  assert.equal(result.comboResult, 'failed')
})

test('applyPunchToCombo honors zero times, zero delay, and an empty explicit ID', (t) => {
  t.mock.method(Date, 'now', () => {
    assert.fail('Explicit times should avoid the clock')
  })

  const result = applyPunchToCombo(
    makeState({ currentCombo: ['jab'] }),
    makePunch('jab'),
    {
      nowMs: 0,
      wallNowMs: 0,
      lockDelayMs: 0,
      id: '',
      random: unexpectedRandom,
    },
  )

  assert.equal(result.lastPunchEvent.id, '')
  assert.equal(result.lastPunchEvent.detectedAt, '1970-01-01T00:00:00.000Z')
  assert.equal(result.comboLockedUntil, 0)
  assert.equal(result.comboResult, 'success')
})

test('applyPunchToCombo uses defaults for nullish option values', (t) => {
  t.mock.method(Date, 'now', () => 5000)
  const random = t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(makeState(), makePunch('hook'), {
    nowMs: null,
    wallNowMs: null,
    lockDelayMs: null,
    id: null,
    random: null,
  })

  assert.equal(result.lastPunchEvent.id, '5000-i')
  assert.equal(result.lastPunchEvent.detectedAt, new Date(5000).toISOString())
  assert.equal(result.comboLockedUntil, 5850)
  assert.equal(random.mock.callCount(), 1)
})

test('applyPunchToCombo tracks repeated steps and counts one success per completion', () => {
  let state = makeState({
    currentCombo: ['jab', 'jab', 'cross'],
    comboStats: initialComboStats(),
  })

  for (const [index, type] of ['jab', 'jab', 'cross'].entries()) {
    state = applyPunchToCombo(
      deepFreeze(state),
      makePunch(type),
      makeOptions({ nowMs: 1000 + index, id: `step-${index}` }),
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

  const locked = applyPunchToCombo(
    deepFreeze(state),
    makePunch('cross'),
    makeOptions({ nowMs: 1003 }),
  )

  assert.equal(locked.lastPunchEvent.expected, null)
  assert.equal(locked.lastPunchEvent.comboLocked, true)
  assert.equal(locked.lastPunchEvent.matched, false)
  assert.equal(locked.comboStepIndex, 3)
  assert.equal(locked.comboLockedUntil, 1852)
  assert.deepEqual(locked.comboStats, { succeeded: 1, failed: 0, total: 1 })
})
