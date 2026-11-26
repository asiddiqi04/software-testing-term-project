import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUND_SECONDS,
  TrainingError,
  createTrainingService,
} from '../../frontend/src/training/trainingService.js'

const EMPTY_COUNTS = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
const EMPTY_STATS = { succeeded: 0, failed: 0, total: 0 }
const WALL_START = Date.parse('2026-01-01T12:00:00.000Z')

function harness() {
  let monotonicTime = 1000
  let wallTime = WALL_START
  let randomValue = 0
  let ids = 0

  const service = createTrainingService({
    now: () => monotonicTime,
    wallNow: () => wallTime,
    random: () => randomValue,
    createId: () => `id-${++ids}`,
  })

  return {
    service,
    now: () => monotonicTime,
    wallNow: () => wallTime,
    advance(ms) {
      monotonicTime += ms
      wallTime += ms
    },
    setNow(value) {
      monotonicTime = value
    },
    setWall(value) {
      wallTime = value
    },
    setRandom(value) {
      randomValue = value
    },
    idCount: () => ids,
  }
}

function minimalFrame(time) {
  return { time, keypoints: [{ name: 'nose', x: 50, y: -50 }] }
}

// Deterministic trajectories exercise trainingService through its public API.
function poseFrame(time, type = null, extended = false) {
  const points = {
    nose: [50, -50],
    left_shoulder: [0, 0],
    right_shoulder: [100, 0],
    left_hip: [0, 200],
    right_hip: [100, 200],
    left_elbow: [-40, 0],
    left_wrist: [0, -40],
    right_elbow: [140, 0],
    right_wrist: [100, -40],
  }

  if (type === 'jab' && extended) {
    points.left_elbow = [-60, 0]
    points.left_wrist = [-120, 0]
  } else if (type === 'cross' && extended) {
    points.right_elbow = [160, 0]
    points.right_wrist = [220, 0]
  } else if (type === 'hook') {
    points.left_elbow = [0, -20]
    points.left_wrist = extended ? [60, -20] : [20, -20]
  } else if (type === 'uppercut') {
    points.left_elbow = [40, 0]
    points.left_wrist = extended ? [40, -40] : [40, 40]
  }

  return {
    time,
    keypoints: Object.entries(points).map(([name, [x, y]]) => ({
      name,
      x,
      y,
      score: 1,
    })),
  }
}

function punch(h, type) {
  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(poseFrame(h.now(), type))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }
  h.advance(50)
  const result = h.service.submitFrame(poseFrame(h.now(), type, true))
  assert.equal(result.accepted, true)
  assert.ok(result.punchEvent, `Expected a ${type} event`)
  assert.equal(result.punchEvent.punch, type)
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
  const error = new TrainingError('Invalid training input')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'TrainingError')
  assert.equal(error.message, 'Invalid training input')
})

test('initial state is ready with independent, empty statistics', () => {
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
    comboStats: EMPTY_STATS,
    comboResult: 'idle',
    lastPunchEvent: null,
    punchCounts: EMPTY_COUNTS,
    debugRows: [],
    session: { completedSession: null },
  })
  assert.equal(h.service.getGeneration(), 0)
  assert.equal(h.idCount(), 0)
  assert.deepEqual(h.service.takeCompletions(), [])

  const defaultService = createTrainingService()
  assert.equal(defaultService.getState().round.status, 'ready')
  assert.equal(defaultService.getState().round.speed, 'casual')
})

test('pause, resume, and end are harmless before a round starts', () => {
  const { service } = harness()
  const initial = service.getState()

  assert.deepEqual(service.pauseRound(), initial)
  assert.deepEqual(service.resumeRound(), initial)
  assert.deepEqual(service.endRound(), { state: initial, session: null })
  assert.equal(service.getGeneration(), 0)
  assert.deepEqual(service.takeCompletions(), [])
})

