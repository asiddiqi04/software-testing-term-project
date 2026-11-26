import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUND_SECONDS,
  TrainingError,
  createTrainingService,
} from '../../frontend/src/training/trainingService.js'

const WALL_START = Date.parse('2026-01-02T03:04:05.000Z')
const EMPTY_COUNTS = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
const EMPTY_STATS = { succeeded: 0, failed: 0, total: 0 }

function createHarness() {
  let monotonic = 1000
  let wall = WALL_START
  let randomValue = 0
  let ids = 0

  const service = createTrainingService({
    now: () => monotonic,
    wallNow: () => wall,
    random: () => randomValue,
    createId: () => `id-${++ids}`,
  })

  return {
    service,
    get time() {
      return monotonic
    },
    get wall() {
      return wall
    },
    get ids() {
      return ids
    },
    advance(ms) {
      monotonic += ms
      wall += ms
    },
    setTime(ms) {
      monotonic = ms
    },
    setWall(ms) {
      wall = ms
    },
    setRandom(value) {
      randomValue = value
    },
  }
}

function pose(overrides = {}) {
  const coordinates = {
    nose: [50, -60],
    left_shoulder: [0, 0],
    right_shoulder: [100, 0],
    left_elbow: [-30, 40],
    right_elbow: [130, 40],
    left_wrist: [0, -20],
    right_wrist: [100, -20],
    left_hip: [0, 100],
    right_hip: [100, 100],
    ...overrides,
  }

  return Object.entries(coordinates).map(([name, [x, y]]) => ({
    name,
    x,
    y,
    score: 1,
  }))
}

function frame(time, keypoints = pose(), keypoints3D) {
  return {
    time,
    keypoints,
    ...(keypoints3D === undefined ? {} : { keypoints3D }),
  }
}

function punchPoses(type) {
  switch (type) {
    case 'jab':
      return [
        pose(),
        pose({ left_elbow: [-80, 0], left_wrist: [-160, 0] }),
      ]
    case 'cross':
      return [
        pose(),
        pose({ right_elbow: [180, 0], right_wrist: [260, 0] }),
      ]
    case 'hook':
      return [
        pose({ left_elbow: [0, -20], left_wrist: [20, -20] }),
        pose({ left_elbow: [0, -20], left_wrist: [60, -20] }),
      ]
    case 'uppercut':
      return [
        pose({ left_elbow: [40, 0], left_wrist: [40, 50] }),
        pose({ left_elbow: [40, 0], left_wrist: [40, -50] }),
      ]
    default:
      throw new Error(`Unknown fixture punch: ${type}`)
  }
}

function throwPunch(h, type) {
  const [preparation, extension] = punchPoses(type)
  for (const keypoints of [preparation, preparation]) {
    h.advance(50)
    const result = h.service.submitFrame(frame(h.time, keypoints))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  h.advance(50)
  return h.service.submitFrame(frame(h.time, extension))
}

function assertRejected(result) {
  assert.equal(result.accepted, false)
  assert.equal(result.punchEvent, null)
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true)
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') assertDeepFrozen(item)
  }
}

test('exports the round duration and a distinct Error subclass', () => {
  assert.equal(ROUND_SECONDS, 180)

  const error = new TrainingError('Invalid training input')
  assert.ok(error instanceof Error)
  assert.ok(error instanceof TrainingError)
  assert.equal(error.name, 'TrainingError')
  assert.equal(error.message, 'Invalid training input')
})

test('initial state contains the complete ready snapshot', () => {
  const h = createHarness()

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
    comboStats: EMPTY_STATS,
    comboResult: 'idle',
    lastPunchEvent: null,
    punchCounts: EMPTY_COUNTS,
    debugRows: [],
    session: { completedSession: null },
  })
  assert.equal(h.service.getGeneration(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])
  assert.equal(h.ids, 0)
})

