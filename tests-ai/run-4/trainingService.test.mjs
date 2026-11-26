import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUND_SECONDS,
  TrainingError,
  createTrainingService,
} from '../../frontend/src/training/trainingService.js'

const WALL_START = Date.UTC(2026, 0, 1)
const EMPTY_COUNTS = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
const EMPTY_STATS = { succeeded: 0, failed: 0, total: 0 }
const SPEEDS = [
  { speed: 'form', interval: 80, delay: 1000 },
  { speed: 'casual', interval: 50, delay: 650 },
  { speed: 'intense', interval: 25, delay: 350 },
]

function harness() {
  let time = 1000
  let wallTime = WALL_START
  let randomValue = 0
  let idCount = 0

  const service = createTrainingService({
    now: () => time,
    wallNow: () => wallTime,
    random: () => randomValue,
    createId: () => `id-${++idCount}`,
  })

  const setTime = (value) => {
    wallTime += value - time
    time = value
  }

  return {
    service,
    get time() {
      return time
    },
    get wallTime() {
      return wallTime
    },
    get idCount() {
      return idCount
    },
    setTime,
    advance: (milliseconds) => setTime(time + milliseconds),
    setWallTime: (value) => {
      wallTime = value
    },
    setRandom: (value) => {
      randomValue = value
    },
  }
}

function readyState(speed = 'casual', generation = 0) {
  return {
    round: {
      id: null,
      generation,
      status: 'ready',
      speed,
      frameIntervalMs: SPEEDS.find((entry) => entry.speed === speed).interval,
      isRunning: false,
      startedAt: null,
      endedAt: null,
      durationSeconds: 180,
      elapsedSeconds: 0,
      timeLeftSeconds: 180,
    },
    currentCombo: ['jab', 'cross'],
    comboStepIndex: 0,
    comboStats: { ...EMPTY_STATS },
    comboResult: 'idle',
    lastPunchEvent: null,
    punchCounts: { ...EMPTY_COUNTS },
    debugRows: [],
    session: { completedSession: null },
  }
}

function minimalFrame(time) {
  return { time, keypoints: [{ name: 'nose', x: 150, y: 50 }] }
}

// Anatomical left/right arms begin folded and extend horizontally.
// Three frames provide sufficient history for a straight-punch detection.
function pose(time, extendedSide = null) {
  const point = (name, x, y) => ({ name, x, y, score: 1 })
  return {
    time,
    keypoints: [
      point('nose', 150, 50),
      point('left_shoulder', 100, 100),
      point('right_shoulder', 200, 100),
      point('left_hip', 100, 250),
      point('right_hip', 200, 250),
      point(
        'left_elbow',
        extendedSide === 'left' ? 40 : 100,
        extendedSide === 'left' ? 100 : 150,
      ),
      point('left_wrist', extendedSide === 'left' ? -20 : 125, 100),
      point(
        'right_elbow',
        extendedSide === 'right' ? 260 : 200,
        extendedSide === 'right' ? 100 : 150,
      ),
      point('right_wrist', extendedSide === 'right' ? 320 : 175, 100),
    ],
  }
}

function worldPose(time, extended = false) {
  return {
    ...pose(time),
    keypoints3D: [
      { name: 'left_shoulder', x: 0, y: 0, z: 0, score: 1 },
      { name: 'left_elbow', x: 0.3, y: 0, z: 0, score: 1 },
      {
        name: 'left_wrist',
        x: extended ? 0.6 : 0.1,
        y: extended ? 0 : 0.1,
        z: 0,
        score: 1,
      },
    ],
  }
}

function submitAt(h, frame, generation) {
  h.setTime(frame.time)
  return h.service.submitFrame(frame, generation)
}