for (const [speed, interval] of [
  ['form', 80],
  ['casual', 50],
  ['intense', 25],
]) {
  test(`startRound configures ${speed} speed`, () => {
    const h = harness()
    h.setRandom(0.4)
    const state = h.service.startRound(speed)

    assert.equal(state.round.status, 'running')
    assert.equal(state.round.isRunning, true)
    assert.equal(state.round.id, 'id-1')
    assert.equal(state.round.generation, 1)
    assert.equal(h.service.getGeneration(), 1)
    assert.equal(state.round.speed, speed)
    assert.equal(state.round.frameIntervalMs, interval)
    assert.equal(state.round.startedAt, new Date(WALL_START).toISOString())
    assert.equal(state.round.endedAt, null)
    assert.equal(state.round.elapsedSeconds, 0)
    assert.equal(state.round.timeLeftSeconds, 180)
    assert.deepEqual(state.currentCombo, ['uppercut', 'hook'])
  })
}

test('startRound defaults to casual and does not restart active rounds', () => {
  const h = harness()
  const first = h.service.startRound()
  assert.equal(first.round.speed, 'casual')

  h.advance(1234)
  const running = h.service.getState()
  assert.deepEqual(h.service.startRound('intense'), running)
  assert.deepEqual(h.service.resumeRound(), running)

  const paused = h.service.pauseRound()
  h.advance(5000)
  assert.deepEqual(h.service.startRound('form'), paused)
  assert.deepEqual(h.service.pauseRound(), paused)
  assert.equal(h.idCount(), 1)
  assert.equal(h.service.getGeneration(), 2)
})

test('invalid speeds throw TrainingError without changing state', () => {
  const h = harness()
  const invalid = [
    null, '', 'fast', 'Casual', ' casual ', 'toString', '__proto__',
    1, true, {}, [], new String('casual'),
  ]

  for (const active of [false, true]) {
    if (active) h.service.startRound('form')
    const before = h.service.getState()

    for (const speed of invalid) {
      assertTrainingError(
        () => h.service.startRound(speed),
        'Choose a round speed: form, casual, or intense.',
      )
      assert.deepEqual(h.service.getState(), before)
    }
  }
})

test('elapsed time uses the monotonic clock and rounds displayed seconds correctly', () => {
  const h = harness()
  h.service.startRound()

  h.advance(999)
  h.setWall(WALL_START + 86_400_000)
  let state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)

  h.advance(1)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)

  h.advance(1)
  state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 1)
  assert.equal(state.round.timeLeftSeconds, 179)

  const { session } = h.service.endRound()
  assert.equal(session.durationSeconds, 1.001)
  assert.equal(session.endedAt, new Date(h.wallNow()).toISOString())
})

test('elapsed time cannot become negative', () => {
  const h = harness()
  h.service.startRound()
  h.setNow(900)

  const state = h.service.getState()
  assert.equal(state.round.elapsedSeconds, 0)
  assert.equal(state.round.timeLeftSeconds, 180)
  assert.equal(h.service.endRound().session.durationSeconds, 0)
})

test('multiple pauses freeze the timer and exclude paused time from completion', () => {
  const h = harness()
  h.service.startRound()

  h.advance(1250)
  const firstPause = h.service.pauseRound()
  assert.equal(firstPause.round.status, 'paused')
  assert.equal(firstPause.round.isRunning, false)
  assert.equal(firstPause.round.generation, 2)
  assert.equal(firstPause.round.elapsedSeconds, 1)
  assert.equal(firstPause.round.timeLeftSeconds, 179)

  h.advance(10_000)
  assert.deepEqual(h.service.getState(), firstPause)
  const resumed = h.service.resumeRound()
  assert.equal(resumed.round.status, 'running')
  assert.equal(resumed.round.generation, 3)
  assert.equal(resumed.round.elapsedSeconds, 1)

  h.advance(750)
  assert.equal(h.service.pauseRound().round.generation, 4)
  h.advance(5000)
  assert.equal(h.service.resumeRound().round.generation, 5)
  h.advance(500)

  const { state, session } = h.service.endRound()
  assert.equal(state.round.generation, 6)
  assert.equal(state.round.elapsedSeconds, 2)
  assert.equal(state.round.timeLeftSeconds, 178)
  assert.equal(session.durationSeconds, 2.5)
})

