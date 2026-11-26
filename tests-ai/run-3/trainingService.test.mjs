import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUND_SECONDS,
  TrainingError,
  createTrainingService,
} from '../../frontend/src/training/trainingService.js'

const ZERO_COUNTS = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
const ZERO_STATS = { succeeded: 0, failed: 0, total: 0 }
const WALL_START = Date.parse('2026-01-01T12:00:00.000Z')

function harness() {
  let monotonicTime = 1000
  let wallTime = WALL_START
  let randomValue = 0
  let idCount = 0

  const service = createTrainingService({
    now: () => monotonicTime,
    wallNow: () => wallTime,
    random: () => randomValue,
    createId: () => `id-${++idCount}`,
  })

  return {
    service,
    now: () => monotonicTime,
    wallNow: () => wallTime,
    idCount: () => idCount,
    advance(ms) {
      monotonicTime += ms
      wallTime += ms
    },
    shiftWall(ms) {
      wallTime += ms
    },
    setRandom(value) {
      randomValue = value
    },
  }
}

function quietFrame(time) {
  return {
    time,
    keypoints: [{ name: 'nose', x: 150, y: 50, score: 1 }],
  }
}

// Three poses provide a bent guard, an opening arm, and full extension.
// Anatomical left produces a jab; anatomical right produces a cross.
function poseFrame(time, side = 'left', stage = 0) {
  const keypoints = [
    { name: 'nose', x: 150, y: 50, score: 1 },
  ]

  for (const arm of ['left', 'right']) {
    const shoulderX = arm === 'left' ? 100 : 200
    const direction = arm === 'left' ? -1 : 1
    const armStage = arm === side ? stage : 0
    const wristOffset = [20, 40, 100][armStage]

    keypoints.push(
      { name: `${arm}_shoulder`, x: shoulderX, y: 100, score: 1 },
      {
        name: `${arm}_elbow`,
        x: shoulderX + direction * 50,
        y: 100,
        score: 1,
      },
      {
        name: `${arm}_wrist`,
        x: shoulderX + direction * wristOffset,
        y: armStage === 2 ? 100 : 80,
        score: 1,
      },
      { name: `${arm}_hip`, x: shoulderX, y: 200, score: 1 },
    )
  }

  return { time, keypoints }
}

function punch(h, side) {
  let result
  for (let stage = 0; stage < 3; stage += 1) {
    h.advance(50)
    result = h.service.submitFrame(poseFrame(h.now(), side, stage))
    assert.equal(result.accepted, true)
    if (stage < 2) assert.equal(result.punchEvent, null)
  }
  assert.ok(result.punchEvent, `Expected a ${side}-hand punch`)
  assert.equal(result.punchEvent.side, side)
  assert.equal(result.punchEvent.punch, side === 'left' ? 'jab' : 'cross')
  return result
}

function assertTrainingError(action, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TrainingError)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'TrainingError')
    assert.equal(error.message, message)
    return true
  })
}

test('exports the round duration and a named Error subclass', () => {
  assert.equal(ROUND_SECONDS, 180)
  const error = new TrainingError('example')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'TrainingError')
  assert.equal(error.message, 'example')
})

test('supports default dependencies and returns the complete service API', () => {
  const service = createTrainingService()
  for (const method of [
    'getState',
    'getGeneration',
    'takeCompletions',
    'startRound',
    'pauseRound',
    'resumeRound',
    'resetRound',
    'endRound',
    'submitFrame',
  ]) {
    assert.equal(typeof service[method], 'function')
  }
  assert.equal(service.getState().round.status, 'ready')
})

test('initial state contains a fresh, deterministic round and empty statistics', () => {
  const h = harness()

  assert.deepEqual(h.service.getState(), {
    round: {
      id: null,
      generation: 0,
      status: 'ready',
      speed: 'casual',
      frameIntervalMs: 50,
      isRunning: false,
      startedAt: null,
      endedAt: null,
      durationSeconds: 180,
      elapsedSeconds: 0,
      timeLeftSeconds: 180,
    },
    currentCombo: ['jab', 'cross'],
    comboStepIndex: 0,
    comboStats: ZERO_STATS,
    comboResult: 'idle',
    lastPunchEvent: null,
    punchCounts: ZERO_COUNTS,
    debugRows: [],
    session: { completedSession: null },
  })
  assert.equal(h.service.getGeneration(), 0)
  assert.equal(h.idCount(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])

  h.advance(500_000)
  assert.equal(h.service.getState().round.timeLeftSeconds, 180)
  assert.equal(h.service.getState().round.status, 'ready')
})

