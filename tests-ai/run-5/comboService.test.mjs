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
  return {
    currentCombo: ['jab', 'cross'],
    comboStepIndex: 0,
    comboLockedUntil: null,
    comboResult: 'idle',
    comboStats: initialComboStats(),
    lastPunchEvent: null,
    sessionId: 'session-1',
    ...overrides,
  }
}

function makePunch(type = 'jab') {
  return { type, side: 'left', score: 0.91 }
}

function makeOptions(overrides = {}) {
  return {
    nowMs: 1000,
    wallNowMs: WALL_NOW,
    id: 'punch-1',
    ...overrides,
  }
}

function expectedEvent(overrides = {}) {
  return {
    id: 'punch-1',
    punch: 'jab',
    side: 'left',
    score: 0.91,
    expected: 'jab',
    expectedIndex: 0,
    matched: true,
    comboLocked: false,
    detectedAt: DETECTED_AT,
    ...overrides,
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function unexpectedRandom() {
  assert.fail('Randomness should not be used')
}

test('comboLibrary contains the supported combinations in order', () => {
  assert.deepEqual(comboLibrary, [
    ['jab', 'cross'],
    ['jab', 'cross', 'hook'],
    ['uppercut', 'hook'],
    ['jab', 'jab', 'cross'],
    ['cross', 'hook', 'uppercut'],
  ])
})

test('comboToKey handles empty, single, repeated, and ordered punches', () => {
  assert.equal(comboToKey([]), '')
  assert.equal(comboToKey(['jab']), 'jab')
  assert.equal(comboToKey(['jab', 'cross']), 'jab-cross')
  assert.equal(comboToKey(['jab', 'jab', 'cross']), 'jab-jab-cross')
  assert.notEqual(comboToKey(['jab', 'cross']), comboToKey(['cross', 'jab']))

  const combo = Object.freeze(['uppercut', 'hook'])
  assert.equal(comboToKey(combo), 'uppercut-hook')
  assert.deepEqual(combo, ['uppercut', 'hook'])
})

test('pickRandomCombo selects every library entry and returns independent copies', () => {
  const snapshot = comboLibrary.map((combo) => [...combo])

  for (let index = 0; index < comboLibrary.length; index += 1) {
    const result = pickRandomCombo([], () => (index + 0.5) / comboLibrary.length)
    assert.deepEqual(result, snapshot[index])
    assert.notStrictEqual(result, comboLibrary[index])

    result.push('modified')
    assert.deepEqual(comboLibrary, snapshot)
  }

  assert.deepEqual(pickRandomCombo([], () => 0), snapshot[0])
  assert.deepEqual(pickRandomCombo([], () => 1 - Number.EPSILON), snapshot.at(-1))
})

test('pickRandomCombo compares previous combinations by content and retries', () => {
  const previous = Object.freeze(['jab', 'cross'])
  const draws = [0, 0, 0.4]
  let calls = 0

  const result = pickRandomCombo(previous, () => draws[calls++])

  assert.equal(calls, 3)
  assert.deepEqual(result, ['uppercut', 'hook'])
  assert.deepEqual(previous, ['jab', 'cross'])
})

test('pickRandomCombo stops after twelve retries even if the selection repeats', () => {
  let calls = 0
  const result = pickRandomCombo(['jab', 'cross'], () => {
    calls += 1
    return 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, ['jab', 'cross'])
  assert.notStrictEqual(result, comboLibrary[0])
})

test('pickRandomCombo accepts a different combination on the final retry', () => {
  let calls = 0
  const result = pickRandomCombo(['jab', 'cross'], () => {
    calls += 1
    return calls === 13 ? 0.8 : 0
  })

  assert.equal(calls, 13)
  assert.deepEqual(result, ['cross', 'hook', 'uppercut'])
})

test('pickRandomCombo uses Math.random and an empty previous combination by default', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.6)

  assert.deepEqual(pickRandomCombo(), ['jab', 'jab', 'cross'])
  assert.equal(random.mock.callCount(), 1)
})

test('pickRandomCombo returns immediately for a single-entry library', () => {
  const originalEntries = [...comboLibrary]

  try {
    comboLibrary.splice(1)
    let calls = 0
    const result = pickRandomCombo(['jab', 'cross'], () => {
      calls += 1
      return 0
    })

    assert.equal(calls, 1)
    assert.deepEqual(result, ['jab', 'cross'])
    assert.notStrictEqual(result, comboLibrary[0])
  } finally {
    comboLibrary.splice(0, comboLibrary.length, ...originalEntries)
  }
})

test('initialComboStats returns a fresh zeroed object on every call', () => {
  const first = initialComboStats()
  const second = initialComboStats()

  assert.deepEqual(first, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(second, first)
  assert.notStrictEqual(first, second)

  first.succeeded = 10
  assert.deepEqual(second, { succeeded: 0, failed: 0, total: 0 })
  assert.deepEqual(initialComboStats(), second)
})

test('releaseComboIfReady preserves identity when there is no active expiry', () => {
  for (const comboLockedUntil of [undefined, null, 0, false]) {
    const state = deepFreeze(makeState({ comboLockedUntil }))
    assert.strictEqual(releaseComboIfReady(state, 1000, unexpectedRandom), state)
  }
})

test('releaseComboIfReady preserves identity before the lock expires', () => {
  const state = deepFreeze(makeState({
    comboLockedUntil: 1001,
    comboResult: 'failed',
  }))

  assert.strictEqual(releaseComboIfReady(state, 1000, unexpectedRandom), state)
})

test('releaseComboIfReady resets combo fields at and after expiry', () => {
  for (const nowMs of [1000, 1001]) {
    const state = deepFreeze(makeState({
      comboStepIndex: 2,
      comboLockedUntil: 1000,
      comboResult: 'success',
      comboStats: { succeeded: 3, failed: 2, total: 5 },
      lastPunchEvent: { id: 'previous-event' },
    }))

    const result = releaseComboIfReady(state, nowMs, () => 0.4)

    assert.notStrictEqual(result, state)
    assert.deepEqual(result, {
      ...state,
      currentCombo: ['uppercut', 'hook'],
      comboStepIndex: 0,
      comboLockedUntil: null,
      comboResult: 'idle',
    })
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.lastPunchEvent, state.lastPunchEvent)
    assert.notStrictEqual(result.currentCombo, comboLibrary[2])
  }
})

test('releaseComboIfReady uses Math.random by default', (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const result = releaseComboIfReady(
    makeState({ comboLockedUntil: 1000 }),
    1000,
  )

  assert.deepEqual(result.currentCombo, ['cross', 'hook', 'uppercut'])
})

test('applyPunchToCombo advances a matching intermediate punch without changing stats', () => {
  const state = deepFreeze(makeState())
  const punch = deepFreeze(makePunch())
  const options = deepFreeze(makeOptions({ random: unexpectedRandom }))

  const result = applyPunchToCombo(state, punch, options)

  assert.notStrictEqual(result, state)
  assert.deepEqual(result, {
    ...state,
    comboStepIndex: 1,
    comboResult: 'active',
    lastPunchEvent: expectedEvent(),
  })
  assert.strictEqual(result.comboStats, state.comboStats)
  assert.strictEqual(result.currentCombo, state.currentCombo)
})

test('applyPunchToCombo completes a combo and recomputes total from success and failure counts', () => {
  const state = deepFreeze(makeState({
    comboStepIndex: 1,
    comboResult: 'active',
    comboStats: { succeeded: 2, failed: 3, total: 999 },
  }))
  const punch = makePunch('cross')

  const result = applyPunchToCombo(state, punch, makeOptions())

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
})

test('applyPunchToCombo supports repeated steps and single-punch combinations', () => {
  let state = makeState({ currentCombo: ['jab', 'jab', 'cross'] })

  for (const [index, type] of ['jab', 'jab', 'cross'].entries()) {
    state = applyPunchToCombo(state, makePunch(type), makeOptions())
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

  const single = applyPunchToCombo(
    makeState({ currentCombo: ['hook'] }),
    makePunch('hook'),
    makeOptions(),
  )
  assert.equal(single.comboResult, 'success')
  assert.equal(single.comboStepIndex, 1)
  assert.equal(single.comboLockedUntil, 1850)
  assert.deepEqual(single.comboStats, { succeeded: 1, failed: 0, total: 1 })
})

test('applyPunchToCombo fails a mismatch at any step and honors a custom lock delay', () => {
  for (const comboStepIndex of [0, 1]) {
    const state = deepFreeze(makeState({
      comboStepIndex,
      comboResult: 'active',
      comboStats: { succeeded: 2, failed: 3, total: 999 },
    }))

    const result = applyPunchToCombo(
      state,
      makePunch('hook'),
      makeOptions({ lockDelayMs: 250 }),
    )

    assert.deepEqual(result, {
      ...state,
      comboStepIndex: 0,
      comboStats: { succeeded: 2, failed: 4, total: 6 },
      comboResult: 'failed',
      comboLockedUntil: 1250,
      lastPunchEvent: expectedEvent({
        punch: 'hook',
        expected: state.currentCombo[comboStepIndex],
        expectedIndex: comboStepIndex,
        matched: false,
      }),
    })
  }
})

test('applyPunchToCombo treats absent expected punches as failures', () => {
  for (const overrides of [
    { currentCombo: [], comboStepIndex: 0 },
    { currentCombo: ['jab'], comboStepIndex: 1 },
  ]) {
    const state = deepFreeze(makeState(overrides))
    const result = applyPunchToCombo(state, makePunch(), makeOptions())

    assert.equal(result.comboResult, 'failed')
    assert.equal(result.comboStepIndex, 0)
    assert.equal(result.comboLockedUntil, 1850)
    assert.deepEqual(result.comboStats, { succeeded: 0, failed: 1, total: 1 })
    assert.deepEqual(result.lastPunchEvent, expectedEvent({
      expected: null,
      expectedIndex: overrides.comboStepIndex,
      matched: false,
    }))
  }
})

test('applyPunchToCombo only replaces the event while a combo is locked', () => {
  for (const comboResult of ['success', 'failed']) {
    const state = deepFreeze(makeState({
      comboStepIndex: comboResult === 'success' ? 2 : 0,
      comboResult,
      comboLockedUntil: 1001,
      comboStats: { succeeded: 2, failed: 3, total: 5 },
      lastPunchEvent: { id: 'old-event' },
    }))

    const result = applyPunchToCombo(
      state,
      makePunch(),
      makeOptions({ random: unexpectedRandom }),
    )

    assert.deepEqual(result, {
      ...state,
      lastPunchEvent: expectedEvent({
        expected: comboResult === 'success' ? null : 'jab',
        expectedIndex: state.comboStepIndex,
        matched: false,
        comboLocked: true,
      }),
    })
    assert.notStrictEqual(result, state)
    assert.strictEqual(result.comboStats, state.comboStats)
    assert.strictEqual(result.currentCombo, state.currentCombo)
  }
})

test('applyPunchToCombo releases an expired lock before matching the new combo', () => {
  for (const nowMs of [1000, 1001]) {
    const state = deepFreeze(makeState({
      comboStepIndex: 2,
      comboResult: 'success',
      comboLockedUntil: 1000,
      comboStats: { succeeded: 4, failed: 1, total: 5 },
    }))

    const result = applyPunchToCombo(
      state,
      makePunch('uppercut'),
      makeOptions({ nowMs, random: () => 0.4 }),
    )

    assert.deepEqual(result, {
      ...state,
      currentCombo: ['uppercut', 'hook'],
      comboStepIndex: 1,
      comboResult: 'active',
      comboLockedUntil: null,
      lastPunchEvent: expectedEvent({
        punch: 'uppercut',
        expected: 'uppercut',
      }),
    })
    assert.strictEqual(result.comboStats, state.comboStats)
  }
})

test('applyPunchToCombo can fail and lock again immediately after release', () => {
  const state = deepFreeze(makeState({
    comboStepIndex: 1,
    comboResult: 'failed',
    comboLockedUntil: 1000,
    comboStats: { succeeded: 2, failed: 3, total: 5 },
  }))

  const result = applyPunchToCombo(
    state,
    makePunch('jab'),
    makeOptions({ random: () => 0.4, lockDelayMs: 300 }),
  )

  assert.deepEqual(result, {
    ...state,
    currentCombo: ['uppercut', 'hook'],
    comboStepIndex: 0,
    comboResult: 'failed',
    comboLockedUntil: 1300,
    comboStats: { succeeded: 2, failed: 4, total: 6 },
    lastPunchEvent: expectedEvent({
      expected: 'uppercut',
      matched: false,
    }),
  })
})

test('applyPunchToCombo preserves punch metadata and matches solely by type', () => {
  const punch = { type: 'jab', side: 'right', score: 0, extra: 'unused' }
  const result = applyPunchToCombo(makeState(), punch, makeOptions())

  assert.deepEqual(result.lastPunchEvent, expectedEvent({
    side: 'right',
    score: 0,
  }))

  const missingMetadata = applyPunchToCombo(
    makeState(),
    { type: 'jab' },
    makeOptions(),
  )
  assert.deepEqual(missingMetadata.lastPunchEvent, expectedEvent({
    side: undefined,
    score: undefined,
  }))
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

test('applyPunchToCombo generates an ID using the injected random value', () => {
  const randomValue = 0.123456789
  let calls = 0

  const result = applyPunchToCombo(
    makeState(),
    makePunch(),
    makeOptions({
      id: undefined,
      random: () => {
        calls += 1
        return randomValue
      },
    }),
  )

  const suffix = randomValue.toString(36).slice(2, 8)
  assert.equal(suffix.length, 6)
  assert.equal(result.lastPunchEvent.id, `1000-${suffix}`)
  assert.equal(calls, 1)
})

test('applyPunchToCombo generates its ID before drawing a replacement combo', () => {
  const draws = [0.5, 0.4]
  let calls = 0

  const result = applyPunchToCombo(
    makeState({ comboLockedUntil: 1000 }),
    makePunch('uppercut'),
    makeOptions({
      id: undefined,
      random: () => {
        assert.ok(calls < draws.length)
        return draws[calls++]
      },
    }),
  )

  assert.equal(calls, 2)
  assert.equal(result.lastPunchEvent.id, '1000-i')
  assert.deepEqual(result.currentCombo, ['uppercut', 'hook'])
  assert.equal(result.lastPunchEvent.matched, true)
})

test('applyPunchToCombo accepts zero timestamps, a zero delay, and an empty ID', () => {
  for (const type of ['jab', 'hook']) {
    const result = applyPunchToCombo(
      makeState({ currentCombo: ['jab'] }),
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

test('applyPunchToCombo uses defaults for null option values', (t) => {
  t.mock.method(Date, 'now', () => WALL_NOW)
  t.mock.method(Math, 'random', () => 0.5)

  const result = applyPunchToCombo(makeState(), makePunch('hook'), {
    nowMs: null,
    wallNowMs: null,
    lockDelayMs: null,
    id: null,
  })

  assert.equal(result.comboLockedUntil, WALL_NOW + 850)
  assert.equal(result.lastPunchEvent.id, `${WALL_NOW}-i`)
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
})

test('applyPunchToCombo uses wall time independently of the combo clock', (t) => {
  t.mock.method(Date, 'now', () => WALL_NOW)

  const result = applyPunchToCombo(makeState(), makePunch('hook'), {
    nowMs: 25,
    id: 'explicit-id',
    random: unexpectedRandom,
  })

  assert.equal(result.comboLockedUntil, 875)
  assert.equal(result.lastPunchEvent.id, 'explicit-id')
  assert.equal(result.lastPunchEvent.detectedAt, DETECTED_AT)
})
