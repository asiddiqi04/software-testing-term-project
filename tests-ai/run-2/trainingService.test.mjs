import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUND_SECONDS,
  TrainingError,
  createTrainingService,
} from '../../frontend/src/training/trainingService.js'

const ZERO_COUNTS = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
const ZERO_STATS = { succeeded: 0, failed: 0, total: 0 }
const WALL_START = Date.UTC(2026, 0, 1)
const SPEEDS = [
  { speed: 'form', frameIntervalMs: 80, comboDelayMs: 1000 },
  { speed: 'casual', frameIntervalMs: 50, comboDelayMs: 650 },
  { speed: 'intense', frameIntervalMs: 25, comboDelayMs: 350 },
]

function harness(options = {}) {
  const clock = { time: 1000, wall: WALL_START }
  let idCount = 0
  const service = createTrainingService({
    now: () => clock.time,
    wallNow: () => clock.wall,
    random: () => 0,
    createId: () => `id-${++idCount}`,
    ...options,
  })

  return {
    service,
    clock,
    advance(ms) {
      clock.time += ms
      clock.wall += ms
    },
    get idCount() {
      return idCount
    },
  }
}

function point(name, x, y) {
  return { name, x, y, score: 1 }
}

function pose(time, overrides = {}) {
  const coordinates = {
    nose: [50, -50],
    left_shoulder: [0, 0],
    right_shoulder: [100, 0],
    left_hip: [0, 150],
    right_hip: [100, 150],
    left_elbow: [-40, 20],
    left_wrist: [-10, -20],
    right_elbow: [140, 20],
    right_wrist: [110, -20],
    ...overrides,
  }

  return {
    time,
    keypoints: Object.entries(coordinates).map(([name, [x, y]]) =>
      point(name, x, y),
    ),
  }
}

const MOTIONS = {
  jab: {
    side: 'left',
    preparation: {},
    extension: { left_elbow: [-60, 0], left_wrist: [-120, 0] },
  },
  cross: {
    side: 'right',
    preparation: {},
    extension: { right_elbow: [160, 0], right_wrist: [220, 0] },
  },
  hook: {
    side: 'left',
    preparation: { left_elbow: [0, -30], left_wrist: [20, -30] },
    extension: { left_elbow: [0, -30], left_wrist: [80, -30] },
  },
  uppercut: {
    side: 'left',
    preparation: { left_elbow: [0, 40], left_wrist: [40, 40] },
    extension: { left_elbow: [40, 0], left_wrist: [40, -60] },
  },
}

// Exercise classification through the public service with deterministic poses.
function submitMotion(h, type) {
  const motion = MOTIONS[type]
  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(
      pose(h.clock.time, motion.preparation),
    )
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  h.advance(50)
  const result = h.service.submitFrame(pose(h.clock.time, motion.extension))
  assert.equal(result.accepted, true)
  assert.ok(result.punchEvent, `Expected a ${type} event`)
  assert.equal(result.punchEvent.punch, type)
  assert.equal(result.punchEvent.side, motion.side)
  return result
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

test('exports the round duration and a named Error subclass', () => {
  assert.equal(ROUND_SECONDS, 180)
  const error = new TrainingError('example')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'TrainingError')
  assert.equal(error.message, 'example')
})