for (const [speed, interval] of [
  ['form', 80],
  ['casual', 50],
  ['intense', 25],
]) {
  test(`starts a ${speed} round with its capture interval`, () => {
    const h = harness()
    const state = h.service.startRound(speed)

    assert.equal(state.round.id, 'id-1')
    assert.equal(state.round.generation, 1)
    assert.equal(state.round.status, 'running')
    assert.equal(state.round.isRunning, true)
    assert.equal(state.round.speed, speed)
    assert.equal(state.round.frameIntervalMs, interval)
    assert.equal(state.round.startedAt, new Date(WALL_START).toISOString())
    assert.equal(state.round.endedAt, null)
    assert.equal(state.round.elapsedSeconds, 0)
    assert.equal(state.round.timeLeftSeconds, 180)
    assert.equal(h.idCount(), 1)
  })
}

test('omitting speed starts a casual round, including after another speed', () => {
  const h = harness()
  assert.equal(h.service.startRound().round.speed, 'casual')
  h.service.endRound()
  h.service.startRound('form')
  h.service.endRound()
  assert.equal(h.service.startRound().round.speed, 'casual')
})

test('invalid speeds throw TrainingError without changing state', () => {
  const h = harness()
  const before = h.service.getState()

  for (const speed of [
    null, '', 'fast', 'FORM', ' casual ', 'toString', '__proto__',
    0, false, {}, [], new String('casual'),
  ]) {
    assertTrainingError(
      () => h.service.startRound(speed),
      'Choose a round speed: form, casual, or intense.',
    )
    assert.deepEqual(h.service.getState(), before)
  }

  h.service.startRound()
  const running = h.service.getState()
  assertTrainingError(
    () => h.service.startRound('invalid'),
    'Choose a round speed: form, casual, or intense.',
  )
  assert.deepEqual(h.service.getState(), running)
})

test('start is idempotent while running or paused and preserves the chosen speed', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(1250)

  const running = h.service.getState()
  assert.deepEqual(h.service.startRound('intense'), running)
  assert.equal(h.idCount(), 1)

  const paused = h.service.pauseRound()
  h.advance(5000)
  assert.deepEqual(h.service.startRound('casual'), paused)
  assert.equal(h.idCount(), 1)
  assert.equal(h.service.getGeneration(), 2)
})

test('timer rounds elapsed down and remaining time up, using the monotonic clock', () => {
  const h = harness()
  h.service.startRound()
  h.advance(999)

  let state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)

  h.advance(1)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)

  h.shiftWall(24 * 60 * 60 * 1000)
  assert.deepEqual(h.service.getState(), state)
})

test('pause and resume exclude multiple paused intervals from round duration', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1250)

  const paused = h.service.pauseRound()
  assert.equal(paused.round.status, 'paused')
  assert.equal(paused.round.isRunning, false)
  assert.equal(paused.round.generation, 2)
  assert.equal(paused.round.elapsedSeconds, 1)
  assert.equal(paused.round.timeLeftSeconds, 179)

  h.advance(200_000)
  assert.deepEqual(h.service.getState(), paused)
  assert.deepEqual(h.service.pauseRound(), paused)
  assert.deepEqual(h.service.takeCompletions(), [])

  const resumed = h.service.resumeRound()
  assert.equal(resumed.round.status, 'running')
  assert.equal(resumed.round.isRunning, true)
  assert.equal(resumed.round.generation, 3)
  assert.equal(resumed.round.elapsedSeconds, 1)
  assert.deepEqual(h.service.resumeRound(), resumed)

  h.advance(750)
  assert.equal(h.service.pauseRound().round.elapsedSeconds, 2)
  h.advance(8000)
  h.service.resumeRound()
  h.advance(500)

  const ended = h.service.endRound()
  assert.equal(ended.session.durationSeconds, 2.5)
  assert.equal(ended.state.round.elapsedSeconds, 2)
  assert.equal(ended.state.round.timeLeftSeconds, 178)
  assert.equal(ended.state.round.generation, 6)
})