test('ending while paused uses the time at which the round was paused', () => {
  const h = harness()
  h.service.startRound('intense')
  h.advance(3456)
  h.service.pauseRound()
  h.advance(500_000)

  assert.equal(h.service.getState().round.status, 'paused')
  assert.deepEqual(h.service.takeCompletions(), [])

  const { state, session } = h.service.endRound()
  assert.equal(session.durationSeconds, 3.456)
  assert.equal(session.endedAt, new Date(h.wallNow()).toISOString())
  assert.equal(state.round.elapsedSeconds, 3)
  assert.equal(state.round.timeLeftSeconds, 177)
  assert.equal(state.round.status, 'ended')
})

test('manual completion is immutable, idempotent, and queued exactly once', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(2500)

  const result = h.service.endRound()
  assert.deepEqual(result.session, {
    schemaVersion: 1,
    id: 'id-1',
    startedAt: new Date(WALL_START).toISOString(),
    endedAt: new Date(WALL_START + 2500).toISOString(),
    roundDurationSeconds: 180,
    durationSeconds: 2.5,
    comboStats: EMPTY_STATS,
    details: { speed: 'form', punchCounts: EMPTY_COUNTS },
  })
  assert.equal(result.state.round.status, 'ended')
  assert.equal(result.state.round.isRunning, false)
  assert.equal(result.state.round.generation, 2)
  assert.strictEqual(result.state.session.completedSession, result.session)

  for (const value of [
    result.session,
    result.session.comboStats,
    result.session.details,
    result.session.details.punchCounts,
  ]) {
    assert.equal(Object.isFrozen(value), true)
  }
  assert.throws(() => { result.session.id = 'changed' }, TypeError)
  assert.throws(() => { result.session.comboStats.total = 99 }, TypeError)
  assert.throws(() => { result.session.details.speed = 'intense' }, TypeError)
  assert.throws(() => { result.session.details.punchCounts.jab = 99 }, TypeError)

  h.advance(10_000)
  assert.deepEqual(h.service.getState(), result.state)
  assert.deepEqual(h.service.pauseRound(), result.state)
  assert.deepEqual(h.service.resumeRound(), result.state)
  assert.strictEqual(h.service.endRound().session, result.session)
  assert.equal(h.service.getGeneration(), 2)

  const queued = h.service.takeCompletions()
  assert.equal(queued.length, 1)
  assert.strictEqual(queued[0], result.session)
  assert.deepEqual(h.service.takeCompletions(), [])
  h.service.endRound()
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('the round remains active until the exact duration boundary', () => {
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
  assert.equal(ended.round.elapsedSeconds, 180)
  assert.equal(ended.round.timeLeftSeconds, 0)
  assert.equal(ended.session.completedSession.durationSeconds, 180)
  assert.equal(h.service.takeCompletions().length, 1)
})

for (const operation of ['getState', 'pauseRound', 'resumeRound', 'submitFrame', 'endRound']) {
  test(`${operation} completes an overdue round exactly once`, () => {
    const h = harness()
    h.service.startRound()
    h.advance(200_000)

    let state
    if (operation === 'submitFrame') {
      const result = h.service.submitFrame(null)
      assert.equal(result.accepted, false)
      assert.equal(result.punchEvent, null)
      state = result.state
    } else if (operation === 'endRound') {
      state = h.service.endRound().state
    } else {
      state = h.service[operation]()
    }

    assert.equal(state.round.status, 'ended')
    assert.equal(state.round.generation, 2)
    assert.equal(state.round.elapsedSeconds, 180)
    assert.equal(state.round.timeLeftSeconds, 0)
    assert.equal(state.session.completedSession.durationSeconds, 180)
    assert.equal(h.service.takeCompletions().length, 1)
    h.service.getState()
    h.service.endRound()
    assert.deepEqual(h.service.takeCompletions(), [])
  })
}

test('reset abandons an unfinished round and preserves its speed', () => {
  const h = harness()
  h.service.startRound('intense')
  punch(h, 'jab')
  h.service.pauseRound()
  h.setRandom(0.4)

  const reset = h.service.resetRound()
  assert.equal(reset.round.status, 'ready')
  assert.equal(reset.round.generation, 3)
  assert.equal(reset.round.speed, 'intense')
  assert.equal(reset.round.frameIntervalMs, 25)
  assert.equal(reset.round.id, null)
  assert.equal(reset.round.startedAt, null)
  assert.equal(reset.round.endedAt, null)
  assert.equal(reset.round.elapsedSeconds, 0)
  assert.equal(reset.round.timeLeftSeconds, 180)
  assert.deepEqual(reset.currentCombo, ['uppercut', 'hook'])
  assert.deepEqual(reset.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(reset.comboStats, EMPTY_STATS)
  assert.equal(reset.comboStepIndex, 0)
  assert.equal(reset.comboResult, 'idle')
  assert.equal(reset.lastPunchEvent, null)
  assert.deepEqual(reset.debugRows, [])
  assert.equal(reset.session.completedSession, null)
  assert.deepEqual(h.service.takeCompletions(), [])

  assert.equal(h.service.resetRound().round.generation, 4)
  assert.equal(h.service.startRound().round.speed, 'casual')
})

test('resetting an overdue round preserves its queued completion', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(180_000)

  const reset = h.service.resetRound()
  assert.equal(reset.round.status, 'ready')
  assert.equal(reset.round.generation, 3)
  assert.equal(reset.round.speed, 'form')
  assert.equal(reset.session.completedSession, null)

  const [completed] = h.service.takeCompletions()
  assert.equal(completed.id, 'id-1')
  assert.equal(completed.durationSeconds, 180)
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('starting after expiration completes the old round and starts a fresh one', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(180_000)

  const next = h.service.startRound('intense')
  assert.equal(next.round.status, 'running')
  assert.equal(next.round.id, 'id-2')
  assert.equal(next.round.generation, 3)
  assert.equal(next.round.speed, 'intense')
  assert.equal(next.round.elapsedSeconds, 0)
  assert.equal(next.round.timeLeftSeconds, 180)
  assert.equal(next.session.completedSession, null)

  const [previous] = h.service.takeCompletions()
  assert.equal(previous.id, 'id-1')
  assert.equal(previous.details.speed, 'form')
  assert.equal(previous.durationSeconds, 180)
})

test('completion queues preserve order across restarts and drain independently', () => {
  const h = harness()
  h.service.startRound('form')
  h.advance(1000)
  const first = h.service.endRound().session

  const restarted = h.service.startRound('intense')
  assert.equal(restarted.round.id, 'id-2')
  assert.equal(restarted.round.generation, 3)
  assert.deepEqual(restarted.punchCounts, EMPTY_COUNTS)
  assert.deepEqual(restarted.comboStats, EMPTY_STATS)
  assert.equal(restarted.session.completedSession, null)

  h.advance(2000)
  const second = h.service.endRound().session
  h.service.resetRound()

  const drained = h.service.takeCompletions()
  assert.deepEqual(drained, [first, second])
  drained.pop()
  assert.deepEqual(h.service.takeCompletions(), [])

  h.service.startRound()
  const third = h.service.endRound().session
  assert.deepEqual(h.service.takeCompletions(), [third])
  assert.equal(first.durationSeconds, 1)
  assert.equal(second.durationSeconds, 2)
})

test('inactive and stale-generation frames are rejected before validation', () => {
  const h = harness()
  const reject = (generation) => {
    const before = h.service.getState()
    assert.deepEqual(h.service.submitFrame(null, generation), {
      state: before,
      punchEvent: null,
      accepted: false,
    })
  }

  reject(0)
  const first = h.service.startRound().round.generation
  reject(first - 1)
  reject(first + 1)

  const paused = h.service.pauseRound().round.generation
  reject(paused)
  const resumed = h.service.resumeRound().round.generation
  reject(first)
  reject(paused)

  h.service.resetRound()
  h.service.startRound()
  reject(resumed)
  h.service.endRound()
  reject(h.service.getGeneration())
})

test('invalid frames throw TrainingError and leave active state unchanged', () => {
  const h = harness()
  h.service.startRound()
  const good = () => minimalFrame(h.now())
  const cases = []

  for (const value of [null, undefined, false, 7, 'frame']) {
    cases.push([value, 'Pose frame must be an object.'])
  }
  for (const keypoints of [undefined, null, {}, 'points', []]) {
    cases.push([{ time: h.now(), keypoints }, 'keypoints must be a non-empty array.'])
  }
  for (const point of [
    null,
    {},
    { name: '', x: 0, y: 0 },
    { name: '   ', x: 0, y: 0 },
    { name: 3, x: 0, y: 0 },
    { name: 'nose', x: '0', y: 0 },
    { name: 'nose', x: 0, y: NaN },
    { name: 'nose', x: Infinity, y: 0 },
    { name: 'nose', x: 0, y: 0, z: Infinity },
    { name: 'nose', x: 0, y: 0, score: '1' },
  ]) {
    cases.push([
      { time: h.now(), keypoints: [point] },
      'Each keypoint must include name, numeric x, and numeric y values.',
    ])
  }
  for (const keypoints3D of [
    {},
    'points',
    [null],
    [{ name: 'nose', x: 0, y: 0 }],
    [{ name: 'nose', x: 0, y: 0, z: NaN }],
    [{ name: 'nose', x: 0, y: 0, z: '0' }],
  ]) {
    cases.push([
      { ...good(), keypoints3D },
      'keypoints3D must contain named points with numeric x, y, and z values.',
    ])
  }
  for (const time of [undefined, null, -1, NaN, Infinity, '1000']) {
    cases.push([
      { ...good(), time },
      'A monotonic frame timestamp is required.',
    ])
  }

  const before = h.service.getState()
  for (const [frame, message] of cases) {
    assertTrainingError(() => h.service.submitFrame(frame), message)
    assert.deepEqual(h.service.getState(), before)
  }
  assert.deepEqual(h.service.takeCompletions(), [])
})

test('accepts valid optional 3D data and frames without detectable arms', () => {
  const h = harness()
  h.service.startRound()

  for (const keypoints3D of [
    undefined,
    null,
    [],
    [{ name: 'nose', x: 0, y: 0, z: 0, score: 1 }],
  ]) {
    h.advance(50)
    const result = h.service.submitFrame({
      ...minimalFrame(h.now()),
      keypoints3D,
    })
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
    assert.deepEqual(result.state.punchCounts, EMPTY_COUNTS)
    assert.deepEqual(result.state.comboStats, EMPTY_STATS)
    assert.deepEqual(result.state.debugRows, [])
  }
})

test('frame timestamps must be within the round and strictly increasing', () => {
  const h = harness()
  h.service.startRound()

  assert.equal(h.service.submitFrame(minimalFrame(h.now())).accepted, true)
  h.advance(100)
  assert.equal(h.service.submitFrame(minimalFrame(1050.5)).accepted, true)

  for (const time of [999, 1000, 1050.5, 1040, 1101]) {
    const before = h.service.getState()
    assert.deepEqual(h.service.submitFrame(minimalFrame(time)), {
      state: before,
      punchEvent: null,
      accepted: false,
    })
  }

  assert.equal(h.service.submitFrame(minimalFrame(1100)).accepted, true)
  assert.equal(h.service.submitFrame(minimalFrame(1100)).accepted, false)
})

for (const type of ['jab', 'cross', 'hook', 'uppercut']) {
  test(`submitFrame records a detected ${type} and updates combo state`, () => {
    const h = harness()
    h.service.startRound()
    const result = punch(h, type)
    const matched = type === 'jab'

    assert.deepEqual(result.state.punchCounts, {
      ...EMPTY_COUNTS,
      [type]: 1,
    })
    assert.equal(result.punchEvent.id, 'id-2')
    assert.equal(result.punchEvent.side, type === 'cross' ? 'right' : 'left')
    assert.ok(Number.isFinite(result.punchEvent.score))
    assert.ok(result.punchEvent.score > 0)
    assert.equal(result.punchEvent.expected, 'jab')
    assert.equal(result.punchEvent.expectedIndex, 0)
    assert.equal(result.punchEvent.matched, matched)
    assert.equal(result.punchEvent.comboLocked, false)
    assert.equal(result.punchEvent.detectedAt, new Date(h.wallNow()).toISOString())
    assert.deepEqual(result.state.lastPunchEvent, result.punchEvent)
    assert.equal(result.state.comboStepIndex, matched ? 1 : 0)
    assert.equal(result.state.comboResult, matched ? 'active' : 'failed')
    assert.deepEqual(
      result.state.comboStats,
      matched ? EMPTY_STATS : { succeeded: 0, failed: 1, total: 1 },
    )
    assert.equal(result.state.debugRows.length, 2)

    const { session } = h.service.endRound()
    assert.deepEqual(session.details.punchCounts, result.state.punchCounts)
    assert.deepEqual(session.comboStats, result.state.comboStats)
  })
}

for (const [speed, delay] of [
  ['form', 1000],
  ['casual', 650],
  ['intense', 350],
]) {
  test(`${speed} completes a combo and releases it at its configured delay`, () => {
    const h = harness()
    h.service.startRound(speed)
    punch(h, 'jab')
    const result = punch(h, 'cross')

    assert.equal(result.punchEvent.expected, 'cross')
    assert.equal(result.punchEvent.expectedIndex, 1)
    assert.equal(result.punchEvent.matched, true)
    assert.equal(result.state.comboStepIndex, 2)
    assert.equal(result.state.comboResult, 'success')
    assert.deepEqual(result.state.comboStats, { succeeded: 1, failed: 0, total: 1 })
    assert.deepEqual(result.state.punchCounts, { ...EMPTY_COUNTS, jab: 1, cross: 1 })

    h.setRandom(0.4)
    h.advance(delay - 1)
    assert.equal(h.service.getState().comboResult, 'success')
    h.advance(1)

    const released = h.service.getState()
    assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
    assert.equal(released.comboStepIndex, 0)
    assert.equal(released.comboResult, 'idle')
    assert.deepEqual(released.comboStats, { succeeded: 1, failed: 0, total: 1 })
    assert.deepEqual(released.lastPunchEvent, result.punchEvent)
    assert.equal(released.round.generation, 1)
  })
}

test('punches during the combo lock count without changing combo statistics', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'jab')
  punch(h, 'cross')
  const lockedPunch = punch(h, 'jab')

  assert.equal(lockedPunch.punchEvent.comboLocked, true)
  assert.equal(lockedPunch.punchEvent.matched, false)
  assert.equal(lockedPunch.punchEvent.expected, null)
  assert.equal(lockedPunch.punchEvent.expectedIndex, 2)
  assert.equal(lockedPunch.state.comboResult, 'success')
  assert.equal(lockedPunch.state.comboStepIndex, 2)
  assert.deepEqual(lockedPunch.state.comboStats, { succeeded: 1, failed: 0, total: 1 })
  assert.deepEqual(lockedPunch.state.punchCounts, { ...EMPTY_COUNTS, jab: 2, cross: 1 })
})