test('initial state is ready, empty, and deterministic', () => {
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
  assert.equal(h.idCount, 0)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('ready-state operations are harmless and ignore malformed frames', () => {
  const h = harness()
  const initial = h.service.getState()

  h.advance(500000)
  assert.deepEqual(h.service.pauseRound(), initial)
  assert.deepEqual(h.service.resumeRound(), initial)
  assert.deepEqual(h.service.endRound(), { state: initial, session: null })
  assert.deepEqual(h.service.submitFrame(null), {
    state: initial,
    punchEvent: null,
    accepted: false,
  })
  assert.equal(h.service.getGeneration(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])
})

for (const { speed, frameIntervalMs } of SPEEDS) {
  test(`starts a ${speed} round with the expected timing`, () => {
    const h = harness()
    const state = h.service.startRound(speed)
    assert.deepEqual(state.round, {
      id: 'id-1',
      generation: 1,
      status: 'running',
      speed,
      frameIntervalMs,
      isRunning: true,
      startedAt: new Date(WALL_START).toISOString(),
      endedAt: null,
      durationSeconds: 180,
      elapsedSeconds: 0,
      timeLeftSeconds: 180,
    })
    assert.equal(h.service.getGeneration(), 1)
    assert.equal(h.idCount, 1)
    assert.deepEqual(state.punchCounts, ZERO_COUNTS)
    assert.deepEqual(state.comboStats, ZERO_STATS)
  })
}

test('omitting speed starts a casual round, including after another speed', () => {
  const h = harness()
  assert.equal(h.service.startRound().round.speed, 'casual')
  h.service.endRound()
  h.service.startRound('intense')
  h.service.endRound()
  assert.equal(h.service.startRound().round.speed, 'casual')
})

test('invalid speeds throw TrainingError without changing state', () => {
  const invalidSpeeds = [
    null, '', 'fast', 'FORM', ' casual ', 1, false, {}, [],
    'toString', 'constructor', '__proto__',
  ]

  for (const status of ['ready', 'running', 'paused', 'ended']) {
    const h = harness()
    if (status !== 'ready') h.service.startRound()
    if (status === 'paused') h.service.pauseRound()
    if (status === 'ended') h.service.endRound()
    const before = h.service.getState()

    for (const speed of invalidSpeeds) {
      assertTrainingError(
        () => h.service.startRound(speed),
        'Choose a round speed: form, casual, or intense.',
      )
      assert.deepEqual(h.service.getState(), before)
    }
  }
})

test('starting an active or paused round preserves its identity and speed', () => {
  const h = harness()
  const started = h.service.startRound('form')
  assert.deepEqual(h.service.startRound('intense'), started)
  assert.equal(h.idCount, 1)

  h.advance(2500)
  const paused = h.service.pauseRound()
  assert.deepEqual(h.service.startRound('casual'), paused)
  assert.equal(h.idCount, 1)
  assert.equal(h.service.getGeneration(), 2)
})

test('elapsed time uses the monotonic clock with floor/ceiling boundaries', () => {
  const h = harness()
  h.service.startRound()

  for (const [elapsedMs, elapsedSeconds, timeLeftSeconds] of [
    [0, 0, 180],
    [1, 0, 180],
    [999, 0, 180],
    [1000, 1, 179],
    [1001, 1, 179],
    [179999, 179, 1],
  ]) {
    h.clock.time = 1000 + elapsedMs
    h.clock.wall = WALL_START - 500000
    const { round } = h.service.getState()
    assert.equal(round.elapsedSeconds, elapsedSeconds)
    assert.equal(round.timeLeftSeconds, timeLeftSeconds)
    assert.equal(round.status, 'running')
  }
})

test('elapsed time cannot become negative', () => {
  const h = harness()
  h.service.startRound()
  h.clock.time = 500
  const { round } = h.service.getState()
  assert.equal(round.elapsedSeconds, 0)
  assert.equal(round.timeLeftSeconds, 180)
})

test('pause/resume excludes multiple pauses and increments generation once per transition', () => {
  const h = harness()
  h.service.startRound()
  assert.equal(h.service.resumeRound().round.generation, 1)

  h.advance(1250)
  const firstPause = h.service.pauseRound()
  assert.equal(firstPause.round.status, 'paused')
  assert.equal(firstPause.round.isRunning, false)
  assert.equal(firstPause.round.elapsedSeconds, 1)
  assert.equal(firstPause.round.generation, 2)

  h.advance(200000)
  assert.deepEqual(h.service.getState(), firstPause)
  assert.deepEqual(h.service.pauseRound(), firstPause)

  const resumed = h.service.resumeRound()
  assert.equal(resumed.round.generation, 3)
  assert.equal(resumed.round.status, 'running')
  assert.equal(resumed.round.elapsedSeconds, 1)
  assert.deepEqual(h.service.resumeRound(), resumed)

  h.advance(750)
  assert.equal(h.service.pauseRound().round.generation, 4)
  h.advance(10000)
  assert.equal(h.service.resumeRound().round.generation, 5)
  h.advance(500)

  const ended = h.service.endRound()
  assert.equal(ended.state.round.generation, 6)
  assert.equal(ended.state.round.elapsedSeconds, 2)
  assert.equal(ended.state.round.timeLeftSeconds, 178)
  assert.equal(ended.session.durationSeconds, 2.5)
})

test('ending while paused excludes the ongoing pause', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(1234)
  h.service.pauseRound()
  h.advance(20000)

  const { state, session } = h.service.endRound()
  assert.equal(state.round.status, 'ended')
  assert.equal(state.round.isRunning, false)
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)
  assert.equal(session.durationSeconds, 1.234)
  assert.equal(session.endedAt, new Date(h.clock.wall).toISOString())

  h.advance(300000)
  assert.deepEqual(h.service.getState(), state)
  assert.deepEqual(h.service.pauseRound(), state)
  assert.deepEqual(h.service.resumeRound(), state)
})