test('pause, resume, and end are harmless before a round starts', () => {
  const h = harness()
  const ready = h.service.getState()

  assert.deepEqual(h.service.pauseRound(), ready)
  assert.deepEqual(h.service.resumeRound(), ready)
  assert.deepEqual(h.service.endRound(), { state: ready, session: null })
  assert.equal(h.service.getGeneration(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('manual end records fractional active duration and freezes the completed session', () => {
  const h = harness()
  const started = h.service.startRound('intense')
  h.advance(1250)
  const { state, session } = h.service.endRound()

  assert.deepEqual(session, {
    schemaVersion: 1,
    id: started.round.id,
    startedAt: started.round.startedAt,
    endedAt: new Date(h.wallNow()).toISOString(),
    roundDurationSeconds: 180,
    durationSeconds: 1.25,
    comboStats: ZERO_STATS,
    details: { speed: 'intense', punchCounts: ZERO_COUNTS },
  })
  assert.equal(state.round.status, 'ended')
  assert.equal(state.round.isRunning, false)
  assert.equal(state.round.generation, 2)
  assert.equal(state.round.endedAt, session.endedAt)
  assert.strictEqual(state.session.completedSession, session)

  for (const value of [
    session, session.comboStats, session.details, session.details.punchCounts,
  ]) {
    assert.equal(Object.isFrozen(value), true)
  }
  assert.throws(() => { session.durationSeconds = 99 }, TypeError)
  assert.throws(() => { session.comboStats.total = 99 }, TypeError)
  assert.throws(() => { session.details.speed = 'form' }, TypeError)
  assert.throws(() => { session.details.punchCounts.jab = 99 }, TypeError)

  h.advance(10_000)
  const repeated = h.service.endRound()
  assert.strictEqual(repeated.session, session)
  assert.deepEqual(repeated.state, state)
  assert.deepEqual(h.service.pauseRound(), state)
  assert.deepEqual(h.service.resumeRound(), state)
  assert.deepEqual(h.service.takeCompletions(), [session])
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('ending while paused excludes the unfinished pause', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1500)
  h.service.pauseRound()
  h.advance(20_000)

  const { state, session } = h.service.endRound()
  assert.equal(session.durationSeconds, 1.5)
  assert.equal(session.endedAt, new Date(h.wallNow()).toISOString())
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)
  assert.equal(state.round.generation, 3)
})

test('a round can end immediately with zero duration', () => {
  const h = harness()
  h.service.startRound()
  const { session } = h.service.endRound()
  assert.equal(session.durationSeconds, 0)
  assert.equal(session.startedAt, session.endedAt)
})

test('getState completes a round exactly at its duration, once', () => {
  const h = harness()
  h.service.startRound()
  h.advance(179_999)

  const before = h.service.getState()
  assert.equal(before.round.status, 'running')
  assert.equal(before.round.elapsedSeconds, 179)
  assert.equal(before.round.timeLeftSeconds, 1)
  assert.deepEqual(h.service.takeCompletions(), [])

  h.advance(1)
  const ended = h.service.getState()
  assert.equal(ended.round.status, 'ended')
  assert.equal(ended.round.generation, 2)
  assert.equal(ended.round.elapsedSeconds, 180)
  assert.equal(ended.round.timeLeftSeconds, 0)
  assert.equal(ended.session.completedSession.durationSeconds, 180)

  assert.deepEqual(h.service.takeCompletions(), [ended.session.completedSession])
  h.advance(5000)
  assert.deepEqual(h.service.getState(), ended)
  assert.deepEqual(h.service.takeCompletions(), [])
})

for (const trigger of ['getState', 'pauseRound', 'resumeRound', 'endRound', 'submitFrame']) {
  test(`${trigger} handles an overdue round and caps its duration`, () => {
    const h = harness()
    h.service.startRound()
    h.advance(190_000)

    let state
    if (trigger === 'submitFrame') {
      const result = h.service.submitFrame(null)
      assert.equal(result.accepted, false)
      assert.equal(result.punchEvent, null)
      state = result.state
    } else if (trigger === 'endRound') {
      state = h.service.endRound().state
    } else {
      state = h.service[trigger]()
    }

    assert.equal(state.round.status, 'ended')
    assert.equal(state.round.generation, 2)
    assert.equal(state.round.elapsedSeconds, 180)
    assert.equal(state.round.timeLeftSeconds, 0)
    assert.equal(state.session.completedSession.durationSeconds, 180)
    assert.equal(
      state.session.completedSession.endedAt,
      new Date(h.wallNow()).toISOString(),
    )
    assert.equal(h.service.takeCompletions().length, 1)
    assert.deepEqual(h.service.takeCompletions(), [])
  })
}

test('starting after expiry queues the previous completion and creates a fresh round', () => {
  const h = harness()
  const first = h.service.startRound('form')
  h.advance(180_000)

  const next = h.service.startRound('intense')
  assert.equal(next.round.id, 'id-2')
  assert.equal(next.round.generation, 3)
  assert.equal(next.round.status, 'running')
  assert.equal(next.round.speed, 'intense')
  assert.equal(next.round.elapsedSeconds, 0)
  assert.equal(next.round.timeLeftSeconds, 180)
  assert.equal(next.session.completedSession, null)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0].id, first.round.id)
  assert.equal(completions[0].durationSeconds, 180)
})

test('reset discards active progress, preserves speed, and invalidates its generation', () => {
  const h = harness()
  h.service.startRound('form')
  punch(h, 'left')
  h.service.pauseRound()
  const previousGeneration = h.service.getGeneration()
  h.setRandom(0.4)

  const reset = h.service.resetRound()
  assert.equal(reset.round.status, 'ready')
  assert.equal(reset.round.speed, 'form')
  assert.equal(reset.round.frameIntervalMs, 80)
  assert.equal(reset.round.generation, previousGeneration + 1)
  assert.equal(reset.round.id, null)
  assert.equal(reset.round.startedAt, null)
  assert.equal(reset.round.endedAt, null)
  assert.equal(reset.round.elapsedSeconds, 0)
  assert.equal(reset.round.timeLeftSeconds, 180)
  assert.deepEqual(reset.currentCombo, ['uppercut', 'hook'])
  assert.equal(reset.comboStepIndex, 0)
  assert.equal(reset.comboResult, 'idle')
  assert.deepEqual(reset.comboStats, ZERO_STATS)
  assert.deepEqual(reset.punchCounts, ZERO_COUNTS)
  assert.deepEqual(reset.debugRows, [])
  assert.equal(reset.lastPunchEvent, null)
  assert.equal(reset.session.completedSession, null)
  assert.deepEqual(h.service.takeCompletions(), [])

  assert.equal(h.service.resetRound().round.generation, previousGeneration + 2)
})

test('reset refreshes an expired round and retains its queued completion', () => {
  const h = harness()
  const first = h.service.startRound('form')
  h.advance(180_000)

  const reset = h.service.resetRound()
  assert.equal(reset.round.status, 'ready')
  assert.equal(reset.round.generation, 3)
  assert.equal(reset.round.speed, 'form')
  assert.equal(reset.session.completedSession, null)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0].id, first.round.id)
  assert.equal(completions[0].durationSeconds, 180)
})

