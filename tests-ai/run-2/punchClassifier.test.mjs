import test from 'node:test'
import assert from 'node:assert/strict'
import {
  punchTypes,
  initialPunchCounts,
  getPoint,
  dist2d,
  angleDeg,
  scorePunchForSide,
  classifyPunch,
} from '../../frontend/src/training/punchClassifier.js'

const GUARD = { elbow: [-50, 0], wrist: [-50, -70] }
const STRAIGHT = { elbow: [-75, 0], wrist: [-150, 0] }
const WORLD_GUARD = {
  shoulder: [0, 0, 0],
  elbow: [0.3, 0, 0],
  wrist: [0.3, 0, 0.3],
}

const hookPose = (x) => ({ elbow: [0, -30], wrist: [x, -30] })
const upperPose = (y) => ({ elbow: [60, 0], wrist: [60, y] })
const worldStraight = (reach = 0.6) => ({
  shoulder: [0, 0, 0],
  elbow: [0, 0, -reach / 2],
  wrist: [0, 0, -reach],
})

function point(name, x, y, score = 1) {
  return { name, x, y, score }
}

function makeFrame(time, left = GUARD, right = GUARD) {
  const keypoints = [
    point('left_shoulder', 0, 0),
    point('right_shoulder', 100, 0),
    point('left_hip', 0, 150),
    point('right_hip', 100, 150),
    point('nose', 50, -70),
  ]

  for (const [side, pose] of [
    ['left', left],
    ['right', right],
  ]) {
    for (const joint of ['elbow', 'wrist']) {
      const [x, y] = pose[joint]
      keypoints.push(point(`${side}_${joint}`, side === 'left' ? x : 100 - x, y))
    }
  }

  return { time, keypoints }
}

function historyFor(side, poses, times = poses.map((_, i) => 100 + i * 50)) {
  return poses.map((pose, i) =>
    side === 'left'
      ? makeFrame(times[i], pose, GUARD)
      : makeFrame(times[i], GUARD, pose),
  )
}

function straightHistory(side = 'left') {
  return historyFor(side, [GUARD, GUARD, STRAIGHT])
}

function hookHistory(side = 'left') {
  return historyFor(side, [hookPose(10), hookPose(30), hookPose(70)])
}

function upperHistory(side = 'left') {
  return historyFor(side, [60, 40, 20, -10, -60].map(upperPose))
}

function withWorld(frame, side, pose) {
  const keypoints3D = Object.entries(pose).map(([joint, [x, y, z]]) => ({
    name: `${side}_${joint}`,
    x: side === 'left' ? x : 1 - x,
    y,
    z,
    score: 1,
  }))

  return {
    ...frame,
    keypoints3D: [...(frame.keypoints3D ?? []), ...keypoints3D],
  }
}