test('manual completion has the expected schema and is queued exactly once', () => {
  const h = harness()
  h.service.startRound('intense')
  h.advance(2750)
  const ended = h.service.endRound()

  assert.deepEqual(ended.session, {
    schemaVersion: 1,
    id: 'id-1',
    startedAt: new Date(WALL_START).toISOString(),
    endedAt: new Date(WALL_START + 2750).toISOString(),
    roundDurationSeconds: 180,
    durationSeconds: 2.75,
    comboStats: ZERO_STATS,
    details: { speed: 'intense', punchCounts: ZERO_COUNTS },
  })
  assert.strictEqual(ended.state.session.completedSession, ended.session)
  assert.equal(ended.state.round.generation, 2)

  h.advance(10000)
  const repeated = h.service.endRound()
  assert.strictEqual(repeated.session, ended.session)
  assert.deepEqual(repeated.state, ended.state)
  assert.deepEqual(h.service.takeCompletions(), [ended.session])
  assert.deepEqual(h.service.takeCompletions(), [])
  h.service.endRound()
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('a round can finish immediately with a zero-length session', () => {
  const h = harness()
  h.service.startRound()
  const { session } = h.service.endRound()
  assert.equal(session.durationSeconds, 0)
  assert.equal(session.startedAt, session.endedAt)
})

for (const elapsedMs of [180000, 230000]) {
  test(`automatic expiration caps duration after ${elapsedMs} ms`, () => {
    const h = harness()
    h.service.startRound()
    h.advance(elapsedMs)

    const state = h.service.getState()
    const session = state.session.completedSession
    assert.equal(state.round.status, 'ended')
    assert.equal(state.round.isRunning, false)
    assert.equal(state.round.generation, 2)
    assert.equal(state.round.elapsedSeconds, 180)
    assert.equal(state.round.timeLeftSeconds, 0)
    assert.equal(session.durationSeconds, 180)
    assert.equal(session.endedAt, new Date(h.clock.wall).toISOString())
    assert.strictEqual(h.service.endRound().session, session)
    assert.deepEqual(h.service.takeCompletions(), [session])
    assert.deepEqual(h.service.takeCompletions(), [])
  })
}

test('manual ending also caps an overdue round at 180 seconds', () => {
  const h = harness()
  h.service.startRound()
  h.advance(300000)
  const result = h.service.endRound()
  assert.equal(result.session.durationSeconds, 180)
  assert.equal(result.state.round.elapsedSeconds, 180)
  assert.equal(result.state.round.timeLeftSeconds, 0)
  assert.equal(result.state.round.generation, 2)
})

for (const operation of ['pauseRound', 'resumeRound', 'submitFrame']) {
  test(`${operation} refreshes and completes an expired round`, () => {
    const h = harness()
    h.service.startRound()
    h.advance(180000)

    const result = operation === 'submitFrame'
      ? h.service.submitFrame(null)
      : h.service[operation]()
    const state = operation === 'submitFrame' ? result.state : result

    assert.equal(state.round.status, 'ended')
    assert.equal(state.round.generation, 2)
    assert.equal(state.session.completedSession.durationSeconds, 180)
    if (operation === 'submitFrame') {
      assert.equal(result.accepted, false)
      assert.equal(result.punchEvent, null)
    }
    assert.equal(h.service.takeCompletions().length, 1)
  })
}

test('starting after expiration queues the old session and starts a fresh round', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(180000)

  const next = h.service.startRound('intense')
  assert.equal(next.round.id, 'id-2')
  assert.equal(next.round.generation, 3)
  assert.equal(next.round.status, 'running')
  assert.equal(next.round.speed, 'intense')
  assert.equal(next.round.elapsedSeconds, 0)
  assert.equal(next.session.completedSession, null)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0].id, 'id-1')
  assert.equal(completions[0].durationSeconds, 180)
})