test('can be constructed with the default dependencies', () => {
  const service = createTrainingService()
  const state = service.getState()

  assert.equal(state.round.status, 'ready')
  assert.equal(state.round.speed, 'casual')
  assert.equal(state.round.durationSeconds, ROUND_SECONDS)
  assert.ok(Array.isArray(state.currentCombo))
  assert.ok(state.currentCombo.length > 0)
})

for (const [speed, frameIntervalMs] of [
  ['form', 80],
  ['casual', 50],
  ['intense', 25],
]) {
  test(`starts a ${speed} round with its capture interval`, () => {
    const h = createHarness()
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
    assert.equal(h.ids, 1)
  })
}

test('startRound defaults to casual and honors the injected random source', () => {
  const h = createHarness()
  h.setRandom(0.4)

  const state = h.service.startRound()
  assert.equal(state.round.speed, 'casual')
  assert.deepEqual(state.currentCombo, ['uppercut', 'hook'])
})

test('invalid speeds throw TrainingError without changing state', () => {
  const invalidSpeeds = [
    null,
    '',
    'fast',
    'FORM',
    ' casual ',
    'toString',
    '__proto__',
    0,
    false,
    {},
    [],
  ]

  for (const status of ['ready', 'running', 'paused']) {
    const h = createHarness()
    if (status !== 'ready') h.service.startRound()
    if (status === 'paused') h.service.pauseRound()
    const before = h.service.getState()

    for (const speed of invalidSpeeds) {
      assert.throws(
        () => h.service.startRound(speed),
        {
          name: 'TrainingError',
          message: 'Choose a round speed: form, casual, or intense.',
        },
      )
      assert.deepEqual(h.service.getState(), before)
    }
    assert.deepEqual(h.service.takeCompletions(), [])
  }
})

test('starting an active or paused round preserves its identity and speed', () => {
  const h = createHarness()
  h.service.startRound('form')
  h.advance(1200)

  const running = h.service.getState()
  assert.deepEqual(h.service.startRound('intense'), running)
  assert.equal(h.ids, 1)

  const paused = h.service.pauseRound()
  h.advance(5000)
  assert.deepEqual(h.service.startRound('casual'), paused)
  assert.equal(h.ids, 1)
})

test('elapsed time rounds down, remaining time rounds up, and wall time is independent', () => {
  const h = createHarness()
  h.service.startRound()

  h.advance(999)
  let state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)

  h.advance(1)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)

  h.advance(1)
  h.setWall(WALL_START + 86_400_000)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)
  assert.equal(state.round.startedAt, new Date(WALL_START).toISOString())

  h.setTime(999)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)
})

test('pause and resume exclude every paused interval from elapsed time', () => {
  const h = createHarness()
  h.service.startRound()
  h.advance(1250)

  let state = h.service.pauseRound()
  assert.equal(state.round.status, 'paused')
  assert.equal(state.round.isRunning, false)
  assert.equal(state.round.generation, 2)
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)

  h.advance(20_000)
  assert.deepEqual(h.service.pauseRound(), state)
  assert.deepEqual(h.service.getState(), state)

  state = h.service.resumeRound()
  assert.equal(state.round.status, 'running')
  assert.equal(state.round.isRunning, true)
  assert.equal(state.round.generation, 3)
  assert.equal(state.round.elapsedSeconds, 1)
  assert.deepEqual(h.service.resumeRound(), state)

  h.advance(750)
  h.service.pauseRound()
  h.advance(9000)
  h.service.resumeRound()
  h.advance(500)

  const { state: ended, session } = h.service.endRound()
  assert.equal(session.durationSeconds, 2.5)
  assert.equal(ended.round.elapsedSeconds, 2)
  assert.equal(ended.round.timeLeftSeconds, 178)
  assert.equal(ended.round.generation, 6)
})