function worldHistory(side, poses, times) {
  return historyFor(side, poses.map(() => GUARD), times).map((frame, i) =>
    withWorld(frame, side, poses[i]),
  )
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function assertDetection(result, type, side) {
  assert.ok(result.detection, `Expected a ${side} ${type}`)
  assert.equal(result.detection.type, type)
  assert.equal(result.detection.side, side)
  assert.equal(result.detection.score, result.debug.scoreByType[type])
  assert.equal(result.debug.bestType, type)
  assert.equal(result.debug.bestScore, result.detection.score)
  assert.ok(result.detection.score >= result.debug.threshold)
}

test('punchTypes lists all supported punches in order', () => {
  assert.deepEqual(punchTypes, ['jab', 'cross', 'hook', 'uppercut'])
})

test('initialPunchCounts returns independent zeroed objects', () => {
  const first = initialPunchCounts()
  const second = initialPunchCounts()

  assert.deepEqual(first, { jab: 0, cross: 0, hook: 0, uppercut: 0 })
  assert.deepEqual(Object.keys(first), punchTypes)
  assert.notStrictEqual(first, second)

  first.jab = 10
  first.extra = 1

  assert.deepEqual(second, { jab: 0, cross: 0, hook: 0, uppercut: 0 })
  assert.deepEqual(initialPunchCounts(), second)
})

test('getPoint handles absent collections, empty collections, and missing names', () => {
  assert.equal(getPoint(undefined, 'left_wrist'), undefined)
  assert.equal(getPoint(null, 'left_wrist'), undefined)
  assert.equal(getPoint([], 'left_wrist'), undefined)
  assert.equal(getPoint([point('right_wrist', 1, 2)], 'left_wrist'), undefined)
})

test('getPoint returns the first matching point that meets the inclusive threshold', () => {
  const low = point('left_wrist', 1, 2, 0.49)
  const accepted = point('left_wrist', 3, 4, 0.5)
  const later = point('left_wrist', 5, 6, 1)

  assert.strictEqual(
    getPoint([low, point('nose', 0, 0), accepted, later], 'left_wrist'),
    accepted,
  )
})

test('getPoint defaults nullish scores to one but respects zero and NaN', () => {
  const missingScore = { name: 'left_wrist', x: 1, y: 2 }
  const nullScore = { ...missingScore, score: null }
  const zeroScore = { ...missingScore, score: 0 }
  const nanScore = { ...missingScore, score: NaN }

  assert.strictEqual(getPoint([missingScore], 'left_wrist', 1), missingScore)
  assert.strictEqual(getPoint([nullScore], 'left_wrist', 1), nullScore)
  assert.equal(getPoint([missingScore], 'left_wrist', 1.01), undefined)
  assert.equal(getPoint([zeroScore], 'left_wrist'), undefined)
  assert.strictEqual(getPoint([zeroScore], 'left_wrist', 0), zeroScore)
  assert.equal(getPoint([nanScore], 'left_wrist'), undefined)
})

test('getPoint supports custom confidence thresholds', () => {
  const wrist = point('left_wrist', 1, 2, 0.25)
  assert.strictEqual(getPoint([wrist], 'left_wrist', 0.25), wrist)
  assert.equal(getPoint([wrist], 'left_wrist', 0.251), undefined)
})

test('dist2d calculates Euclidean distance and ignores depth', () => {
  const a = { x: -2, y: -3, z: 100 }
  const b = { x: 1, y: 1, z: -100 }

  assert.equal(dist2d(a, b), 5)
  assert.equal(dist2d(b, a), 5)
  assert.equal(dist2d(a, a), 0)
  closeTo(dist2d({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }), 0.5)
})

test('angleDeg measures the angle at the middle point', () => {
  const origin = { x: 0, y: 0 }

  closeTo(angleDeg({ x: 1, y: 0 }, origin, { x: 0, y: 1 }), 90)
  closeTo(angleDeg({ x: -1, y: 0 }, origin, { x: 1, y: 0 }), 180)
  closeTo(angleDeg({ x: 1, y: 0 }, origin, { x: 2, y: 0 }), 0)
  closeTo(
    angleDeg({ x: 1, y: 0 }, origin, { x: 0.5, y: Math.sqrt(3) / 2 }),
    60,
  )
})

test('angleDeg returns zero when either adjacent segment has zero length', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 1, y: 0 }

  assert.equal(angleDeg(a, a, b), 0)
  assert.equal(angleDeg(a, b, b), 0)
  assert.equal(angleDeg(a, a, a), 0)
})

test('angleDeg accepts a custom distance function', () => {
  const a = { x: 1, y: 0, z: 0 }
  const b = { x: 0, y: 0, z: 0 }
  const c = { x: 0, y: 0, z: 1 }
  const calls = []

  const distance = (first, second) => {
    calls.push([first, second])
    return Math.hypot(
      first.x - second.x,
      first.y - second.y,
      first.z - second.z,
    )
  }

  closeTo(angleDeg(a, b, c, distance), 90)
  assert.deepEqual(calls, [[a, b], [b, c], [a, c]])
  assert.equal(angleDeg(a, b, c), 0)
})

test('angleDeg clamps cosine values outside the valid acos range', () => {
  for (const [lengths, expected] of [
    [[1, 2, 0], 0],
    [[1, 1, 3], 180],
  ]) {
    let index = 0
    assert.equal(angleDeg({}, {}, {}, () => lengths[index++]), expected)
    assert.equal(index, 3)
  }
})

test('histories shorter than three frames have no detection or debug data', () => {
  for (const history of [[], [makeFrame(100)], [makeFrame(100), makeFrame(150)]]) {
    for (const side of ['left', 'right']) {
      assert.deepEqual(scorePunchForSide(side, history, {}), {
        detection: null,
        debug: null,
      })
    }
    assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] })
  }
})