function punch(h, side, start = h.time) {
  for (const time of [start, start + 50]) {
    const result = submitAt(h, pose(time))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  const result = submitAt(h, pose(start + 100, side))
  assert.equal(result.accepted, true)
  assert.ok(result.punchEvent)
  assert.equal(result.punchEvent.punch, side === 'left' ? 'jab' : 'cross')
  assert.equal(result.punchEvent.side, side)
  return result
}

function assertRejected(result) {
  assert.equal(result.accepted, false)
  assert.equal(result.punchEvent, null)
}

function assertTrainingError(action, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error)
    assert.ok(error instanceof TrainingError)
    assert.equal(error.name, 'TrainingError')
    assert.equal(error.message, message)
    return true
  })
}

test('exports the round duration and a recognizable TrainingError', () => {
  assert.equal(ROUND_SECONDS, 180)
  const error = new TrainingError('Invalid training input')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'TrainingError')
  assert.equal(error.message, 'Invalid training input')
})

test('supports construction with default dependencies', () => {
  const service = createTrainingService()
  const state = service.getState()
  assert.equal(state.round.status, 'ready')
  assert.equal(state.round.speed, 'casual')
  assert.equal(state.round.durationSeconds, ROUND_SECONDS)
  assert.equal(service.getGeneration(), 0)
  assert.deepEqual(service.takeCompletions(), [])
})

test('initial state is ready and does not accumulate elapsed time', () => {
  const h = harness()
  assert.deepEqual(h.service.getState(), readyState())
  h.advance(500_000)
  assert.deepEqual(h.service.getState(), readyState())
  assert.equal(h.idCount, 0)
  assert.equal(h.service.getGeneration(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('ready-state pause, resume, and end operations are harmless', () => {
  const h = harness()
  assert.deepEqual(h.service.pauseRound(), readyState())
  assert.deepEqual(h.service.resumeRound(), readyState())
  assert.deepEqual(h.service.endRound(), {
    state: readyState(),
    session: null,
  })
  assert.deepEqual(h.service.takeCompletions(), [])
})

for (const { speed, interval } of SPEEDS) {
  test(`starts a ${speed} round with its configured frame interval`, () => {
    const h = harness()
    const state = h.service.startRound(speed)
    assert.deepEqual(state, {
      ...readyState(speed, 1),
      round: {
        ...readyState(speed, 1).round,
        id: 'id-1',
        status: 'running',
        isRunning: true,
        startedAt: new Date(WALL_START).toISOString(),
        frameIntervalMs: interval,
      },
    })
    assert.equal(h.idCount, 1)
    assert.equal(h.service.getGeneration(), 1)
  })
}

test('startRound defaults to casual and uses the injected random source', () => {
  const h = harness()
  h.setRandom(0.4)
  const state = h.service.startRound()
  assert.equal(state.round.speed, 'casual')
  assert.deepEqual(state.currentCombo, ['uppercut', 'hook'])
})

test('invalid speeds throw without altering an active round', () => {
  const h = harness()
  h.service.startRound('form')
  const before = h.service.getState()

  for (const speed of [
    '',
    'fast',
    'FORM',
    'toString',
    '__proto__',
    null,
    0,
    true,
    {},
    [],
    new String('casual'),
    Symbol('casual'),
  ]) {
    assertTrainingError(
      () => h.service.startRound(speed),
      'Choose a round speed: form, casual, or intense.',
    )
    assert.deepEqual(h.service.getState(), before)
    assert.equal(h.idCount, 1)
  }
})

test('starting an active or paused round preserves its identity and speed', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(1500)
  const running = h.service.getState()
  assert.deepEqual(h.service.startRound('intense'), running)
  assert.deepEqual(h.service.resumeRound(), running)

  const paused = h.service.pauseRound()
  h.advance(5000)
  assert.deepEqual(h.service.startRound('casual'), paused)
  assert.deepEqual(h.service.pauseRound(), paused)
  assert.equal(h.idCount, 1)
  assert.equal(h.service.getGeneration(), 2)
})

test('elapsed time is floored and remaining time is rounded up', () => {
  const h = harness()
  h.service.startRound()

  for (const [elapsed, elapsedSeconds, timeLeftSeconds] of [
    [0, 0, 180],
    [1, 0, 180],
    [999, 0, 180],
    [1000, 1, 179],
    [1001, 1, 179],
    [179_999, 179, 1],
  ]) {
    h.setTime(1000 + elapsed)
    const { round } = h.service.getState()
    assert.equal(round.elapsedSeconds, elapsedSeconds)
    assert.equal(round.timeLeftSeconds, timeLeftSeconds)
    assert.equal(round.status, 'running')
    assert.equal(round.generation, 1)
  }
})

test('pauses freeze time and multiple resumed pauses are excluded', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1250)

  const firstPause = h.service.pauseRound()
  assert.equal(firstPause.round.status, 'paused')
  assert.equal(firstPause.round.isRunning, false)
  assert.equal(firstPause.round.elapsedSeconds, 1)
  assert.equal(firstPause.round.timeLeftSeconds, 179)
  assert.equal(firstPause.round.generation, 2)

  h.advance(200_000)
  assert.deepEqual(h.service.getState(), firstPause)
  const resumed = h.service.resumeRound()
  assert.equal(resumed.round.status, 'running')
  assert.equal(resumed.round.generation, 3)

  h.advance(750)
  const secondPause = h.service.pauseRound()
  assert.equal(secondPause.round.elapsedSeconds, 2)
  assert.equal(secondPause.round.generation, 4)
  h.advance(7000)
  h.service.resumeRound()
  h.advance(500)

  const { state, session } = h.service.endRound()
  assert.equal(state.round.generation, 6)
  assert.equal(session.durationSeconds, 2.5)
  assert.equal(state.round.elapsedSeconds, 2)
  assert.equal(state.round.timeLeftSeconds, 178)
})

test('ending while paused excludes the ongoing pause', () => {
  const h = harness()
  h.service.startRound('intense')
  h.advance(1750)
  h.service.pauseRound()
  h.advance(300_000)

  const result = h.service.endRound()
  assert.equal(result.session.durationSeconds, 1.75)
  assert.equal(result.session.endedAt, new Date(h.wallTime).toISOString())
  assert.equal(result.state.round.status, 'ended')
  assert.equal(result.state.round.isRunning, false)
  assert.equal(result.state.round.generation, 3)

  const ended = result.state
  h.advance(1000)
  assert.deepEqual(h.service.getState(), ended)
  assert.deepEqual(h.service.pauseRound(), ended)
  assert.deepEqual(h.service.resumeRound(), ended)
})

test('wall-clock changes affect timestamps but not elapsed duration', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1250)
  h.setWallTime(WALL_START - 60_000)

  const { session } = h.service.endRound()
  assert.equal(session.startedAt, new Date(WALL_START).toISOString())
  assert.equal(session.endedAt, new Date(WALL_START - 60_000).toISOString())
  assert.equal(session.durationSeconds, 1.25)
})