test('completion queue survives reset and restart, drains in order, and can refill', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1000)
  const first = h.service.endRound().session
  h.service.resetRound()

  h.service.startRound('form')
  h.advance(2000)
  const second = h.service.endRound().session

  const drained = h.service.takeCompletions()
  assert.deepEqual(drained, [first, second])
  assert.notEqual(first.id, second.id)
  assert.deepEqual(h.service.takeCompletions(), [])
  drained.length = 0

  h.service.startRound('intense')
  const third = h.service.endRound().session
  assert.deepEqual(h.service.takeCompletions(), [third])
  assert.equal(first.durationSeconds, 1)
  assert.equal(second.durationSeconds, 2)
})

test('non-running and stale submissions are rejected before validation', () => {
  const h = harness()
  const assertRejected = (result) => {
    assert.equal(result.accepted, false)
    assert.equal(result.punchEvent, null)
  }

  assertRejected(h.service.submitFrame(null))
  const started = h.service.startRound()
  const originalGeneration = started.round.generation
  const before = h.service.getState()

  assertRejected(h.service.submitFrame(null, originalGeneration - 1))
  assert.deepEqual(h.service.getState(), before)

  h.service.pauseRound()
  assertRejected(h.service.submitFrame(null))
  h.service.resumeRound()
  assertRejected(h.service.submitFrame(null, originalGeneration))

  const resumedGeneration = h.service.getGeneration()
  assert.equal(
    h.service.submitFrame(quietFrame(h.now()), resumedGeneration).accepted,
    true,
  )

  h.service.resetRound()
  h.service.startRound()
  assertRejected(h.service.submitFrame(null, resumedGeneration))
  assert.equal(h.service.submitFrame(quietFrame(h.now())).accepted, true)

  h.service.endRound()
  assertRejected(h.service.submitFrame(null))
})