test('pause, resume, and end are no-ops before a round starts', () => {
  const h = createHarness()
  const ready = h.service.getState()

  assert.deepEqual(h.service.pauseRound(), ready)
  assert.deepEqual(h.service.resumeRound(), ready)
  assert.deepEqual(h.service.endRound(), { state: ready, session: null })
  assert.equal(h.service.getGeneration(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('ending a running round creates exactly one deeply frozen session', () => {
  const h = createHarness()
  h.service.startRound('intense')
  h.advance(2345)
  h.setWall(WALL_START + 60_000)

  const { state, session } = h.service.endRound()
  assert.deepEqual(session, {
    schemaVersion: 1,
    id: 'id-1',
    startedAt: new Date(WALL_START).toISOString(),
    endedAt: new Date(WALL_START + 60_000).toISOString(),
    roundDurationSeconds: 180,
    durationSeconds: 2.345,
    comboStats: EMPTY_STATS,
    details: {
      speed: 'intense',
      punchCounts: EMPTY_COUNTS,
    },
  })
  assertDeepFrozen(session)
  assert.equal(state.session.completedSession, session)
  assert.equal(state.round.status, 'ended')
  assert.equal(state.round.isRunning, false)
  assert.equal(state.round.endedAt, session.endedAt)
  assert.equal(state.round.generation, 2)
  assert.equal(state.round.elapsedSeconds, 2)
  assert.equal(state.round.timeLeftSeconds, 178)

  assert.throws(() => {
    session.details.punchCounts.jab = 100
  }, TypeError)
  assert.throws(() => {
    session.comboStats.total = 100
  }, TypeError)

  h.advance(10_000)
  assert.deepEqual(h.service.getState(), state)
  assert.deepEqual(h.service.pauseRound(), state)
  assert.deepEqual(h.service.resumeRound(), state)
  assert.equal(h.service.endRound().session, session)
  assert.equal(h.service.getGeneration(), 2)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0], session)
  assert.deepEqual(h.service.takeCompletions(), [])

  h.service.endRound()
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('ending while paused uses the elapsed time at the pause', () => {
  const h = createHarness()
  h.service.startRound()
  h.advance(1750)
  h.service.pauseRound()
  h.advance(300_000)

  const { state, session } = h.service.endRound()
  assert.equal(session.durationSeconds, 1.75)
  assert.equal(session.endedAt, new Date(h.wall).toISOString())
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)
  assert.equal(state.round.generation, 3)
})

test('a round can end immediately with zero duration', () => {
  const h = createHarness()
  h.service.startRound()

  const { session } = h.service.endRound()
  assert.equal(session.durationSeconds, 0)
  assert.equal(session.startedAt, session.endedAt)
  assert.equal(h.service.takeCompletions().length, 1)
})

test('getState automatically completes at the exact round deadline', () => {
  const h = createHarness()
  h.service.startRound()
  h.advance(179_999)

  let state = h.service.getState()
  assert.equal(state.round.status, 'running')
  assert.equal(state.round.elapsedSeconds, 179)
  assert.equal(state.round.timeLeftSeconds, 1)

  h.advance(1)
  state = h.service.getState()
  assert.equal(state.round.status, 'ended')
  assert.equal(state.round.elapsedSeconds, 180)
  assert.equal(state.round.timeLeftSeconds, 0)
  assert.equal(state.round.generation, 2)
  assert.equal(state.session.completedSession.durationSeconds, 180)
  assert.equal(h.service.takeCompletions().length, 1)

  h.service.getState()
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('late automatic and explicit completion both cap duration at 180 seconds', () => {
  for (const mode of ['automatic', 'explicit']) {
    const h = createHarness()
    h.service.startRound()
    h.advance(500_000)

    const state =
      mode === 'automatic'
        ? h.service.getState()
        : h.service.endRound().state

    assert.equal(state.round.elapsedSeconds, 180)
    assert.equal(state.round.timeLeftSeconds, 0)
    assert.equal(state.session.completedSession.durationSeconds, 180)
    assert.equal(
      state.session.completedSession.endedAt,
      new Date(h.wall).toISOString(),
    )
    assert.equal(h.service.takeCompletions().length, 1)
  }
})

test('paused rounds do not expire, and the deadline moves by the pause duration', () => {
  const h = createHarness()
  h.service.startRound()
  h.advance(179_000)
  h.service.pauseRound()
  h.advance(400_000)

  assert.equal(h.service.getState().round.status, 'paused')
  assert.deepEqual(h.service.takeCompletions(), [])

  h.service.resumeRound()
  h.advance(999)
  assert.equal(h.service.getState().round.status, 'running')
  h.advance(1)

  const state = h.service.getState()
  assert.equal(state.round.status, 'ended')
  assert.equal(state.session.completedSession.durationSeconds, 180)
})

for (const method of ['pauseRound', 'resumeRound', 'submitFrame']) {
  test(`${method} refreshes an expired running round`, () => {
    const h = createHarness()
    h.service.startRound()
    h.advance(180_000)

    if (method === 'submitFrame') {
      assertRejected(h.service.submitFrame(null))
    } else {
      assert.equal(h.service[method]().round.status, 'ended')
    }

    assert.equal(h.service.getState().round.status, 'ended')
    assert.equal(h.service.getGeneration(), 2)
    assert.equal(h.service.takeCompletions().length, 1)
  })
}

test('starting after expiration queues the old session and begins a fresh round', () => {
  const h = createHarness()
  h.service.startRound('form')
  h.advance(180_000)

  const state = h.service.startRound('intense')
  assert.equal(state.round.id, 'id-2')
  assert.equal(state.round.status, 'running')
  assert.equal(state.round.speed, 'intense')
  assert.equal(state.round.generation, 3)
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.session.completedSession, null)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0].id, 'id-1')
  assert.equal(completions[0].details.speed, 'form')
  assert.equal(completions[0].durationSeconds, 180)
})

test('reset clears round data, preserves speed, and does not complete an active round', () => {
  const h = createHarness()
  h.service.startRound('form')
  assert.equal(throwPunch(h, 'jab').punchEvent.punch, 'jab')
  h.service.pauseRound()

  const previousGeneration = h.service.getGeneration()
  h.setRandom(0.4)
  const state = h.service.resetRound()

  assert.equal(state.round.status, 'ready')
  assert.equal(state.round.speed, 'form')
  assert.equal(state.round.frameIntervalMs, 80)
  assert.equal(state.round.generation, previousGeneration + 1)
  assert.equal(state.round.id, null)
  assert.equal(state.round.startedAt, null)
  assert.equal(state.round.endedAt, null)
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)
  assert.deepEqual(state.currentCombo, ['uppercut', 'hook'])
  assert.equal(state.comboStepIndex, 0)
  assert.equal(state.comboResult, 'idle')
  assert.deepEqual(state.comboStats, EMPTY_STATS)
  assert.deepEqual(state.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(state.debugRows, [])
  assert.equal(state.lastPunchEvent, null)
  assert.equal(state.session.completedSession, null)
  assert.deepEqual(h.service.takeCompletions(), [])

  assert.equal(
    h.service.resetRound().round.generation,
    previousGeneration + 2,
  )
  assert.equal(h.service.startRound().round.speed, 'casual')
})

test('reset refreshes an expired round before clearing it', () => {
  const h = createHarness()
  h.service.startRound('intense')
  h.advance(180_000)

  const state = h.service.resetRound()
  assert.equal(state.round.status, 'ready')
  assert.equal(state.round.speed, 'intense')
  assert.equal(state.round.generation, 3)
  assert.equal(state.session.completedSession, null)

  const completions = h.service.takeCompletions()
  assert.equal(completions.length, 1)
  assert.equal(completions[0].durationSeconds, 180)
})

test('completion queue preserves sessions across resets and subsequent rounds', () => {
  const h = createHarness()
  h.service.startRound('form')
  h.advance(100)
  const first = h.service.endRound().session

  h.service.resetRound()
  h.service.startRound('intense')
  h.advance(200)
  const second = h.service.endRound().session

  assert.notEqual(first.id, second.id)
  assert.deepEqual(h.service.takeCompletions(), [first, second])
  assert.deepEqual(h.service.takeCompletions(), [])

  h.service.startRound()
  h.advance(300)
  const third = h.service.endRound().session
  const drained = h.service.takeCompletions()
  drained.length = 0
  assert.deepEqual(h.service.takeCompletions(), [])
  assert.equal(h.service.getState().session.completedSession, third)
})

test('non-running services reject frames before attempting validation', () => {
  const h = createHarness()
  assertRejected(h.service.submitFrame(null))

  h.service.startRound()
  h.service.pauseRound()
  assertRejected(h.service.submitFrame(null))

  h.service.endRound()
  assertRejected(h.service.submitFrame(null))

  h.service.resetRound()
  assertRejected(h.service.submitFrame(null))
})

test('generation tokens invalidate frames across pause, resume, reset, and restart', () => {
  const h = createHarness()
  const initialGeneration = h.service.getGeneration()
  const firstGeneration = h.service.startRound().round.generation

  assertRejected(h.service.submitFrame(null, initialGeneration))
  assertRejected(h.service.submitFrame(null, firstGeneration + 100))

  h.service.pauseRound()
  const pausedGeneration = h.service.getGeneration()
  h.service.resumeRound()
  const resumedGeneration = h.service.getGeneration()

  assertRejected(h.service.submitFrame(null, firstGeneration))
  assertRejected(h.service.submitFrame(null, pausedGeneration))
  assert.equal(
    h.service.submitFrame(frame(h.time), resumedGeneration).accepted,
    true,
  )

  h.service.resetRound()
  const resetGeneration = h.service.getGeneration()
  h.service.startRound()
  assertRejected(h.service.submitFrame(null, resumedGeneration))
  assertRejected(h.service.submitFrame(null, resetGeneration))

  h.service.endRound()
  const endedGeneration = h.service.getGeneration()
  h.service.startRound()
  assertRejected(h.service.submitFrame(null, endedGeneration))
  assert.equal(h.service.submitFrame(frame(h.time)).accepted, true)
})

test('malformed frames throw TrainingError without changing state', () => {
  const h = createHarness()
  h.service.startRound()
  const good = frame(h.time)

  const cases = [
    [null, 'Pose frame must be an object.'],
    [undefined, 'Pose frame must be an object.'],
    ['frame', 'Pose frame must be an object.'],
    [{}, 'keypoints must be a non-empty array.'],
    [{ ...good, keypoints: [] }, 'keypoints must be a non-empty array.'],
    [{ ...good, keypoints: {} }, 'keypoints must be a non-empty array.'],
  ]

  for (const point of [
    null,
    {},
    { name: ' ', x: 0, y: 0 },
    { name: 1, x: 0, y: 0 },
    { name: 'nose', x: '0', y: 0 },
    { name: 'nose', x: 0, y: NaN },
    { name: 'nose', x: Infinity, y: 0 },
    { name: 'nose', x: 0, y: 0, z: Infinity },
    { name: 'nose', x: 0, y: 0, score: 'high' },
  ]) {
    cases.push([
      { ...good, keypoints: [point] },
      'Each keypoint must include name, numeric x, and numeric y values.',
    ])
  }

  for (const keypoints3D of [
    {},
    [null],
    [{ name: 'nose', x: 0, y: 0 }],
    [{ name: 'nose', x: 0, y: 0, z: NaN }],
  ]) {
    cases.push([
      { ...good, keypoints3D },
      'keypoints3D must contain named points with numeric x, y, and z values.',
    ])
  }

  for (const time of [undefined, null, '1000', NaN, Infinity, -1]) {
    cases.push([
      { ...good, time },
      'A monotonic frame timestamp is required.',
    ])
  }

  const before = h.service.getState()
  for (const [payload, message] of cases) {
    assert.throws(
      () => h.service.submitFrame(payload),
      (error) => {
        assert.ok(error instanceof TrainingError)
        assert.equal(error.message, message)
        return true
      },
    )
    assert.deepEqual(h.service.getState(), before)
  }
})

test('frame timestamps must be within the round and strictly increasing', () => {
  const h = createHarness()
  h.service.startRound()

  assertRejected(h.service.submitFrame(frame(h.time - 1)))
  assertRejected(h.service.submitFrame(frame(h.time + 1)))

  let result = h.service.submitFrame(frame(h.time))
  assert.equal(result.accepted, true)
  assert.equal(result.punchEvent, null)
  assertRejected(h.service.submitFrame(frame(h.time)))

  h.advance(100)
  assert.equal(h.service.submitFrame(frame(h.time - 50)).accepted, true)
  assertRejected(h.service.submitFrame(frame(h.time - 75)))
  assertRejected(h.service.submitFrame(frame(h.time + 1000)))

  result = h.service.submitFrame(frame(h.time))
  assert.equal(result.accepted, true)
  assert.equal(result.punchEvent, null)
  assert.deepEqual(result.state.punchCounts, EMPTY_COUNTS)
  assert.equal(h.service.getGeneration(), 1)
})

test('zero is a valid start and frame timestamp', () => {
  const h = createHarness()
  h.setTime(0)
  h.service.startRound()

  assert.equal(h.service.submitFrame(frame(0)).accepted, true)
  h.advance(1000)
  assert.equal(h.service.getState().round.elapsedSeconds, 1)
  assert.equal(h.service.endRound().session.durationSeconds, 1)
})

test('valid sparse poses and optional 3D arrays are accepted without detecting punches', () => {
  const h = createHarness()
  h.service.startRound()

  for (const keypoints3D of [
    undefined,
    null,
    [],
    [{ name: 'nose', x: 0, y: 0, z: 0 }],
  ]) {
    h.advance(50)
    const result = h.service.submitFrame(
      frame(h.time, [{ name: 'nose', x: 0, y: 0 }], keypoints3D),
    )
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    assert.deepEqual(result.state.debugRows, [])
    assert.deepEqual(result.state.punchCounts, EMPTY_COUNTS)
  }
})

for (const type of ['jab', 'cross', 'hook', 'uppercut']) {
  test(`records a detected ${type} and applies it to the current combo`, () => {
    const h = createHarness()
    h.service.startRound()

    const result = throwPunch(h, type)
    assert.equal(result.accepted, true)
    assert.ok(result.punchEvent)
    assert.equal(result.punchEvent.id, 'id-2')
    assert.equal(result.punchEvent.punch, type)
    assert.equal(result.punchEvent.side, type === 'cross' ? 'right' : 'left')
    assert.ok(Number.isFinite(result.punchEvent.score))
    assert.equal(result.punchEvent.expected, 'jab')
    assert.equal(result.punchEvent.expectedIndex, 0)
    assert.equal(result.punchEvent.matched, type === 'jab')
    assert.equal(result.punchEvent.comboLocked, false)
    assert.equal(
      result.punchEvent.detectedAt,
      new Date(h.wall).toISOString(),
    )
    assert.deepEqual(result.state.lastPunchEvent, result.punchEvent)
    assert.deepEqual(result.state.punchCounts, {
      ...EMPTY_COUNTS,
      [type]: 1,
    })
    assert.equal(result.state.debugRows.length, 2)

    if (type === 'jab') {
      assert.equal(result.state.comboStepIndex, 1)
      assert.equal(result.state.comboResult, 'active')
      assert.deepEqual(result.state.comboStats, EMPTY_STATS)
    } else {
      assert.equal(result.state.comboStepIndex, 0)
      assert.equal(result.state.comboResult, 'failed')
      assert.deepEqual(result.state.comboStats, {
        succeeded: 0,
        failed: 1,
        total: 1,
      })
    }

    const session = h.service.endRound().session
    assert.deepEqual(session.details.punchCounts, result.state.punchCounts)
    assert.deepEqual(session.comboStats, result.state.comboStats)
  })
}

test('passes 3D frame data to classification', () => {
  const h = createHarness()
  h.service.startRound()

  const worldPose = (extended) => [
    { name: 'left_shoulder', x: 0, y: 0, z: 0, score: 1 },
    { name: 'left_elbow', x: 0.3, y: 0, z: 0, score: 1 },
    {
      name: 'left_wrist',
      x: extended ? 0.6 : 0.3,
      y: extended ? 0 : 0.3,
      z: 0,
      score: 1,
    },
  ]

  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(
      frame(h.time, pose(), worldPose(false)),
    )
    assert.equal(result.punchEvent, null)
  }

  h.advance(50)
  const result = h.service.submitFrame(
    frame(h.time, pose(), worldPose(true)),
  )
  assert.equal(result.punchEvent.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
  const leftDebug = result.state.debugRows.find((row) => row.side === 'left')
  assert.equal(leftDebug.cues.straight3D, true)
})

for (const [speed, delay] of [
  ['form', 1000],
  ['casual', 650],
  ['intense', 350],
]) {
  test(`successful ${speed} combos release exactly at their configured delay`, () => {
    const h = createHarness()
    h.service.startRound(speed)

    const first = throwPunch(h, 'jab')
    assert.equal(first.state.comboStepIndex, 1)

    const second = throwPunch(h, 'cross')
    assert.equal(second.punchEvent.matched, true)
    assert.equal(second.punchEvent.expected, 'cross')
    assert.equal(second.punchEvent.expectedIndex, 1)
    assert.equal(second.state.comboStepIndex, 2)
    assert.equal(second.state.comboResult, 'success')
    assert.deepEqual(second.state.comboStats, {
      succeeded: 1,
      failed: 0,
      total: 1,
    })
    assert.deepEqual(second.state.punchCounts, {
      jab: 1,
      cross: 1,
      hook: 0,
      uppercut: 0,
    })

    const generation = h.service.getGeneration()
    h.setRandom(0.4)
    h.advance(delay - 1)
    assert.equal(h.service.getState().comboResult, 'success')

    h.advance(1)
    const released = h.service.getState()
    assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
    assert.equal(released.comboStepIndex, 0)
    assert.equal(released.comboResult, 'idle')
    assert.deepEqual(released.comboStats, second.state.comboStats)
    assert.deepEqual(released.lastPunchEvent, second.punchEvent)
    assert.equal(h.service.getGeneration(), generation)
  })
}

test('punches during a combo lock are counted without changing combo statistics', () => {
  const h = createHarness()
  h.service.startRound()
  const failed = throwPunch(h, 'cross')

  const locked = throwPunch(h, 'jab')
  assert.equal(locked.punchEvent.punch, 'jab')
  assert.equal(locked.punchEvent.comboLocked, true)
  assert.equal(locked.punchEvent.matched, false)
  assert.equal(locked.state.comboResult, 'failed')
  assert.deepEqual(locked.state.comboStats, failed.state.comboStats)
  assert.deepEqual(locked.state.punchCounts, {
    jab: 1,
    cross: 1,
    hook: 0,
    uppercut: 0,
  })

  h.setRandom(0.4)
  h.advance(500)
  assert.equal(h.service.getState().comboResult, 'idle')
  assert.deepEqual(h.service.getState().currentCombo, ['uppercut', 'hook'])
})

test('pause preserves the remaining combo lock delay', () => {
  const h = createHarness()
  h.service.startRound()
  throwPunch(h, 'cross')
  h.advance(100)
  h.service.pauseRound()
  h.setRandom(0.4)

  h.advance(2000)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.service.resumeRound()

  h.advance(549)
  assert.equal(h.service.getState().comboResult, 'failed')
  h.advance(1)

  const state = h.service.getState()
  assert.equal(state.comboResult, 'idle')
  assert.deepEqual(state.currentCombo, ['uppercut', 'hook'])
})

test('same-side cooldown prevents a second rapid punch from being counted', () => {
  const h = createHarness()
  h.service.startRound()
  assert.equal(throwPunch(h, 'jab').punchEvent.punch, 'jab')

  const suppressed = throwPunch(h, 'jab')
  assert.equal(suppressed.accepted, true)
  assert.equal(suppressed.punchEvent, null)
  assert.equal(suppressed.state.punchCounts.jab, 1)
  assert.equal(suppressed.state.comboStepIndex, 1)

  h.advance(300)
  const recovered = throwPunch(h, 'jab')
  assert.equal(recovered.punchEvent.punch, 'jab')
  assert.equal(recovered.state.punchCounts.jab, 2)
  assert.equal(recovered.punchEvent.expected, 'cross')
  assert.equal(recovered.state.comboResult, 'failed')
})

test('pause and resume discard motion history but preserve counts and combo progress', () => {
  const h = createHarness()
  h.service.startRound()
  throwPunch(h, 'jab')
  const before = h.service.getState()

  const [guard, extension] = punchPoses('cross')
  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    h.service.submitFrame(frame(h.time, guard))
  }

  h.service.pauseRound()
  h.advance(1000)
  h.service.resumeRound()
  h.advance(50)

  const result = h.service.submitFrame(frame(h.time, extension))
  assert.equal(result.accepted, true)
  assert.equal(result.punchEvent, null)
  assert.deepEqual(result.state.debugRows, [])
  assert.deepEqual(result.state.punchCounts, before.punchCounts)
  assert.equal(result.state.comboStepIndex, before.comboStepIndex)
  assert.deepEqual(result.state.lastPunchEvent, before.lastPunchEvent)
})

test('a restarted round clears history, counts, and same-side cooldowns', () => {
  const h = createHarness()
  h.service.startRound()
  throwPunch(h, 'jab')
  const previous = h.service.endRound().session

  const fresh = h.service.startRound()
  assert.deepEqual(fresh.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(fresh.comboStats, EMPTY_STATS)
  assert.deepEqual(fresh.debugRows, [])
  assert.equal(fresh.lastPunchEvent, null)
  assert.equal(fresh.session.completedSession, null)

  const result = throwPunch(h, 'jab')
  assert.equal(result.punchEvent.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
  assert.equal(result.state.comboResult, 'active')
  assert.equal(previous.details.punchCounts.jab, 1)
})

test('snapshots isolate mutable round, combo, punch, and nested debug data', () => {
  const h = createHarness()
  h.service.startRound()
  const result = throwPunch(h, 'jab')
  const expected = h.service.getState()

  result.state.round.status = 'corrupted'
  result.state.currentCombo.push('corrupted')
  result.state.comboStats.total = 99
  result.state.punchCounts.jab = 99
  result.state.lastPunchEvent.punch = 'corrupted'
  result.state.debugRows[0].scoreByType.jab = -999
  result.state.debugRows[0].cues.straight2D = 'corrupted'
  result.state.debugRows.push({ side: 'corrupted' })
  result.state.session.completedSession = { id: 'corrupted' }

  assert.deepEqual(h.service.getState(), expected)

  const snapshot = h.service.getState()
  snapshot.currentCombo[0] = 'corrupted'
  snapshot.debugRows[0].cues.straight2D = 'corrupted'
  assert.deepEqual(h.service.getState(), expected)
})

test('accepted frame data is copied before being retained in motion history', () => {
  const h = createHarness()
  h.service.startRound()
  const [guard, extension] = punchPoses('jab')

  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const input = frame(h.time, structuredClone(guard))
    assert.equal(h.service.submitFrame(input).accepted, true)

    for (const point of input.keypoints) {
      point.x = 1_000_000
      point.y = 1_000_000
      point.name = 'changed'
    }
    input.keypoints.length = 0
    input.time = 0
  }

  h.advance(50)
  const result = h.service.submitFrame(frame(h.time, extension))
  assert.equal(result.punchEvent.punch, 'jab')
  assert.equal(result.state.punchCounts.jab, 1)
})

test('separate service instances do not share state or completion queues', () => {
  const first = createHarness()
  const second = createHarness()

  first.service.startRound('intense')
  throwPunch(first, 'jab')
  first.service.endRound()

  const untouched = second.service.getState()
  assert.equal(untouched.round.status, 'ready')
  assert.equal(untouched.round.generation, 0)
  assert.deepEqual(untouched.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(untouched.comboStats, EMPTY_STATS)
  assert.deepEqual(second.service.takeCompletions(), [])
  assert.equal(first.service.takeCompletions().length, 1)
})