test('getState completes the round exactly at the deadline, once', () => {
  const h = harness()
  h.service.startRound()
  h.advance(ROUND_SECONDS * 1000)

  const state = h.service.getState()
  const completed = state.session.completedSession
  assert.equal(state.round.status, 'ended')
  assert.equal(state.round.generation, 2)
  assert.equal(state.round.elapsedSeconds, 180)
  assert.equal(state.round.timeLeftSeconds, 0)
  assert.equal(completed.durationSeconds, 180)
  assert.equal(completed.endedAt, new Date(h.wallTime).toISOString())

  h.advance(20_000)
  assert.deepEqual(h.service.getState(), state)
  assert.strictEqual(h.service.endRound().session, completed)
  assert.deepEqual(h.service.takeCompletions(), [completed])
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('manual completion after an overrun caps duration at 180 seconds', () => {
  const h = harness()
  h.service.startRound()
  h.advance(250_500)

  const { state, session } = h.service.endRound()
  assert.equal(session.durationSeconds, 180)
  assert.equal(session.roundDurationSeconds, 180)
  assert.equal(session.endedAt, new Date(h.wallTime).toISOString())
  assert.equal(state.round.elapsedSeconds, 180)
  assert.equal(state.round.timeLeftSeconds, 0)
})

test('starting an expired round queues its completion and starts a fresh round', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(180_000)

  const state = h.service.startRound('intense')
  assert.equal(state.round.id, 'id-2')
  assert.equal(state.round.status, 'running')
  assert.equal(state.round.speed, 'intense')
  assert.equal(state.round.generation, 3)
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.session.completedSession, null)

  const [completed] = h.service.takeCompletions()
  assert.equal(completed.id, 'id-1')
  assert.equal(completed.details.speed, 'form')
  assert.equal(completed.durationSeconds, 180)
})