test('each required current image point must be present and sufficiently confident', () => {
  const required = [
    'left_wrist',
    'left_elbow',
    'left_shoulder',
    'left_hip',
    'right_shoulder',
    'nose',
  ]

  for (const name of required) {
    const missing = straightHistory()
    missing.at(-1).keypoints = missing.at(-1).keypoints.filter(
      (entry) => entry.name !== name,
    )
    assert.deepEqual(scorePunchForSide('left', missing, {}), {
      detection: null,
      debug: null,
    }, `Missing ${name}`)

    const lowConfidence = straightHistory()
    getPoint(lowConfidence.at(-1).keypoints, name).score =
      name === 'nose' ? 0.299 : 0.499

    assert.deepEqual(scorePunchForSide('left', lowConfidence, {}), {
      detection: null,
      debug: null,
    }, `Low-confidence ${name}`)
  }
})

test('current image confidence thresholds are inclusive, with a lower nose threshold', () => {
  const history = straightHistory()
  for (const entry of history.at(-1).keypoints) {
    entry.score = entry.name === 'nose' ? 0.3 : 0.5
  }
  assertDetection(scorePunchForSide('left', history, {}), 'jab', 'left')
})

test('missing current keypoints returns an empty result', () => {
  const history = straightHistory()
  delete history.at(-1).keypoints

  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

for (const [side, straightType] of [['left', 'jab'], ['right', 'cross']]) {
  test(`${side} straight punches use the anatomical ${straightType} label`, () => {
    const result = scorePunchForSide(side, straightHistory(side), {})

    assertDetection(result, straightType, side)
    assert.deepEqual(result.detection, { type: straightType, score: 100, side })
    assert.equal(result.debug.side, side)
    assert.equal(result.debug.straightType, straightType)
    assert.deepEqual(Object.keys(result.debug.scoreByType), [
      straightType,
      'hook',
      'uppercut',
    ])
    assert.equal(result.debug.threshold, 68)
    assert.equal(result.debug.cooldownRemaining, 0)
    assert.equal(result.debug.recovered, true)
    assert.equal(result.debug.elbowAngle, 180)
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.forearmAngleToHorizontal, 0)
    assert.equal(result.debug.cues.straight2D, true)
    assert.equal(result.debug.cues.straight3D, false)
  })

  test(`${side} lateral bent-arm motion is detected as a hook`, () => {
    const result = scorePunchForSide(side, hookHistory(side), {})

    assertDetection(result, 'hook', side)
    assert.equal(result.detection.score, 144)
    assert.equal(result.debug.threshold, 62)
    assert.equal(result.debug.cues.lateralDominant, true)
    assert.equal(result.debug.cues.armParallelFloor, true)
    assert.equal(result.debug.elbowAngle, 90)
  })

  test(`${side} rising bent-arm motion from below the shoulder is an uppercut`, () => {
    const result = scorePunchForSide(side, upperHistory(side), {})

    assertDetection(result, 'uppercut', side)
    assert.equal(result.debug.threshold, 64)
    assert.equal(result.debug.cues.lowPrep, true)
    assert.equal(result.debug.cues.verticalDominant, true)
    assert.equal(result.debug.cues.armPerpendicularFloor, true)
    assert.equal(result.debug.cues.uppercutFromLow, true)
  })
}

test('stationary guards and stationary extended arms do not count as punches', () => {
  for (const pose of [GUARD, STRAIGHT, hookPose(70), upperPose(-60)]) {
    const history = historyFor('left', [pose, pose, pose])
    const result = scorePunchForSide('left', history, {})

    assert.equal(result.detection, null)
    assert.equal(result.debug.bestType, null)
    assert.equal(result.debug.bestScore, 0)
    assert.equal(result.debug.threshold, null)
  }
})

test('eligible motion below its confidence threshold is not detected', () => {
  const poses = [
    [-50, 60],
    [-50, 30],
    [-50, -20],
    [-100, -70],
    [-50, -70],
  ].map((wrist) => ({ elbow: [-50, 0], wrist }))

  const result = scorePunchForSide('left', historyFor('left', poses), {})

  assert.equal(result.debug.bestType, 'hook')
  assert.equal(result.debug.bestScore, 50)
  assert.equal(result.debug.threshold, 62)
  assert.equal(result.detection, null)
})

test('upward camera projection does not prevent a clear straight punch', () => {
  const tilted = { elbow: [-50, -50], wrist: [-100, -100] }
  const result = scorePunchForSide(
    'left',
    historyFor('left', [GUARD, GUARD, tilted]),
    {},
  )

  assertDetection(result, 'jab', 'left')
  assert.equal(result.debug.cues.straight2D, true)
})

test('a relaxed straight endpoint requires strong temporal elbow opening', () => {
  const radians = 33 * Math.PI / 180
  const endpoint = {
    elbow: [-50, 0],
    wrist: [-50 - 100 * Math.cos(radians), -100 * Math.sin(radians)],
  }
  const folded = { elbow: [-50, 0], wrist: [-25, -25 * Math.sqrt(3)] }

  const strong = scorePunchForSide(
    'left',
    historyFor('left', [folded, folded, endpoint]),
    {},
  )
  assertDetection(strong, 'jab', 'left')
  assert.equal(strong.debug.elbowAngle, 147)
  assert.equal(strong.debug.cues.elbowMostlyStraight, false)
  assert.equal(strong.debug.cues.straight2D, true)

  const weak = scorePunchForSide(
    'left',
    historyFor('left', [GUARD, GUARD, endpoint]),
    {},
  )
  assert.equal(weak.debug.cues.straight2D, false)
  assert.equal(weak.detection, null)
})

test('dropping the guard into a downward extended arm is not a 2D straight', () => {
  const downward = { elbow: [0, 75], wrist: [0, 150] }
  const result = scorePunchForSide(
    'left',
    historyFor('left', [GUARD, GUARD, downward]),
    {},
  )

  assert.equal(result.debug.cues.elbowMostlyStraight, true)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('2D straight motion tolerates slight recoil but rejects substantial recoil', () => {
  for (const [previousReach, expected] of [[151, true], [154, false]]) {
    const previous = { elbow: [-75, 0], wrist: [-previousReach, 0] }
    const result = scorePunchForSide(
      'left',
      historyFor('left', [GUARD, previous, STRAIGHT]),
      {},
    )

    assert.equal(result.debug.cues.straight2D, expected)
    assert.equal(result.detection?.type ?? null, expected ? 'jab' : null)
  }
})

test('a missing previous arm prevents a 2D straight despite older evidence', () => {
  const history = straightHistory()
  history[1].keypoints = history[1].keypoints.filter(
    (entry) => entry.name !== 'left_elbow',
  )

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('previous wrist velocity accepts confidence 0.25 and rejects lower confidence', () => {
  for (const [confidence, expected] of [[0.25, 'hook'], [0.249, null]]) {
    const history = hookHistory()
    getPoint(history[1].keypoints, 'left_wrist').score = confidence

    const result = scorePunchForSide('left', history, {})
    assert.equal(result.detection?.type ?? null, expected)
  }
})

test('a compact uppercut from guard needs sufficient confirmation time', () => {
  const poses = [-10, -25, -50].map(upperPose)
  const quick = historyFor('left', poses, [100, 125, 150])

  const casual = scorePunchForSide('left', quick, {}, 'casual')
  assert.equal(casual.debug.cues.uppercutFromLow, false)
  assert.equal(casual.debug.cues.uppercutFromGuard, false)
  assert.equal(casual.detection, null)

  const intense = scorePunchForSide('left', quick, {}, 'intense')
  assert.equal(intense.debug.cues.uppercutFromGuard, true)
  assertDetection(intense, 'uppercut', 'left')

  const form = scorePunchForSide(
    'left',
    historyFor('left', poses, [100, 170, 240]),
    {},
    'form',
  )
  assert.equal(form.debug.cues.uppercutFromGuard, true)
  assertDetection(form, 'uppercut', 'left')
})

test('whole-body upward translation does not supply an uppercut trajectory', () => {
  const history = historyFor('left', [
    upperPose(-10),
    upperPose(-10),
    upperPose(-10),
  ]).map((frame, i) => ({
    ...frame,
    keypoints: frame.keypoints.map((entry) => ({
      ...entry,
      y: entry.y - i * 30,
    })),
  }))

  const result = scorePunchForSide('left', history, {})

  assert.equal(result.debug.cues.verticalDominant, true)
  assert.equal(result.debug.cues.uppercutFromLow, false)
  assert.equal(result.debug.cues.uppercutFromGuard, false)
  assert.equal(result.detection, null)
})

test('closing the elbow after a straight does not count its recoil as a hook', () => {
  const result = scorePunchForSide(
    'left',
    historyFor('left', [GUARD, STRAIGHT, hookPose(70)]),
    {},
  )

  assert.equal(result.debug.cues.lateralDominant, true)
  assert.equal(result.debug.cues.returningFromStraight, true)
  assert.equal(result.detection, null)
})

for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
  test(`reliable 3D extension identifies a ${type} despite unchanged image geometry`, () => {
    const history = worldHistory(side, [
      WORLD_GUARD,
      WORLD_GUARD,
      worldStraight(),
    ])
    const result = scorePunchForSide(side, history, {})

    assertDetection(result, type, side)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.straight3D, true)
    assert.equal(result.debug.elbowAngle3D, 180)
  })
}

test('reliable 3D evidence can identify a downward-directed straight', () => {
  const downward = { elbow: [0, 75], wrist: [0, 150] }
  const worlds = [WORLD_GUARD, WORLD_GUARD, worldStraight()]
  const history = historyFor('left', [GUARD, GUARD, downward]).map(
    (frame, i) => withWorld(frame, 'left', worlds[i]),
  )

  const result = scorePunchForSide('left', history, {})
  assertDetection(result, 'jab', 'left')
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.cues.straight3D, true)
})

test('bent 3D geometry does not veto strong outward 2D straight evidence', () => {
  const history = straightHistory().map((frame) =>
    withWorld(frame, 'left', WORLD_GUARD),
  )
  const result = scorePunchForSide('left', history, {})

  assertDetection(result, 'jab', 'left')
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.straight2D, true)
  assert.equal(result.debug.cues.straight3D, false)
})

test('a confirmed inward sweep with a bent world elbow takes precedence over projection', () => {
  const across = { elbow: [75, 0], wrist: [150, 0] }
  const imageHistory = historyFor('left', [GUARD, GUARD, across])

  assertDetection(scorePunchForSide('left', imageHistory, {}), 'jab', 'left')

  const confirmed = imageHistory.map((frame) =>
    withWorld(frame, 'left', WORLD_GUARD),
  )
  const result = scorePunchForSide('left', confirmed, {})

  assertDetection(result, 'hook', 'left')
  assert.equal(result.debug.elbowAngle, 180)
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.sweepingBentArm, true)
  assert.equal(result.debug.cues.straight2D, false)
  assert.ok(result.detection.score >= 100)
})