test('a failed combo locks, releases, and allows a subsequent success', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'cross')
  assert.deepEqual(h.service.getState().comboStats, {
    succeeded: 0, failed: 1, total: 1,
  })

  const locked = punch(h, 'jab')
  assert.equal(locked.punchEvent.comboLocked, true)
  assert.equal(locked.punchEvent.expected, 'jab')
  assert.equal(locked.punchEvent.matched, false)
  assert.equal(locked.state.comboResult, 'failed')
  assert.deepEqual(locked.state.comboStats, { succeeded: 0, failed: 1, total: 1 })

  h.advance(500)
  assert.equal(h.service.getState().comboResult, 'idle')
  punch(h, 'jab')
  const success = punch(h, 'cross')
  assert.deepEqual(success.state.comboStats, { succeeded: 1, failed: 1, total: 2 })
})

test('pausing preserves the remaining combo lock delay', () => {
  const h = harness()
  h.service.startRound()
  punch(h, 'jab')
  punch(h, 'cross')
  h.advance(200)
  h.service.pauseRound()

  h.setRandom(0.4)
  h.advance(5000)
  assert.equal(h.service.getState().comboResult, 'success')
  assert.equal(h.service.resumeRound().comboResult, 'success')

  h.advance(449)
  assert.equal(h.service.getState().comboResult, 'success')
  h.advance(1)
  const released = h.service.getState()
  assert.equal(released.comboResult, 'idle')
  assert.deepEqual(released.currentCombo, ['uppercut', 'hook'])
})