test('invalid running-frame payloads throw TrainingError without mutating state', () => {
  const h = harness()
  h.service.startRound()
  const keypointMessage =
    'Each keypoint must include name, numeric x, and numeric y values.'
  const worldMessage =
    'keypoints3D must contain named points with numeric x, y, and z values.'
  const timeMessage = 'A monotonic frame timestamp is required.'

  const cases = [
    [null, 'Pose frame must be an object.'],
    [undefined, 'Pose frame must be an object.'],
    ['frame', 'Pose frame must be an object.'],
    [{}, 'keypoints must be a non-empty array.'],
    [{ time: h.now(), keypoints: [] }, 'keypoints must be a non-empty array.'],
    [{ time: h.now(), keypoints: {} }, 'keypoints must be a non-empty array.'],
  ]

  for (const point of [
    null,
    {},
    { name: ' ', x: 1, y: 2 },
    { name: 1, x: 1, y: 2 },
    { name: 'nose', x: '1', y: 2 },
    { name: 'nose', x: 1, y: NaN },
    { name: 'nose', x: Infinity, y: 2 },
    { name: 'nose', x: 1, y: 2, z: Infinity },
    { name: 'nose', x: 1, y: 2, score: 'high' },
  ]) {
    cases.push([{ time: h.now(), keypoints: [point] }, keypointMessage])
  }

  for (const keypoints3D of [
    {},
    [null],
    [{ name: 'nose', x: 1, y: 2 }],
    [{ name: 'nose', x: 1, y: 2, z: NaN }],
  ]) {
    cases.push([{ ...quietFrame(h.now()), keypoints3D }, worldMessage])
  }

  for (const time of [undefined, null, -1, '1000', NaN, Infinity, -Infinity]) {
    cases.push([quietFrame(time), timeMessage])
  }

  const before = h.service.getState()
  for (const [frame, message] of cases) {
    assertTrainingError(() => h.service.submitFrame(frame), message)
    assert.deepEqual(h.service.getState(), before)
  }
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('accepts valid optional point fields and optional 3D arrays', () => {
  const h = harness()
  h.service.startRound()

  for (const keypoints3D of [
    undefined,
    null,
    [],
    [{ name: 'nose', x: 0, y: 0, z: 0 }],
  ]) {
    h.advance(1)
    const result = h.service.submitFrame({
      time: h.now(),
      keypoints: [{ name: 'nose', x: 0, y: 0, z: null, score: null }],
      keypoints3D,
    })
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    assert.deepEqual(result.state.punchCounts, ZERO_COUNTS)
  }
})

test('accepts timestamp boundaries and rejects old, future, duplicate, and unordered frames', () => {
  const h = harness()
  h.service.startRound()
  const startedAt = h.now()

  const assertRejectedUnchanged = (time) => {
    const before = h.service.getState()
    const result = h.service.submitFrame(quietFrame(time))
    assert.equal(result.accepted, false)
    assert.equal(result.punchEvent, null)
    assert.deepEqual(result.state, before)
  }

  assertRejectedUnchanged(startedAt - 1)
  assertRejectedUnchanged(startedAt + 1)
  assert.equal(h.service.submitFrame(quietFrame(startedAt)).accepted, true)
  assertRejectedUnchanged(startedAt)

  h.advance(100)
  assert.equal(h.service.submitFrame(quietFrame(startedAt + 50)).accepted, true)
  assertRejectedUnchanged(startedAt + 49)
  assertRejectedUnchanged(startedAt + 50)
  assertRejectedUnchanged(h.now() + 1)
  assert.equal(h.service.submitFrame(quietFrame(h.now())).accepted, true)
  assert.deepEqual(h.service.getState().punchCounts, ZERO_COUNTS)
})

test('recognized punches update counts, events, combo progress, and the final session', () => {
  const h = harness()
  h.service.startRound()

  const jab = punch(h, 'left')
  assert.deepEqual(jab.punchEvent, {
    id: 'id-2',
    punch: 'jab',
    side: 'left',
    score: 100,
    expected: 'jab',
    expectedIndex: 0,
    matched: true,
    comboLocked: false,
    detectedAt: new Date(h.wallNow()).toISOString(),
  })
  assert.deepEqual(jab.state.lastPunchEvent, jab.punchEvent)
  assert.equal(jab.state.comboStepIndex, 1)
  assert.equal(jab.state.comboResult, 'active')
  assert.deepEqual(jab.state.comboStats, ZERO_STATS)
  assert.deepEqual(jab.state.punchCounts, { ...ZERO_COUNTS, jab: 1 })
  assert.equal(jab.state.debugRows.length, 2)

  const cross = punch(h, 'right')
  assert.equal(cross.punchEvent.id, 'id-3')
  assert.equal(cross.punchEvent.expected, 'cross')
  assert.equal(cross.punchEvent.expectedIndex, 1)
  assert.equal(cross.punchEvent.matched, true)
  assert.equal(cross.state.comboStepIndex, 2)
  assert.equal(cross.state.comboResult, 'success')
  assert.deepEqual(cross.state.comboStats, { succeeded: 1, failed: 0, total: 1 })
  assert.deepEqual(cross.state.punchCounts, { ...ZERO_COUNTS, jab: 1, cross: 1 })

  const locked = punch(h, 'left')
  assert.equal(locked.punchEvent.comboLocked, true)
  assert.equal(locked.punchEvent.matched, false)
  assert.equal(locked.punchEvent.expected, null)
  assert.equal(locked.punchEvent.expectedIndex, 2)
  assert.equal(locked.state.comboStepIndex, 2)
  assert.equal(locked.state.comboResult, 'success')
  assert.deepEqual(locked.state.comboStats, cross.state.comboStats)
  assert.deepEqual(locked.state.punchCounts, { ...ZERO_COUNTS, jab: 2, cross: 1 })

  const { session } = h.service.endRound()
  assert.deepEqual(session.comboStats, { succeeded: 1, failed: 0, total: 1 })
  assert.deepEqual(session.details.punchCounts, { ...ZERO_COUNTS, jab: 2, cross: 1 })
})

for (const [speed, delay] of [
  ['form', 1000],
  ['casual', 650],
  ['intense', 350],
]) {
  test(`a wrong punch fails the combo and releases it after the ${speed} delay`, () => {
    const h = harness()
    h.service.startRound(speed)
    const wrong = punch(h, 'right')

    assert.equal(wrong.punchEvent.expected, 'jab')
    assert.equal(wrong.punchEvent.matched, false)
    assert.equal(wrong.punchEvent.comboLocked, false)
    assert.equal(wrong.state.comboStepIndex, 0)
    assert.equal(wrong.state.comboResult, 'failed')
    assert.deepEqual(wrong.state.comboStats, { succeeded: 0, failed: 1, total: 1 })
    assert.deepEqual(wrong.state.punchCounts, { ...ZERO_COUNTS, cross: 1 })

    h.setRandom(0.4)
    h.advance(delay - 1)
    assert.equal(h.service.getState().comboResult, 'failed')
    assert.deepEqual(h.service.getState().currentCombo, ['jab', 'cross'])

    h.advance(1)
    const released = h.service.getState()
    assert.equal(released.comboResult, 'idle')
    assert.equal(released.comboStepIndex, 0)
    assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
    assert.deepEqual(released.comboStats, wrong.state.comboStats)
    assert.deepEqual(released.punchCounts, wrong.state.punchCounts)
    assert.deepEqual(released.lastPunchEvent, wrong.punchEvent)
    assert.equal(released.round.generation, 1)
  })
}

test('pausing suspends the combo lock and resuming preserves its remaining delay', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'right')
  h.advance(100)
  const paused = h.service.pauseRound()

  h.setRandom(0.4)
  h.advance(5000)
  assert.deepEqual(h.service.getState(), paused)

  h.service.resumeRound()
  h.advance(549)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.advance(1)
  const released = h.service.getState()
  assert.equal(released.comboResult, 'idle')
  assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
})