test('3D bent-arm confirmation supports a foreshortened rising uppercut', () => {
  const poses = [
    { elbow: [60, 100], wrist: [60, 60] },
    { elbow: [60, 80], wrist: [60, 0] },
    { elbow: [60, 60], wrist: [60, -60] },
  ]
  const history = historyFor('left', poses)

  assert.equal(scorePunchForSide('left', history, {}).detection, null)

  const confirmed = history.map((frame) =>
    withWorld(frame, 'left', WORLD_GUARD),
  )
  const result = scorePunchForSide('left', confirmed, {})

  assertDetection(result, 'uppercut', 'left')
  assert.equal(result.debug.elbowAngle, 45)
  assert.equal(result.debug.cues.risingBentArm, true)
})

test('3D straight motion tolerates small recoil but rejects larger recoil', () => {
  for (const [previousReach, expected] of [[0.608, true], [0.61, false]]) {
    const history = worldHistory('left', [
      WORLD_GUARD,
      worldStraight(previousReach),
      worldStraight(0.6),
    ])
    const result = scorePunchForSide('left', history, {})

    assert.equal(result.debug.cues.straight3D, expected)
    assert.equal(result.detection?.type ?? null, expected ? 'jab' : null)
  }
})

test('invalid 3D geometry is ignored while valid 2D evidence remains usable', () => {
  const corruptions = [
    (frame) => {
      frame.keypoints3D = frame.keypoints3D.filter(
        (entry) => entry.name !== 'left_elbow',
      )
    },
    (frame) => {
      getPoint(frame.keypoints3D, 'left_wrist').score = 0.49
    },
    (frame) => {
      getPoint(frame.keypoints3D, 'left_wrist').x = NaN
    },
    (frame) => {
      getPoint(frame.keypoints3D, 'left_elbow').y = Infinity
    },
    (frame) => {
      delete getPoint(frame.keypoints3D, 'left_shoulder').z
    },
    (frame) => {
      getPoint(frame.keypoints3D, 'left_wrist').z = '0'
    },
  ]

  for (const corrupt of corruptions) {
    const history = straightHistory().map((frame) =>
      withWorld(frame, 'left', worldStraight()),
    )
    corrupt(history.at(-1))

    const result = scorePunchForSide('left', history, {})
    assertDetection(result, 'jab', 'left')
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.cues.straight3D, false)
  }
})