test('completion queues preserve order across rounds and drain independently', () => {
  const h = harness()
  h.service.startRound()
  const first = h.service.endRound().session
  h.service.startRound('form')
  h.advance(1000)
  const second = h.service.endRound().session

  assert.deepEqual(h.service.takeCompletions(), [first, second])
  assert.deepEqual(h.service.takeCompletions(), [])
  assert.strictEqual(h.service.getState().session.completedSession, second)
})

for (const status of ['ready', 'running', 'paused', 'ended']) {
  test(`reset from ${status} clears round state and preserves speed`, () => {
    const h = harness()
    let completed = null
    if (status !== 'ready') {
      h.service.startRound('intense')
      submitMotion(h, 'jab')
    }
    if (status === 'paused') h.service.pauseRound()
    if (status === 'ended') completed = h.service.endRound().session

    const generation = h.service.getGeneration()
    const reset = h.service.resetRound()
    assert.equal(reset.round.generation, generation + 1)
    assert.equal(reset.round.status, 'ready')
    assert.equal(reset.round.speed, status === 'ready' ? 'casual' : 'intense')
    assert.equal(reset.round.id, null)
    assert.equal(reset.round.startedAt, null)
    assert.equal(reset.round.endedAt, null)
    assert.equal(reset.round.elapsedSeconds, 0)
    assert.equal(reset.round.timeLeftSeconds, 180)
    assert.deepEqual(reset.currentCombo, ['jab', 'cross'])
    assert.equal(reset.comboStepIndex, 0)
    assert.equal(reset.comboResult, 'idle')
    assert.deepEqual(reset.comboStats, ZERO_STATS)
    assert.deepEqual(reset.punchCounts, ZERO_COUNTS)
    assert.equal(reset.lastPunchEvent, null)
    assert.deepEqual(reset.debugRows, [])
    assert.equal(reset.session.completedSession, null)
    assert.deepEqual(h.service.takeCompletions(), completed ? [completed] : [])
  })
}

test('reset refreshes an expired round before clearing it', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(180000)
  const reset = h.service.resetRound()
  assert.equal(reset.round.status, 'ready')
  assert.equal(reset.round.speed, 'form')
  assert.equal(reset.round.generation, 3)
  const [session] = h.service.takeCompletions()
  assert.equal(session.id, 'id-1')
  assert.equal(session.durationSeconds, 180)
})

test('frames outside a running round or with stale generations are ignored before validation', () => {
  const h = harness()
  assert.equal(h.service.submitFrame(null).accepted, false)
  const firstGeneration = h.service.startRound().round.generation

  assert.deepEqual(h.service.submitFrame(null, firstGeneration - 1), {
    state: h.service.getState(),
    punchEvent: null,
    accepted: false,
  })

  h.service.pauseRound()
  assert.equal(h.service.submitFrame(null).accepted, false)
  const resumed = h.service.resumeRound()
  assert.equal(h.service.submitFrame(null, firstGeneration).accepted, false)
  assert.equal(
    h.service.submitFrame(pose(h.clock.time), resumed.round.generation).accepted,
    true,
  )

  h.service.endRound()
  assert.equal(h.service.submitFrame(null).accepted, false)
  h.service.startRound()
  assert.equal(
    h.service.submitFrame(null, resumed.round.generation).accepted,
    false,
  )
  h.service.resetRound()
  assert.equal(h.service.submitFrame(null).accepted, false)
})