test('reset clears round data, preserves speed, and abandons an unfinished round', () => {
  const h = harness()
  h.service.startRound('intense')
  punch(h, 'left')
  h.service.pauseRound()

  assert.deepEqual(h.service.resetRound(), readyState('intense', 3))
  assert.deepEqual(h.service.takeCompletions(), [])
  assert.deepEqual(h.service.resetRound(), readyState('intense', 4))

  // A new start without a speed argument uses the default.
  assert.equal(h.service.startRound().round.speed, 'casual')
})

test('reset first completes an expired round and preserves its queued session', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(181_000)

  assert.deepEqual(h.service.resetRound(), readyState('form', 3))
  const completed = h.service.takeCompletions()
  assert.equal(completed.length, 1)
  assert.equal(completed[0].durationSeconds, 180)
})

test('completion queue drains in order and is independent of subsequent resets', () => {
  const h = harness()
  h.service.startRound()
  h.advance(1500)
  const first = h.service.endRound().session
  assert.strictEqual(h.service.endRound().session, first)

  h.service.resetRound()
  h.service.startRound('form')
  h.advance(2500)
  const second = h.service.endRound().session
  h.service.resetRound()

  const queue = h.service.takeCompletions()
  assert.equal(queue.length, 2)
  assert.strictEqual(queue[0], first)
  assert.strictEqual(queue[1], second)
  assert.notEqual(first.id, second.id)
  assert.deepEqual(h.service.takeCompletions(), [])

  queue.push(first)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('frames are rejected without validation outside a running round', () => {
  const h = harness()
  assertRejected(h.service.submitFrame(null))
  h.service.startRound()
  h.service.pauseRound()
  assertRejected(h.service.submitFrame(null))
  h.service.endRound()
  assertRejected(h.service.submitFrame(null))
  assert.deepEqual(h.service.getState().punchCounts, EMPTY_COUNTS)
})

test('generation tokens reject stale frames after pause, resume, reset, and restart', () => {
  const h = harness()
  const firstGeneration = h.service.startRound().round.generation
  h.service.pauseRound()
  const pausedGeneration = h.service.getGeneration()
  h.service.resumeRound()

  assertRejected(h.service.submitFrame(null, firstGeneration))
  assertRejected(h.service.submitFrame(null, pausedGeneration))
  const resumedGeneration = h.service.getGeneration()
  assert.equal(
    h.service.submitFrame(minimalFrame(h.time), resumedGeneration).accepted,
    true,
  )

  h.service.resetRound()
  h.service.startRound()
  assertRejected(h.service.submitFrame(null, resumedGeneration))
  assert.equal(h.service.submitFrame(minimalFrame(h.time)).accepted, true)
})

test('a frame arriving at the deadline ends the round before payload validation', () => {
  const h = harness()
  const generation = h.service.startRound().round.generation
  h.advance(180_000)

  const result = h.service.submitFrame(null, generation)
  assertRejected(result)
  assert.equal(result.state.round.status, 'ended')
  assert.equal(result.state.round.generation, generation + 1)
  assert.equal(h.service.takeCompletions().length, 1)
})

test('frame timestamps must be within the round and strictly increase', () => {
  const h = harness()
  h.service.startRound()

  assertRejected(h.service.submitFrame(minimalFrame(999)))
  assertRejected(h.service.submitFrame(minimalFrame(1001)))
  assert.equal(h.service.submitFrame(minimalFrame(1000)).accepted, true)
  assertRejected(h.service.submitFrame(minimalFrame(1000)))

  h.advance(10)
  assert.equal(h.service.submitFrame(minimalFrame(1005)).accepted, true)
  assertRejected(h.service.submitFrame(minimalFrame(1004)))
  assertRejected(h.service.submitFrame(minimalFrame(1011)))
  assert.equal(h.service.submitFrame(minimalFrame(1010)).accepted, true)

  const state = h.service.getState()
  assert.deepEqual(state.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(state.comboStats, EMPTY_STATS)
  assert.equal(state.lastPunchEvent, null)
  assert.equal(state.round.generation, 1)
})

test('zero timestamps and valid optional keypoint fields are accepted', () => {
  const h = harness()
  h.setTime(0)
  h.service.startRound()

  assert.equal(
    h.service.submitFrame({
      time: 0,
      keypoints: [{ name: 'nose', x: 0, y: 0, z: null, score: null }],
      keypoints3D: [],
    }).accepted,
    true,
  )
})

test('malformed running-round frames throw TrainingError without altering state', () => {
  const h = harness()
  h.service.startRound()
  const point = { name: 'nose', x: 1, y: 2 }
  const invalidPointsMessage =
    'Each keypoint must include name, numeric x, and numeric y values.'
  const invalidWorldMessage =
    'keypoints3D must contain named points with numeric x, y, and z values.'

  const cases = [
    [null, 'Pose frame must be an object.'],
    [42, 'Pose frame must be an object.'],
    [{}, 'keypoints must be a non-empty array.'],
    [{ keypoints: [] }, 'keypoints must be a non-empty array.'],
    [{ keypoints: 'points' }, 'keypoints must be a non-empty array.'],
    ...[
      null,
      { ...point, name: ' ' },
      { ...point, name: 5 },
      { ...point, x: '1' },
      { ...point, y: Infinity },
      { ...point, z: NaN },
      { ...point, score: NaN },
    ].map((keypoint) => [
      { time: h.time, keypoints: [keypoint] },
      invalidPointsMessage,
    ]),
    ...[
      {},
      [point],
      [{ ...point, z: Infinity }],
      [{ ...point, z: 0, score: 'high' }],
    ].map((keypoints3D) => [
      { time: h.time, keypoints: [point], keypoints3D },
      invalidWorldMessage,
    ]),
    ...[undefined, -1, NaN, Infinity, '1000'].map((time) => [
      { time, keypoints: [point] },
      'A monotonic frame timestamp is required.',
    ]),
  ]

  const before = h.service.getState()
  for (const [payload, message] of cases) {
    assertTrainingError(() => h.service.submitFrame(payload), message)
    assert.deepEqual(h.service.getState(), before)
  }

  assert.equal(h.service.submitFrame(minimalFrame(h.time)).accepted, true)
})

test('accepted stationary frames do not create punches or combo outcomes', () => {
  const h = harness()
  h.service.startRound()

  for (let index = 0; index < 60; index += 1) {
    const result = submitAt(h, pose(1000 + index * 25))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  const state = h.service.getState()
  assert.equal(state.debugRows.length, 2)
  assert.deepEqual(state.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(state.comboStats, EMPTY_STATS)
  assert.equal(state.comboResult, 'idle')
  assert.equal(h.idCount, 1)
})

test('a detected jab updates counts, combo progress, and event metadata', () => {
  const h = harness()
  h.service.startRound()
  const result = punch(h, 'left')

  assert.deepEqual(result.punchEvent, {
    id: 'id-2',
    punch: 'jab',
    side: 'left',
    score: 100,
    expected: 'jab',
    expectedIndex: 0,
    matched: true,
    comboLocked: false,
    detectedAt: new Date(h.wallTime).toISOString(),
  })
  assert.deepEqual(result.state.lastPunchEvent, result.punchEvent)
  assert.deepEqual(result.state.punchCounts, { ...EMPTY_COUNTS, jab: 1 })
  assert.deepEqual(result.state.comboStats, EMPTY_STATS)
  assert.equal(result.state.comboStepIndex, 1)
  assert.equal(result.state.comboResult, 'active')
  assert.equal(result.state.round.generation, 1)
})

for (const { speed, delay } of SPEEDS) {
  test(`${speed} combo completion locks until its configured release time`, () => {
    const h = harness()
    h.service.startRound(speed)
    punch(h, 'left', 1000)
    const result = punch(h, 'right', 1200)

    assert.equal(result.punchEvent.matched, true)
    assert.equal(result.punchEvent.expected, 'cross')
    assert.equal(result.punchEvent.expectedIndex, 1)
    assert.equal(result.state.comboStepIndex, 2)
    assert.equal(result.state.comboResult, 'success')
    assert.deepEqual(result.state.comboStats, {
      succeeded: 1,
      failed: 0,
      total: 1,
    })
    assert.deepEqual(result.state.punchCounts, {
      ...EMPTY_COUNTS,
      jab: 1,
      cross: 1,
    })

    const completedAt = h.time
    h.setRandom(0.4)
    h.setTime(completedAt + delay - 1)
    assert.equal(h.service.getState().comboResult, 'success')
    h.advance(1)

    const released = h.service.getState()
    assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
    assert.equal(released.comboStepIndex, 0)
    assert.equal(released.comboResult, 'idle')
    assert.deepEqual(released.comboStats, result.state.comboStats)
    assert.deepEqual(released.lastPunchEvent, result.punchEvent)
    assert.equal(released.round.generation, 1)
    assert.deepEqual(h.service.takeCompletions(), [])
  })
}

test('a wrong punch fails the combo; punches during its lock still count', () => {
  const h = harness()
  h.service.startRound()
  const wrong = punch(h, 'right', 1000)
  assert.equal(wrong.punchEvent.expected, 'jab')
  assert.equal(wrong.punchEvent.matched, false)
  assert.equal(wrong.punchEvent.comboLocked, false)
  assert.equal(wrong.state.comboResult, 'failed')
  assert.equal(wrong.state.comboStepIndex, 0)
  assert.deepEqual(wrong.state.comboStats, {
    succeeded: 0,
    failed: 1,
    total: 1,
  })

  const locked = punch(h, 'left', 1200)
  assert.equal(locked.punchEvent.comboLocked, true)
  assert.equal(locked.punchEvent.matched, false)
  assert.deepEqual(locked.state.comboStats, wrong.state.comboStats)
  assert.deepEqual(locked.state.punchCounts, {
    ...EMPTY_COUNTS,
    jab: 1,
    cross: 1,
  })

  // The locked punch does not extend the original failure's delay.
  h.setTime(1749)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.setTime(1750)
  assert.equal(h.service.getState().comboResult, 'idle')
})

test('pausing preserves the remaining combo lock delay', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'right', 1000) // Failure locks until 1750.
  h.setTime(1200)
  h.service.pauseRound()

  h.advance(10_000)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.service.resumeRound()
  h.setRandom(0.4)

  h.advance(549)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.advance(1)
  const released = h.service.getState()
  assert.equal(released.comboResult, 'idle')
  assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
  assert.equal(released.round.generation, 3)
})

test('pause and resume clear motion history so pre-pause poses cannot form a punch', () => {
  const h = harness()
  h.service.startRound()
  submitAt(h, pose(1000))
  submitAt(h, pose(1050))
  h.setTime(1100)
  h.service.pauseRound()
  h.advance(50)
  h.service.resumeRound()

  for (const time of [1150, 1200, 1250]) {
    const result = submitAt(h, pose(time, 'left'))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  submitAt(h, pose(1300))
  const result = submitAt(h, pose(1350, 'left'))
  assert.equal(result.punchEvent.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
})

test('accepted 2D input is copied before being retained as motion history', () => {
  const h = harness()
  h.service.startRound()

  for (const time of [1000, 1050]) {
    const frame = pose(time)
    assert.equal(submitAt(h, frame).accepted, true)
    const extended = pose(time, 'left')
    frame.keypoints.forEach((point, index) => {
      Object.assign(point, extended.keypoints[index])
    })
  }

  const result = submitAt(h, pose(1100, 'left'))
  assert.equal(result.punchEvent.punch, 'jab')
})

test('3D pose data reaches classification and is copied before retention', () => {
  const h = harness()
  h.service.startRound()

  for (const time of [1000, 1050]) {
    const frame = worldPose(time)
    const result = submitAt(h, frame)
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    Object.assign(frame.keypoints3D[2], { x: 0.6, y: 0 })
  }

  const result = submitAt(h, worldPose(1100, true))
  assert.equal(result.punchEvent.punch, 'jab')
  const leftDebug = result.state.debugRows.find((row) => row.side === 'left')
  assert.equal(leftDebug.cues.straight2D, false)
  assert.equal(leftDebug.cues.straight3D, true)
})

test('returned snapshots cannot mutate internal round, combo, event, or debug data', () => {
  const h = harness()
  h.service.startRound()
  const { state } = punch(h, 'left')
  const expected = structuredClone(state)

  state.round.status = 'ended'
  state.round.generation = 999
  state.currentCombo[0] = 'uppercut'
  state.comboStats.succeeded = 999
  state.punchCounts.jab = 999
  state.lastPunchEvent.punch = 'hook'
  state.debugRows[0].scoreByType.jab = -999
  state.debugRows[0].cues.straight2D = false
  state.debugRows.push({ injected: true })
  state.session.completedSession = { injected: true }

  assert.deepEqual(h.service.getState(), expected)
  assert.equal(h.service.getGeneration(), 1)
})

test('completed sessions contain final statistics and are recursively frozen', () => {
  const h = harness()
  h.service.startRound('form')
  punch(h, 'left', 1000)
  punch(h, 'right', 1200)
  h.advance(250)

  const { state, session } = h.service.endRound()
  assert.deepEqual(session, {
    schemaVersion: 1,
    id: 'id-1',
    startedAt: new Date(WALL_START).toISOString(),
    endedAt: new Date(WALL_START + 550).toISOString(),
    roundDurationSeconds: 180,
    durationSeconds: 0.55,
    comboStats: { succeeded: 1, failed: 0, total: 1 },
    details: {
      speed: 'form',
      punchCounts: { jab: 1, cross: 1, hook: 0, uppercut: 0 },
    },
  })
  assert.strictEqual(state.session.completedSession, session)

  for (const object of [
    session,
    session.comboStats,
    session.details,
    session.details.punchCounts,
  ]) {
    assert.equal(Object.isFrozen(object), true)
  }
  assert.throws(() => {
    session.id = 'changed'
  }, TypeError)
  assert.throws(() => {
    session.comboStats.succeeded = 10
  }, TypeError)
  assert.throws(() => {
    session.details.speed = 'intense'
  }, TypeError)
  assert.throws(() => {
    session.details.punchCounts.jab = 10
  }, TypeError)

  state.comboStats.succeeded = 99
  state.punchCounts.jab = 99
  assert.equal(session.comboStats.succeeded, 1)
  assert.equal(session.details.punchCounts.jab, 1)
  assert.strictEqual(h.service.endRound().session, session)
  assert.strictEqual(h.service.takeCompletions()[0], session)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('service instances maintain independent state, generations, and queues', () => {
  const first = harness()
  const second = harness()

  first.service.startRound()
  punch(first, 'left')
  first.service.endRound()

  assert.deepEqual(second.service.getState(), readyState())
  assert.equal(second.service.getGeneration(), 0)
  assert.deepEqual(second.service.takeCompletions(), [])
  assert.equal(first.service.takeCompletions().length, 1)
})