test('3D arm lengths below 0.1 are rejected and the boundary is accepted', () => {
  for (const [reach, expectedAngle] of [[0.09, null], [0.1, 180]]) {
    const history = worldHistory('left', [
      worldStraight(reach),
      worldStraight(reach),
      worldStraight(reach),
    ])
    const result = scorePunchForSide('left', history, {})

    assert.equal(result.debug.elbowAngle3D, expectedAngle)
    assert.equal(result.detection, null)
  }
})

test('3D evidence still requires valid current image landmarks', () => {
  const history = worldHistory('left', [
    WORLD_GUARD,
    WORLD_GUARD,
    worldStraight(),
  ])
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (entry) => entry.name !== 'left_hip',
  )

  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

test('frame gaps up to 250 ms are accepted, but longer gaps break motion', () => {
  for (const [lastTime, expected] of [[400, 'jab'], [401, null]]) {
    const history = historyFor('left', [GUARD, GUARD, STRAIGHT], [
      100, 150, lastTime,
    ])
    const result = scorePunchForSide('left', history, {})

    assert.equal(result.detection?.type ?? null, expected)
    assert.equal(result.debug.cues.straight2D, expected !== null)
  }
})

test('duplicate and backward timestamps break motion continuity', () => {
  for (const times of [[100, 200, 200], [100, 250, 200]]) {
    for (const poses of [
      [GUARD, GUARD, STRAIGHT],
      [hookPose(10), hookPose(30), hookPose(70)],
    ]) {
      const result = scorePunchForSide(
        'left',
        historyFor('left', poses, times),
        {},
      )
      assert.equal(result.detection, null)
    }
  }
})

test('motion windows include their boundary and exclude older evidence', () => {
  const atBoundary = historyFor('left', [GUARD, STRAIGHT, STRAIGHT], [
    100, 350, 450,
  ])
  assertDetection(
    scorePunchForSide('left', atBoundary, {}, 'casual'),
    'jab',
    'left',
  )

  const beyondBoundary = historyFor('left', [GUARD, STRAIGHT, STRAIGHT], [
    100, 350, 451,
  ])
  assert.equal(
    scorePunchForSide('left', beyondBoundary, {}, 'casual').detection,
    null,
  )
  assertDetection(
    scorePunchForSide('left', beyondBoundary, {}, 'form'),
    'jab',
    'left',
  )
  assert.equal(
    scorePunchForSide('left', atBoundary, {}, 'intense').detection,
    null,
  )
})

test('motion at or before the last punch is excluded from new evidence', () => {
  const history = historyFor('left', [GUARD, STRAIGHT, STRAIGHT], [
    100, 350, 450,
  ])

  assertDetection(scorePunchForSide('left', history, {}), 'jab', 'left')

  const result = scorePunchForSide('left', history, { left: 100 })
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('hook velocity is normalized across capture intervals', () => {
  const slower = historyFor(
    'left',
    [hookPose(30), hookPose(50), hookPose(70)],
    [100, 150, 200],
  )
  const faster = historyFor(
    'left',
    [hookPose(30), hookPose(60), hookPose(70)],
    [100, 175, 200],
  )

  const first = scorePunchForSide('left', slower, {})
  const second = scorePunchForSide('left', faster, {})

  assertDetection(first, 'hook', 'left')
  assertDetection(second, 'hook', 'left')
  assert.deepEqual(first.detection, second.detection)
  assert.equal(first.debug.cues.lateralDominant, true)
  assert.equal(second.debug.cues.lateralDominant, true)
})

test('motion normalization is capped for very short frame intervals', () => {
  const history = historyFor(
    'left',
    [hookPose(60), hookPose(68), hookPose(70)],
    [100, 190, 200],
  )

  assert.equal(scorePunchForSide('left', history, {}, 'casual').detection, null)
  assertDetection(
    scorePunchForSide('left', history, {}, 'form'),
    'hook',
    'left',
  )
})

test('each speed applies its strict minimum lateral-motion requirement', () => {
  for (const [speed, minMotion] of [
    ['form', 0.04],
    ['casual', 0.1],
    ['intense', 0.12],
  ]) {
    for (const [extraDistance, expected] of [[0, null], [0.5, 'hook']]) {
      const previousX = 70 - minMotion * 50 - extraDistance
      const history = historyFor('left', [
        hookPose(50),
        hookPose(previousX),
        hookPose(70),
      ])

      const result = scorePunchForSide('left', history, {}, speed)
      assert.equal(result.detection?.type ?? null, expected, speed)
    }
  }
})

function recoveredHistory(now = 500) {
  return historyFor(
    'left',
    [GUARD, STRAIGHT, GUARD, GUARD, STRAIGHT],
    [100, 200, 300, 400, now],
  )
}

test('cooldown suppresses an eligible recovered punch until the exact boundary', () => {
  const blocked = scorePunchForSide('left', recoveredHistory(499), { left: 200 })
  assert.equal(blocked.debug.bestType, 'jab')
  assert.equal(blocked.debug.bestScore, 100)
  assert.equal(blocked.debug.recovered, true)
  assert.equal(blocked.debug.cooldownRemaining, 1)
  assert.equal(blocked.detection, null)

  const allowed = scorePunchForSide('left', recoveredHistory(500), { left: 200 })
  assert.equal(allowed.debug.cooldownRemaining, 0)
  assertDetection(allowed, 'jab', 'left')
})

test('fractional cooldown remains enforced even when the debug value rounds to zero', () => {
  const result = scorePunchForSide('left', recoveredHistory(499.6), {
    left: 200,
  })

  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.recovered, true)
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.detection, null)
})

test('speed selection changes cooldown duration', () => {
  const history = recoveredHistory()
  const form = scorePunchForSide('left', history, { left: 200 }, 'form')
  const casual = scorePunchForSide('left', history, { left: 200 }, 'casual')
  const intense = scorePunchForSide('left', history, { left: 200 }, 'intense')

  assert.equal(form.debug.cooldownRemaining, 180)
  assert.equal(form.debug.recovered, true)
  assert.equal(form.debug.bestType, 'jab')
  assert.equal(form.detection, null)
  assertDetection(casual, 'jab', 'left')
  assertDetection(intense, 'jab', 'left')
})

test('default and unknown speeds use casual behavior', () => {
  const history = recoveredHistory(450)
  const expected = scorePunchForSide('left', history, { left: 200 }, 'casual')

  assert.deepEqual(scorePunchForSide('left', history, { left: 200 }), expected)
  assert.deepEqual(
    scorePunchForSide('left', history, { left: 200 }, 'unknown-speed'),
    expected,
  )
  assert.deepEqual(
    classifyPunch(history, { left: 200 }, 'unknown-speed'),
    classifyPunch(history, { left: 200 }, 'casual'),
  )
})

test('cooldowns are independent for each side and nullish entries mean no prior punch', () => {
  const history = straightHistory()

  for (const lastPunchBySide of [{}, { left: 0 }, { left: null }, { right: 199 }]) {
    assertDetection(
      scorePunchForSide('left', history, lastPunchBySide),
      'jab',
      'left',
    )
  }
})

test('a continuing extension cannot be counted twice without observable recoil', () => {
  const history = worldHistory(
    'left',
    [
      WORLD_GUARD,
      WORLD_GUARD,
      worldStraight(0.6),
      worldStraight(0.65),
      worldStraight(0.7),
      worldStraight(0.9),
    ],
    [100, 150, 200, 300, 400, 501],
  )
  const result = scorePunchForSide('left', history, { left: 200 })

  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.cues.straight3D, true)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('observable 3D recoil permits another punch after cooldown', () => {
  const history = worldHistory(
    'left',
    [
      WORLD_GUARD,
      WORLD_GUARD,
      worldStraight(0.6),
      WORLD_GUARD,
      worldStraight(0.7),
      worldStraight(0.9),
    ],
    [100, 150, 200, 300, 400, 501],
  )
  const result = scorePunchForSide('left', history, { left: 200 })

  assert.equal(result.debug.recovered, true)
  assertDetection(result, 'jab', 'left')
})

test('recovery defaults to true when the prior punch is outside retained history', () => {
  const history = historyFor('left', [GUARD, GUARD, STRAIGHT], [
    1000, 1050, 1100,
  ])
  const result = scorePunchForSide('left', history, { left: 100 })

  assert.equal(result.debug.recovered, true)
  assertDetection(result, 'jab', 'left')
})

test('classification is invariant under image translation and ordinary uniform scaling', () => {
  for (const history of [straightHistory(), hookHistory(), upperHistory()]) {
    const expected = classifyPunch(history, {})

    for (const scale of [0.5, 2]) {
      const transformed = history.map((frame) => ({
        ...frame,
        keypoints: frame.keypoints.map((entry) => ({
          ...entry,
          x: entry.x * scale + 300,
          y: entry.y * scale - 200,
        })),
      }))

      assert.deepEqual(classifyPunch(transformed, {}), expected)
    }
  }
})

test('classifyPunch returns null with both valid debug entries when neither side punches', () => {
  const result = classifyPunch([makeFrame(100), makeFrame(150), makeFrame(200)], {})

  assert.equal(result.punch, null)
  assert.deepEqual(result.debug.map((entry) => entry.side), ['left', 'right'])
})

test('classifyPunch filters invalid debug entries and retains the valid side', () => {
  const history = straightHistory('right')
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (entry) => entry.name !== 'left_wrist',
  )

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' })
  assert.deepEqual(result.debug.map((entry) => entry.side), ['right'])
})

test('classifyPunch returns no debug entries when both current arms are invalid', () => {
  const history = straightHistory()
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (entry) => !entry.name.endsWith('_wrist'),
  )

  assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] })
})