test('frames must be within the round, not in the future, and strictly ordered', () => {
  const h = harness()
  h.service.startRound()
  const initial = h.service.getState()

  for (const time of [999, 1001]) {
    assert.deepEqual(h.service.submitFrame(pose(time)), {
      state: initial,
      punchEvent: null,
      accepted: false,
    })
  }

  assert.equal(h.service.submitFrame(pose(1000)).accepted, true)
  assert.equal(h.service.submitFrame(pose(1000)).accepted, false)
  h.advance(20)
  assert.equal(h.service.submitFrame(pose(1020)).accepted, true)
  assert.equal(h.service.submitFrame(pose(1010)).accepted, false)
  assert.equal(h.service.submitFrame(pose(1020)).accepted, false)
  h.advance(1)
  assert.equal(h.service.submitFrame(pose(1021)).accepted, true)
})

test('invalid running-frame payloads become TrainingErrors without changing state', () => {
  const h = harness()
  h.service.startRound()

  const pointMessage =
    'Each keypoint must include name, numeric x, and numeric y values.'
  const worldMessage =
    'keypoints3D must contain named points with numeric x, y, and z values.'
  const timeMessage = 'A monotonic frame timestamp is required.'
  const valid = () => ({ time: h.clock.time, keypoints: [point('nose', 0, 0)] })

  const invalidFrames = [
    [null, 'Pose frame must be an object.'],
    [undefined, 'Pose frame must be an object.'],
    [42, 'Pose frame must be an object.'],
    ['frame', 'Pose frame must be an object.'],
    [{}, 'keypoints must be a non-empty array.'],
    [{ ...valid(), keypoints: [] }, 'keypoints must be a non-empty array.'],
    [{ ...valid(), keypoints: {} }, 'keypoints must be a non-empty array.'],
    [{ ...valid(), keypoints: [null] }, pointMessage],
    [{ ...valid(), keypoints: [point('', 0, 0)] }, pointMessage],
    [{ ...valid(), keypoints: [point('   ', 0, 0)] }, pointMessage],
    [{ ...valid(), keypoints: [point('nose', '0', 0)] }, pointMessage],
    [{ ...valid(), keypoints: [point('nose', 0, NaN)] }, pointMessage],
    [{ ...valid(), keypoints: [point('nose', Infinity, 0)] }, pointMessage],
    [{ ...valid(), keypoints: [{ ...point('nose', 0, 0), z: NaN }] }, pointMessage],
    [{ ...valid(), keypoints: [{ ...point('nose', 0, 0), score: Infinity }] }, pointMessage],
    [{ ...valid(), keypoints3D: {} }, worldMessage],
    [{ ...valid(), keypoints3D: [point('nose', 0, 0)] }, worldMessage],
    [{ ...valid(), keypoints3D: [{ ...point('nose', 0, 0), z: Infinity }] }, worldMessage],
    ...[undefined, null, -1, NaN, Infinity, '1000'].map((time) => [
      { ...valid(), time },
      timeMessage,
    ]),
  ]

  const before = h.service.getState()
  for (const [frame, message] of invalidFrames) {
    assertTrainingError(() => h.service.submitFrame(frame), message)
    assert.deepEqual(h.service.getState(), before)
  }
  assert.equal(h.service.submitFrame(valid()).accepted, true)
})

test('valid sparse poses and optional 3D points can be accepted without a punch', () => {
  const h = harness()
  h.service.startRound()
  for (const keypoints3D of [
    undefined,
    null,
    [],
    [{ name: 'nose', x: 0, y: 0, z: -0.5 }],
  ]) {
    h.advance(1)
    const result = h.service.submitFrame({
      time: h.clock.time,
      keypoints: [{ name: 'nose', x: 0, y: 0 }],
      keypoints3D,
    })
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    assert.deepEqual(result.state.punchCounts, ZERO_COUNTS)
  }
})

for (const type of Object.keys(MOTIONS)) {
  test(`a classified ${type} updates counts and produces a timestamped event`, () => {
    const h = harness()
    h.service.startRound()
    const result = submitMotion(h, type)
    const event = result.punchEvent

    assert.equal(event.id, 'id-2')
    assert.equal(event.detectedAt, new Date(h.clock.wall).toISOString())
    assert.equal(event.expected, 'jab')
    assert.equal(event.expectedIndex, 0)
    assert.equal(event.matched, type === 'jab')
    assert.equal(event.comboLocked, false)
    assert.ok(Number.isFinite(event.score))
    assert.deepEqual(result.state.punchCounts, { ...ZERO_COUNTS, [type]: 1 })
    assert.deepEqual(result.state.lastPunchEvent, event)
    assert.equal(result.state.comboResult, type === 'jab' ? 'active' : 'failed')
    assert.equal(result.state.comboStepIndex, type === 'jab' ? 1 : 0)
    assert.deepEqual(
      result.state.comboStats,
      type === 'jab' ? ZERO_STATS : { succeeded: 0, failed: 1, total: 1 },
    )

    const session = h.service.endRound().session
    assert.deepEqual(session.details.punchCounts, result.state.punchCounts)
    assert.deepEqual(session.comboStats, result.state.comboStats)
  })
}