test('continuing to hold an extended arm does not count additional punches', () => {
  const h = harness()
  h.service.startRound()
  const detected = punch(h, 'jab')

  for (let index = 0; index < 50; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(poseFrame(h.now(), 'jab', true))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }

  const state = h.service.getState()
  assert.deepEqual(state.punchCounts, { ...EMPTY_COUNTS, jab: 1 })
  assert.deepEqual(state.lastPunchEvent, detected.punchEvent)
  assert.equal(state.comboStepIndex, 1)
  assert.equal(h.idCount(), 2)
})

test('pause and resume clear motion history so a punch cannot span a pause', () => {
  const h = harness()
  h.service.startRound()

  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    h.service.submitFrame(poseFrame(h.now(), 'jab'))
  }

  h.service.pauseRound()
  h.advance(50)
  h.service.resumeRound()

  for (let index = 0; index < 3; index += 1) {
    h.advance(50)
    const result = h.service.submitFrame(poseFrame(h.now(), 'jab', true))
    assert.equal(result.accepted, true)
    assert.equal(result.punchEvent, null)
  }
  assert.deepEqual(h.service.getState().punchCounts, EMPTY_COUNTS)
})

test('submitted keypoints are copied before being retained as motion history', () => {
  const h = harness()
  h.service.startRound()
  const submitted = []

  for (let index = 0; index < 2; index += 1) {
    h.advance(50)
    const frame = poseFrame(h.now(), 'jab')
    submitted.push(frame)
    assert.equal(h.service.submitFrame(frame).accepted, true)
  }

  for (const frame of submitted) {
    const elbow = frame.keypoints.find((point) => point.name === 'left_elbow')
    const wrist = frame.keypoints.find((point) => point.name === 'left_wrist')
    Object.assign(elbow, { x: -60, y: 0 })
    Object.assign(wrist, { x: -120, y: 0 })
    frame.time = 0
  }

  h.advance(50)
  const result = h.service.submitFrame(poseFrame(h.now(), 'jab', true))
  assert.equal(result.accepted, true)
  assert.equal(result.punchEvent.punch, 'jab')
  assert.deepEqual(result.state.punchCounts, { ...EMPTY_COUNTS, jab: 1 })
})