test('classifyPunch selects the highest-scoring eligible side', () => {
  const history = [
    makeFrame(100, GUARD, hookPose(10)),
    makeFrame(150, GUARD, hookPose(30)),
    makeFrame(200, STRAIGHT, hookPose(70)),
  ]

  const left = scorePunchForSide('left', history, {})
  const right = scorePunchForSide('right', history, {})
  assertDetection(left, 'jab', 'left')
  assertDetection(right, 'hook', 'right')
  assert.ok(right.detection.score > left.detection.score)

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, right.detection)
  assert.deepEqual(result.debug, [left.debug, right.debug])
})

test('classifyPunch resolves equal scores in favor of the left candidate', () => {
  const history = [
    makeFrame(100),
    makeFrame(150),
    makeFrame(200, STRAIGHT, STRAIGHT),
  ]

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.equal(result.debug[0].bestScore, result.debug[1].bestScore)
})

test('classifyPunch excludes a higher-scoring side that is on cooldown', () => {
  const history = [
    makeFrame(100, GUARD, hookPose(10)),
    makeFrame(150, GUARD, hookPose(30)),
    makeFrame(200, STRAIGHT, hookPose(70)),
  ]
  const result = classifyPunch(history, { right: 175 })

  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.equal(result.debug[1].bestType, 'hook')
  assert.ok(result.debug[1].bestScore > result.punch.score)
  assert.ok(result.debug[1].cooldownRemaining > 0)
})

test('scoring and classification do not mutate history or last-punch state', () => {
  const history = recoveredHistory().map((frame) =>
    withWorld(frame, 'left', WORLD_GUARD),
  )
  const lastPunchBySide = { left: 200, right: 150 }
  const historyBefore = structuredClone(history)
  const stateBefore = structuredClone(lastPunchBySide)

  scorePunchForSide('left', history, lastPunchBySide)
  scorePunchForSide('right', history, lastPunchBySide, 'intense')
  classifyPunch(history, lastPunchBySide, 'form')

  assert.deepEqual(history, historyBefore)
  assert.deepEqual(lastPunchBySide, stateBefore)
})