test('matching successive punches completes a combo', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'jab')
  const result = submitMotion(h, 'cross')

  assert.equal(result.punchEvent.expected, 'cross')
  assert.equal(result.punchEvent.expectedIndex, 1)
  assert.equal(result.punchEvent.matched, true)
  assert.equal(result.state.comboStepIndex, 2)
  assert.equal(result.state.comboResult, 'success')
  assert.deepEqual(result.state.comboStats, { succeeded: 1, failed: 0, total: 1 })
  assert.deepEqual(result.state.punchCounts, {
    jab: 1, cross: 1, hook: 0, uppercut: 0,
  })
})

test('a wrong punch after partial progress fails the combo and resets its index', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'jab')
  h.advance(500)
  const result = submitMotion(h, 'jab')

  assert.equal(result.punchEvent.expected, 'cross')
  assert.equal(result.punchEvent.expectedIndex, 1)
  assert.equal(result.punchEvent.matched, false)
  assert.equal(result.state.comboStepIndex, 0)
  assert.equal(result.state.comboResult, 'failed')
  assert.deepEqual(result.state.comboStats, { succeeded: 0, failed: 1, total: 1 })
  assert.equal(result.state.punchCounts.jab, 2)
})

test('punches during a combo lock count without changing combo statistics', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'cross')
  const result = submitMotion(h, 'jab')

  assert.equal(result.punchEvent.comboLocked, true)
  assert.equal(result.punchEvent.matched, false)
  assert.equal(result.state.comboResult, 'failed')
  assert.equal(result.state.comboStepIndex, 0)
  assert.deepEqual(result.state.comboStats, { succeeded: 0, failed: 1, total: 1 })
  assert.deepEqual(result.state.punchCounts, {
    jab: 1, cross: 1, hook: 0, uppercut: 0,
  })
})

for (const { speed, comboDelayMs } of SPEEDS) {
  for (const outcome of ['failed', 'success']) {
    test(`${speed} releases a ${outcome} combo exactly at its delay`, () => {
      let randomValue = 0
      const h = harness({ random: () => randomValue })
      h.service.startRound(speed)
      if (outcome === 'success') submitMotion(h, 'jab')
      const locked = submitMotion(h, 'cross').state
      assert.equal(locked.comboResult, outcome)

      randomValue = 0.45
      h.advance(comboDelayMs - 1)
      assert.equal(h.service.getState().comboResult, outcome)
      h.advance(1)

      const released = h.service.getState()
      assert.equal(released.comboResult, 'idle')
      assert.equal(released.comboStepIndex, 0)
      assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
      assert.deepEqual(released.comboStats, locked.comboStats)
      assert.deepEqual(released.punchCounts, locked.punchCounts)
      assert.deepEqual(released.lastPunchEvent, locked.lastPunchEvent)
      assert.equal(released.round.generation, 1)
    })
  }

  test(`${speed} pauses the remaining combo lock delay`, () => {
    const h = harness()
    h.service.startRound(speed)
    submitMotion(h, 'cross')
    h.advance(100)
    h.service.pauseRound()
    h.advance(5000)
    assert.equal(h.service.getState().comboResult, 'failed')
    h.service.resumeRound()

    h.advance(comboDelayMs - 101)
    assert.equal(h.service.getState().comboResult, 'failed')
    h.advance(1)
    assert.equal(h.service.getState().comboResult, 'idle')
  })
}