test('pause and resume clear motion history so a partial punch cannot span a pause', () => {
  const h = harness()
  h.service.startRound()

  for (const stage of [0, 1]) {
    h.advance(50)
    assert.equal(
      h.service.submitFrame(poseFrame(h.now(), 'left', stage)).punchEvent,
      null,
    )
  }

  h.service.pauseRound()
  h.advance(10)
  h.service.resumeRound()
  h.advance(50)

  const firstAfterResume = h.service.submitFrame(poseFrame(h.now(), 'left', 2))
  assert.equal(firstAfterResume.accepted, true)
  assert.equal(firstAfterResume.punchEvent, null)
  assert.deepEqual(firstAfterResume.state.debugRows, [])
  assert.deepEqual(firstAfterResume.state.punchCounts, ZERO_COUNTS)

  h.advance(50)
  assert.equal(
    h.service.submitFrame(poseFrame(h.now(), 'left', 0)).punchEvent,
    null,
  )
  h.advance(50)
  const freshPunch = h.service.submitFrame(poseFrame(h.now(), 'left', 2))
  assert.equal(freshPunch.punchEvent.punch, 'jab')
})

test('accepted frame data is copied before it enters motion history', () => {
  const h = harness()
  h.service.startRound()

  for (const stage of [0, 1]) {
    h.advance(50)
    const frame = poseFrame(h.now(), 'left', stage)
    assert.equal(h.service.submitFrame(frame).accepted, true)

    const wrist = frame.keypoints.find((point) => point.name === 'left_wrist')
    wrist.x = 0
    wrist.y = 100
    frame.time = 0
  }

  h.advance(50)
  const result = h.service.submitFrame(poseFrame(h.now(), 'left', 2))
  assert.equal(result.punchEvent.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
})

test('serialized snapshots isolate mutable nested data from service state', () => {
  const h = harness()
  const initial = h.service.getState()
  h.service.startRound()
  punch(h, 'left')

  const snapshot = h.service.getState()
  const expected = structuredClone(snapshot)

  snapshot.round.status = 'ready'
  snapshot.currentCombo[0] = 'uppercut'
  snapshot.comboStats.failed = 100
  snapshot.punchCounts.jab = 100
  snapshot.lastPunchEvent.matched = false
  snapshot.debugRows[0].scoreByType.jab = -100
  snapshot.debugRows[0].cues.straight2D = false
  snapshot.debugRows.push({ side: 'extra' })
  snapshot.session.completedSession = { id: 'fake' }

  assert.deepEqual(h.service.getState(), expected)
  assert.equal(initial.round.status, 'ready')
  assert.deepEqual(initial.punchCounts, ZERO_COUNTS)
  assert.deepEqual(initial.debugRows, [])
})

test('restarting clears previous statistics and leaves the completed session unchanged', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'left')
  const completed = h.service.endRound().session

  const restarted = h.service.startRound('intense')
  assert.equal(restarted.round.status, 'running')
  assert.equal(restarted.round.generation, 3)
  assert.notEqual(restarted.round.id, completed.id)
  assert.equal(restarted.comboStepIndex, 0)
  assert.equal(restarted.comboResult, 'idle')
  assert.deepEqual(restarted.comboStats, ZERO_STATS)
  assert.deepEqual(restarted.punchCounts, ZERO_COUNTS)
  assert.deepEqual(restarted.debugRows, [])
  assert.equal(restarted.lastPunchEvent, null)
  assert.equal(restarted.session.completedSession, null)
  assert.equal(completed.details.punchCounts.jab, 1)
  assert.deepEqual(h.service.takeCompletions(), [completed])
})

test('separate service instances keep state, generations, and completions independent', () => {
  const first = harness()
  const second = harness()
  const secondInitial = second.service.getState()

  first.service.startRound()
  punch(first, 'left')
  first.service.endRound()

  assert.deepEqual(second.service.getState(), secondInitial)
  assert.equal(second.service.getGeneration(), 0)
  assert.deepEqual(second.service.takeCompletions(), [])
  assert.equal(first.service.takeCompletions().length, 1)
})