test('snapshots isolate mutable public state, including nested debug data', () => {
  const h = harness()
  h.service.startRound()
  const initial = h.service.getState()
  const result = punch(h, 'jab')
  const snapshot = result.state
  const expected = structuredClone(snapshot)

  snapshot.round.status = 'corrupted'
  snapshot.round.generation = -1
  snapshot.currentCombo[0] = 'corrupted'
  snapshot.comboStepIndex = 99
  snapshot.comboStats.total = 99
  snapshot.punchCounts.jab = 99
  snapshot.lastPunchEvent.punch = 'corrupted'
  snapshot.debugRows[0].scoreByType.jab = -100
  snapshot.debugRows[0].cues.straight2D = false
  snapshot.debugRows.push({ side: 'corrupted' })
  snapshot.session.completedSession = { id: 'corrupted' }

  assert.deepEqual(h.service.getState(), expected)
  assert.equal(h.service.getGeneration(), 1)
  assert.deepEqual(initial.punchCounts, EMPTY_COUNTS)
  assert.equal(initial.lastPunchEvent, null)
  assert.deepEqual(initial.debugRows, [])
})

test('service instances maintain independent state and completion queues', () => {
  const first = harness()
  const second = harness()

  first.service.startRound('form')
  punch(first, 'jab')
  const completed = first.service.endRound().session

  assert.equal(second.service.getGeneration(), 0)
  assert.equal(second.service.getState().round.status, 'ready')
  assert.deepEqual(second.service.getState().punchCounts, EMPTY_COUNTS)
  assert.deepEqual(second.service.takeCompletions(), [])
  assert.deepEqual(first.service.takeCompletions(), [completed])
})