test('holding an extended arm does not repeatedly count the same punch', () => {
  const h = harness()
  h.service.startRound()
  const detected = submitMotion(h, 'jab')
  for (let index = 0; index < 50; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(
      pose(h.clock.time, MOTIONS.jab.extension),
    )
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    assert.equal(result.state.punchCounts.jab, 1)
    assert.deepEqual(result.state.lastPunchEvent, detected.punchEvent)
  }
})

test('pause and resume clear motion history so a pre-pause motion cannot finish a punch', () => {
  const h = harness()
  h.service.startRound()
  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    h.service.submitFrame(pose(h.clock.time))
  }
  h.service.pauseRound()
  h.advance(50)
  h.service.resumeRound()
  h.advance(50)

  const result = h.service.submitFrame(
    pose(h.clock.time, MOTIONS.jab.extension),
  )
  assert.equal(result.accepted, true)
  assert.equal(result.punchEvent, null)
  assert.deepEqual(result.state.punchCounts, ZERO_COUNTS)
})

test('restarting clears motion history and punch cooldowns', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'jab')
  h.service.endRound()
  const next = h.service.startRound()
  assert.deepEqual(next.punchCounts, ZERO_COUNTS)
  assert.equal(next.lastPunchEvent, null)
  assert.deepEqual(next.debugRows, [])

  const result = submitMotion(h, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
  assert.equal(result.punchEvent.matched, true)
})

test('accepted frame keypoints are copied before being stored in motion history', () => {
  const h = harness()
  h.service.startRound()

  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const frame = pose(h.clock.time)
    assert.equal(h.service.submitFrame(frame).accepted, true)
    for (const keypoint of frame.keypoints) {
      const replacement = MOTIONS.jab.extension[keypoint.name]
      if (replacement) {
        keypoint.x = replacement[0]
        keypoint.y = replacement[1]
      }
    }
  }

  h.advance(50)
  const result = h.service.submitFrame(
    pose(h.clock.time, MOTIONS.jab.extension),
  )
  assert.equal(result.punchEvent?.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
})

test('snapshots isolate mutable round, combo, punch, event, and nested debug data', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'jab')

  const snapshot = h.service.getState()
  const expected = structuredClone(snapshot)
  assert.ok(snapshot.debugRows.length > 0)

  snapshot.round.status = 'corrupted'
  snapshot.currentCombo[0] = 'corrupted'
  snapshot.comboStepIndex = 99
  snapshot.comboStats.succeeded = 99
  snapshot.punchCounts.jab = 99
  snapshot.lastPunchEvent.punch = 'corrupted'
  snapshot.debugRows[0].scoreByType.jab = -999
  snapshot.debugRows[0].cues.straight2D = 'corrupted'
  snapshot.debugRows.push({ side: 'corrupted' })
  snapshot.session.completedSession = { id: 'corrupted' }

  assert.deepEqual(h.service.getState(), expected)
})

test('completed sessions are recursively frozen and survive resets unchanged', () => {
  const h = harness()
  h.service.startRound()
  submitMotion(h, 'jab')
  const session = h.service.endRound().session
  const expected = structuredClone(session)

  for (const value of [
    session,
    session.comboStats,
    session.details,
    session.details.punchCounts,
  ]) {
    assert.equal(Object.isFrozen(value), true)
  }

  assert.throws(() => { session.id = 'changed' }, TypeError)
  assert.throws(() => { session.comboStats.total = 99 }, TypeError)
  assert.throws(() => { session.details.speed = 'form' }, TypeError)
  assert.throws(() => { session.details.punchCounts.jab = 99 }, TypeError)

  h.service.resetRound()
  h.service.startRound('form')
  assert.deepEqual(session, expected)
  assert.strictEqual(h.service.takeCompletions()[0], session)
})

test('separate service instances keep generations, state, and completion queues independent', () => {
  const first = harness()
  const second = harness({ random: () => 0.45 })
  first.service.startRound()
  submitMotion(first, 'jab')
  first.service.endRound()

  const other = second.service.getState()
  assert.equal(other.round.status, 'ready')
  assert.equal(other.round.generation, 0)
  assert.deepEqual(other.currentCombo, ['uppercut', 'hook'])
  assert.deepEqual(other.punchCounts, ZERO_COUNTS)
  assert.deepEqual(second.service.takeCompletions(), [])
  assert.equal(first.service.takeCompletions().length, 1)
})
