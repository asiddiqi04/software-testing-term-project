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

const GUARD = { elbow: [0, 50], wrist: [30, 0] }
const STRAIGHT = { elbow: [60, 0], wrist: [120, 0] }
const OUTWARD_STRAIGHT = { elbow: [-60, 0], wrist: [-120, 0] }
const DOWNWARD_STRAIGHT = { elbow: [0, 60], wrist: [0, 120] }

const WORLD_BENT = {
  shoulder: [0, 0, 0],
  elbow: [0.5, 0, 0],
  wrist: [0.5, 0, 0.5],
}

const WORLD_STRAIGHT = {
  shoulder: [0, 0, 0],
  elbow: [0, 0, 0.5],
  wrist: [0, 0, 1],
}

function approximately(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

// Arm coordinates are relative to the anatomical shoulder.
// Mirror right-side coordinates to exercise both anatomical hand labels.
function frame(time, left = GUARD, right = GUARD) {
  const keypoints = [{ name: 'nose', x: 50, y: -70, score: 1 }]

  for (const [side, pose] of [
    ['left', left],
    ['right', right],
  ]) {
    const originX = side === 'left' ? 0 : 100
    const direction = side === 'left' ? 1 : -1
    const joints = {
      shoulder: [0, 0],
      hip: [0, 150],
      elbow: pose.elbow,
      wrist: pose.wrist,
    }

    for (const [joint, [x, y]] of Object.entries(joints)) {
      keypoints.push({
        name: `${side}_${joint}`,
        x: originX + direction * x,
        y,
        score: 1,
      })
    }
  }

  return { time, keypoints }
}

function pointIn(frameValue, name) {
  return frameValue.keypoints.find((point) => point.name === name)
}

function withWorld(frameValue, side, pose) {
  frameValue.keypoints3D ??= []
  for (const [joint, [x, y, z]] of Object.entries(pose)) {
    frameValue.keypoints3D.push({
      name: `${side}_${joint}`,
      x,
      y,
      z,
      score: 1,
    })
  }
  return frameValue
}

function straightHistory(side = 'left', times = [1000, 1050, 1100]) {
  return times.map((time, index) => {
    const pose = index === times.length - 1 ? STRAIGHT : GUARD
    return side === 'left'
      ? frame(time, pose, GUARD)
      : frame(time, GUARD, pose)
  })
}

function worldStraightHistory(side = 'left') {
  return [1000, 1050, 1100].map((time, index) =>
    withWorld(
      frame(time),
      side,
      index === 2 ? WORLD_STRAIGHT : WORLD_BENT,
    ),
  )
}

function hookHistory(side = 'left') {
  return [10, 20, 60].map((x, index) => {
    const pose = { elbow: [0, -50], wrist: [x, -50] }
    return side === 'left'
      ? frame(1000 + index * 50, pose)
      : frame(1000 + index * 50, GUARD, pose)
  })
}

function lowUppercutHistory(side = 'left') {
  return [60, 50, 30, 0, -30].map((y, index) => {
    const pose = { elbow: [50, 20], wrist: [50, y] }
    return side === 'left'
      ? frame(1000 + index * 50, pose)
      : frame(1000 + index * 50, GUARD, pose)
  })
}

function guardUppercutHistory(times = [1000, 1050, 1100]) {
  return [-10, -25, -50].map((y, index) =>
    frame(times[index], { elbow: [50, 0], wrist: [50, y] }),
  )
}

function assertDetection(result, type, side, threshold) {
  assert.ok(result.detection, `Expected a ${side} ${type}`)
  assert.deepEqual(Object.keys(result.detection).sort(), [
    'score',
    'side',
    'type',
  ])
  assert.equal(result.detection.type, type)
  assert.equal(result.detection.side, side)
  assert.ok(Number.isInteger(result.detection.score))
  assert.ok(result.detection.score >= threshold)
  assert.equal(result.debug.bestType, type)
  assert.equal(result.debug.bestScore, result.detection.score)
  assert.equal(result.debug.threshold, threshold)
}

test('punchTypes lists the supported types in order', () => {
  assert.deepEqual(punchTypes, ['jab', 'cross', 'hook', 'uppercut'])
})

test('initialPunchCounts returns independent objects with zero counts', () => {
  const first = initialPunchCounts()
  const second = initialPunchCounts()

  assert.deepEqual(first, { jab: 0, cross: 0, hook: 0, uppercut: 0 })
  assert.deepEqual(second, first)
  assert.notStrictEqual(first, second)

  first.jab = 4
  first.hook = 2
  assert.deepEqual(second, { jab: 0, cross: 0, hook: 0, uppercut: 0 })
  assert.deepEqual(initialPunchCounts(), second)
})

test('getPoint handles absent collections, empty arrays, and missing names', () => {
  assert.equal(getPoint(undefined, 'nose'), undefined)
  assert.equal(getPoint(null, 'nose'), undefined)
  assert.equal(getPoint([], 'nose'), undefined)
  assert.equal(getPoint([{ name: 'left_wrist', score: 1 }], 'nose'), undefined)
})

test('getPoint returns the first matching point meeting the inclusive threshold', () => {
  const points = [
    { name: 'nose', score: 0.49 },
    { name: 'left_wrist', score: 1 },
    { name: 'nose', score: 0.5 },
    { name: 'nose', score: 0.9 },
  ]

  assert.strictEqual(getPoint(points, 'nose'), points[2])
  assert.strictEqual(getPoint(points, 'nose', 0.9), points[3])
  assert.equal(getPoint(points, 'nose', 0.91), undefined)
  assert.strictEqual(getPoint(points, 'nose', 0.49), points[0])
})

test('getPoint defaults missing and null scores to one, preserving zero scores', () => {
  for (const point of [{ name: 'nose' }, { name: 'nose', score: null }]) {
    assert.strictEqual(getPoint([point], 'nose', 1), point)
    assert.equal(getPoint([point], 'nose', 1.01), undefined)
  }

  const zero = { name: 'nose', score: 0 }
  assert.equal(getPoint([zero], 'nose'), undefined)
  assert.strictEqual(getPoint([zero], 'nose', 0), zero)
  assert.equal(getPoint([{ name: 'nose', score: NaN }], 'nose'), undefined)
})

test('dist2d computes symmetric Euclidean distance and ignores z', () => {
  const a = { x: -2, y: -3, z: 100 }
  const b = { x: 1, y: 1, z: -100 }

  assert.equal(dist2d(a, b), 5)
  assert.equal(dist2d(b, a), 5)
  assert.equal(dist2d(a, a), 0)
  assert.equal(dist2d(a, { ...a, z: 0 }), 0)
  approximately(dist2d({ x: 0, y: 0 }, { x: 1, y: 1 }), Math.SQRT2)
})

test('angleDeg measures the angle at the middle point', () => {
  const origin = { x: 0, y: 0 }

  approximately(angleDeg({ x: 1, y: 0 }, origin, { x: 0, y: 1 }), 90)
  approximately(angleDeg({ x: -1, y: 0 }, origin, { x: 1, y: 0 }), 180)
  approximately(angleDeg({ x: 1, y: 0 }, origin, { x: 2, y: 0 }), 0)
  approximately(
    angleDeg({ x: 1, y: 0 }, origin, { x: 0.5, y: Math.sqrt(3) / 2 }),
    60,
  )
})

test('angleDeg returns zero when either segment at the vertex has zero length', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 1, y: 1 }

  assert.equal(angleDeg(a, a, b), 0)
  assert.equal(angleDeg(a, b, b), 0)
  assert.equal(angleDeg(a, a, a), 0)
})

test('angleDeg uses the supplied distance function for all three pairs', () => {
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

  approximately(angleDeg(a, b, c, distance), 90)
  assert.deepEqual(calls, [[a, b], [b, c], [a, c]])
})

test('angleDeg clamps cosine values outside the acos domain', () => {
  for (const [lengths, expected] of [
    [[1, 1, 3], 180],
    [[1, 2, 0], 0],
  ]) {
    let index = 0
    assert.equal(angleDeg({}, {}, {}, () => lengths[index++]), expected)
    assert.equal(index, 3)
  }
})

test('histories shorter than three frames have no detection or debug information', () => {
  for (const history of [[], [frame(1000)], [frame(1000), frame(1050)]]) {
    for (const side of ['left', 'right']) {
      assert.deepEqual(scorePunchForSide(side, history, {}), {
        detection: null,
        debug: null,
      })
    }
    assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] })
  }
})

test('each required current point must be present and sufficiently confident', () => {
  for (const name of [
    'left_wrist',
    'left_elbow',
    'left_shoulder',
    'left_hip',
    'right_shoulder',
    'nose',
  ]) {
    const missing = straightHistory()
    missing.at(-1).keypoints = missing.at(-1).keypoints.filter(
      (point) => point.name !== name,
    )
    assert.deepEqual(scorePunchForSide('left', missing, {}), {
      detection: null,
      debug: null,
    }, `Missing ${name}`)

    const lowConfidence = straightHistory()
    pointIn(lowConfidence.at(-1), name).score = name === 'nose' ? 0.299 : 0.499
    assert.deepEqual(scorePunchForSide('left', lowConfidence, {}), {
      detection: null,
      debug: null,
    }, `Low-confidence ${name}`)
  }
})

test('current point confidence thresholds are inclusive and missing scores are accepted', () => {
  const boundary = straightHistory()
  for (const point of boundary.at(-1).keypoints) {
    point.score = point.name === 'nose' ? 0.3 : 0.5
  }
  assertDetection(scorePunchForSide('left', boundary, {}), 'jab', 'left', 68)

  const implicit = straightHistory()
  for (const item of implicit) {
    for (const point of item.keypoints) delete point.score
  }
  assertDetection(scorePunchForSide('left', implicit, {}), 'jab', 'left', 68)
})

test('a missing current keypoint collection produces no result', () => {
  const history = straightHistory()
  delete history.at(-1).keypoints

  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
  test(`${side} image-space extension is classified as ${type}`, () => {
    const result = scorePunchForSide(side, straightHistory(side), {})

    assertDetection(result, type, side, 68)
    assert.equal(result.detection.score, 100)
    assert.equal(result.debug.straightType, type)
    assert.equal(result.debug.cues.straight2D, true)
    assert.equal(result.debug.cues.straight3D, false)
    assert.equal(result.debug.elbowAngle, 180)
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.forearmAngleToHorizontal, 0)
    assert.equal(result.debug.cooldownRemaining, 0)
    assert.equal(result.debug.recovered, true)
    assert.deepEqual(Object.keys(result.debug.scoreByType).sort(), [
      type, 'hook', 'uppercut',
    ].sort())
  })

  test(`${side} lateral bent-arm motion is classified as a hook`, () => {
    const result = scorePunchForSide(side, hookHistory(side), {})

    assertDetection(result, 'hook', side, 62)
    assert.equal(result.debug.cues.lateralDominant, true)
    assert.equal(result.debug.cues.verticalDominant, false)
    assert.equal(result.debug.cues.armParallelFloor, true)
    assert.equal(result.debug.cues.openingIntoStraight, false)
    assert.equal(result.debug.elbowAngle, 90)
  })

  test(`${side} rising bent-arm motion from low preparation is an uppercut`, () => {
    const result = scorePunchForSide(side, lowUppercutHistory(side), {})

    assertDetection(result, 'uppercut', side, 64)
    assert.equal(result.debug.cues.lowPrep, true)
    assert.equal(result.debug.cues.uppercutFromLow, true)
    assert.equal(result.debug.cues.verticalDominant, true)
    assert.equal(result.debug.cues.armPerpendicularFloor, true)
  })

  test(`${side} world-space extension can identify ${type} without image extension`, () => {
    const result = scorePunchForSide(side, worldStraightHistory(side), {})

    assertDetection(result, type, side, 68)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.straight3D, true)
    assert.equal(result.debug.elbowAngle3D, 180)
  })
}

test('stationary guard and stationary extended arms do not count as punches', () => {
  for (const pose of [GUARD, STRAIGHT]) {
    const history = [1000, 1050, 1100].map((time) => frame(time, pose, pose))
    const result = classifyPunch(history, {})

    assert.equal(result.punch, null)
    assert.equal(result.debug.length, 2)
    for (const debug of result.debug) {
      assert.equal(debug.bestType, null)
      assert.equal(debug.bestScore, 0)
      assert.equal(debug.threshold, null)
      assert.equal(debug.cues.straight2D, false)
      assert.equal(debug.cues.straight3D, false)
    }
  }
})

test('a compact uppercut from guard requires confirmation time for the selected speed', () => {
  const history = guardUppercutHistory()

  for (const speed of ['casual', 'intense']) {
    const result = scorePunchForSide('left', history, {}, speed)
    assertDetection(result, 'uppercut', 'left', 64)
    assert.equal(result.debug.cues.uppercutFromGuard, true)
    assert.equal(result.debug.cues.uppercutFromLow, false)
  }

  const tooSoon = scorePunchForSide('left', history, {}, 'form')
  assert.equal(tooSoon.detection, null)
  assert.equal(tooSoon.debug.cues.uppercutFromGuard, false)

  const confirmed = scorePunchForSide(
    'left',
    guardUppercutHistory([1000, 1070, 1140]),
    {},
    'form',
  )
  assertDetection(confirmed, 'uppercut', 'left', 64)
  assert.equal(confirmed.debug.cues.uppercutFromGuard, true)
})

test('guard uppercut confirmation needs three contiguous motion frames', () => {
  const result = scorePunchForSide(
    'left',
    guardUppercutHistory([500, 1050, 1100]),
    {},
  )

  assert.equal(result.detection, null)
  assert.equal(result.debug.cues.uppercutFromGuard, false)
})

test('whole-body upward translation does not establish an uppercut trajectory', () => {
  const pose = { elbow: [50, 0], wrist: [50, -10] }
  const history = [0, -30, -60].map((offset, index) => {
    const item = frame(1000 + index * 50, pose)
    for (const point of item.keypoints) point.y += offset
    return item
  })

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.verticalDominant, true)
  assert.equal(result.debug.cues.uppercutFromLow, false)
  assert.equal(result.debug.cues.uppercutFromGuard, false)
  assert.equal(result.detection, null)
})

test('straight-punch recoil is not classified as a curved punch', () => {
  const history = [
    frame(1000, GUARD),
    frame(1050, STRAIGHT),
    frame(1100, { elbow: [0, -50], wrist: [60, -50] }),
  ]
  const result = scorePunchForSide('left', history, {})

  assert.equal(result.debug.cues.returningFromStraight, true)
  assert.equal(result.detection, null)
})

test('lowering a guard into a hanging arm does not establish a 2D straight', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, DOWNWARD_STRAIGHT),
  ]
  const result = scorePunchForSide('left', history, {})

  assert.equal(result.debug.cues.elbowMostlyStraight, true)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('reliable world extension can identify a downward-directed straight', () => {
  const history = [
    withWorld(frame(1000), 'left', WORLD_BENT),
    withWorld(frame(1050), 'left', WORLD_BENT),
    withWorld(frame(1100, DOWNWARD_STRAIGHT), 'left', WORLD_STRAIGHT),
  ]
  const result = scorePunchForSide('left', history, {})

  assertDetection(result, 'jab', 'left', 68)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.cues.straight3D, true)
})

test('a bent world-space arm across the torso vetoes a straight-looking projection', () => {
  const history = straightHistory().map((item) =>
    withWorld(item, 'left', WORLD_BENT),
  )
  const result = scorePunchForSide('left', history, {})

  assert.equal(result.debug.elbowAngle, 180)
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.cues.straight3D, false)
  assert.equal(result.detection, null)
})

test('bent world geometry does not generally veto strong outward 2D extension', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, OUTWARD_STRAIGHT),
  ].map((item) => withWorld(item, 'left', WORLD_BENT))

  const result = scorePunchForSide('left', history, {})
  assertDetection(result, 'jab', 'left', 68)
  assert.equal(result.debug.cues.straight2D, true)
  assert.equal(result.debug.cues.straight3D, false)
})

test('invalid world geometry falls back to usable image geometry', () => {
  const invalidators = [
    (item) => { delete item.keypoints3D },
    (item) => { item.keypoints3D.pop() },
    (item) => { item.keypoints3D[0].score = 0.49 },
    (item) => { delete item.keypoints3D[1].z },
    (item) => { item.keypoints3D[1].x = NaN },
    (item) => { item.keypoints3D[1].y = Infinity },
    (item) => { item.keypoints3D[1].z = '0' },
    (item) => {
      for (const point of item.keypoints3D) {
        point.x = 0
        point.y = 0
        point.z = 0
      }
    },
    (item) => {
      for (const point of item.keypoints3D) {
        point.x *= 0.01
        point.y *= 0.01
        point.z *= 0.01
      }
    },
  ]

  for (const invalidate of invalidators) {
    const history = straightHistory().map((item) =>
      withWorld(item, 'left', WORLD_STRAIGHT),
    )
    for (const item of history) invalidate(item)

    const result = scorePunchForSide('left', history, {})
    assertDetection(result, 'jab', 'left', 68)
    assert.equal(result.debug.cues.straight2D, true)
    assert.equal(result.debug.cues.straight3D, false)
    assert.equal(result.debug.elbowAngle3D, null)
  }
})

test('world geometry still requires valid current image landmarks', () => {
  const history = worldStraightHistory()
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (point) => point.name !== 'left_hip',
  )

  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

test('motion accepts a 250 ms gap but rejects larger, zero, and negative gaps', () => {
  const accepted = scorePunchForSide(
    'left',
    straightHistory('left', [1000, 1050, 1300]),
    {},
  )
  assertDetection(accepted, 'jab', 'left', 68)

  for (const time of [1301, 1050, 1049]) {
    const result = scorePunchForSide(
      'left',
      straightHistory('left', [1000, 1050, time]),
      {},
    )
    assert.equal(result.detection, null)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.lateralDominant, false)
    assert.equal(result.debug.cues.verticalDominant, false)
  }
})

test('the casual motion window includes exactly 350 ms and excludes older evidence', () => {
  const makeHistory = (time) => [
    frame(1000, GUARD),
    frame(1200, STRAIGHT),
    frame(time, STRAIGHT),
  ]

  assertDetection(
    scorePunchForSide('left', makeHistory(1350), {}, 'casual'),
    'jab',
    'left',
    68,
  )

  const expired = scorePunchForSide('left', makeHistory(1351), {}, 'casual')
  assert.equal(expired.detection, null)
  assert.equal(expired.debug.cues.straight2D, false)
})

test('speed profiles select different motion windows', () => {
  const history = [
    frame(1000, GUARD),
    frame(1200, STRAIGHT),
    frame(1250, STRAIGHT),
  ]

  for (const speed of ['form', 'casual']) {
    assertDetection(
      scorePunchForSide('left', history, {}, speed),
      'jab',
      'left',
      68,
    )
  }

  const result = scorePunchForSide('left', history, {}, 'intense')
  assert.equal(result.detection, null)
  assert.equal(result.debug.cues.straight2D, false)
})

test('a frame at the previous punch time cannot supply new extension evidence', () => {
  const history = [
    frame(1000, GUARD),
    frame(1200, STRAIGHT),
    frame(1350, STRAIGHT),
  ]
  const result = scorePunchForSide('left', history, { left: 1000 })

  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('cooldown suppresses an eligible recovered punch while preserving debug scores', () => {
  const history = [
    frame(1100, STRAIGHT),
    frame(1150, GUARD),
    frame(1200, GUARD),
    frame(1250, STRAIGHT),
  ]
  const result = scorePunchForSide('left', history, { left: 1100 })

  assert.equal(result.detection, null)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.bestScore, 100)
  assert.equal(result.debug.threshold, 68)
  assert.equal(result.debug.cooldownRemaining, 150)
  assert.equal(result.debug.recovered, true)
})

test('cooldown expires at the exact profile boundary after observable recovery', () => {
  for (const [speed, cooldown] of [
    ['form', 480],
    ['casual', 300],
    ['intense', 160],
  ]) {
    const lastTime = 1000
    const now = lastTime + cooldown

    const makeHistory = (currentTime) => [
      frame(lastTime, STRAIGHT),
      frame(now - 100, GUARD),
      frame(now - 50, GUARD),
      frame(currentTime, STRAIGHT),
    ]

    const blocked = scorePunchForSide(
      'left', makeHistory(now - 1), { left: lastTime }, speed,
    )
    assert.equal(blocked.detection, null)
    assert.equal(blocked.debug.cooldownRemaining, 1)
    assert.equal(blocked.debug.recovered, true)

    const ready = scorePunchForSide(
      'left', makeHistory(now), { left: lastTime }, speed,
    )
    assertDetection(ready, 'jab', 'left', 68)
    assert.equal(ready.debug.cooldownRemaining, 0)
    assert.equal(ready.debug.recovered, true)
  }
})

test('continuing an extension without sufficient recovery cannot count twice', () => {
  const worldAtReach = (reach) => ({
    shoulder: [0, 0, 0],
    elbow: [0, 0, reach / 2],
    wrist: [0, 0, reach],
  })
  const history = [
    withWorld(frame(1000), 'left', worldAtReach(1)),
    withWorld(frame(1100), 'left', worldAtReach(0.95)),
    withWorld(frame(1300), 'left', worldAtReach(1.2)),
  ]
  const result = scorePunchForSide('left', history, { left: 1000 })

  assert.equal(result.debug.cues.straight3D, true)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.bestScore, 100)
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('world-space recoil can establish recovery while image geometry stays fixed', () => {
  const history = [
    withWorld(frame(1000), 'left', WORLD_STRAIGHT),
    withWorld(frame(1100), 'left', WORLD_BENT),
    withWorld(frame(1300), 'left', WORLD_STRAIGHT),
  ]
  const result = scorePunchForSide('left', history, { left: 1000 })

  assertDetection(result, 'jab', 'left', 68)
  assert.equal(result.debug.recovered, true)
  assert.equal(result.debug.cues.straight3D, true)
})

test('missing previous punch frames do not permanently block recovery', () => {
  const result = scorePunchForSide(
    'left',
    straightHistory(),
    { left: 500 },
  )

  assertDetection(result, 'jab', 'left', 68)
  assert.equal(result.debug.recovered, true)
})

test('cooldown is tracked independently for each side', () => {
  const result = scorePunchForSide(
    'left',
    straightHistory(),
    { right: 1099 },
  )

  assertDetection(result, 'jab', 'left', 68)
  assert.equal(result.debug.cooldownRemaining, 0)
})

test('omitted and unknown speeds use casual behavior', () => {
  const history = guardUppercutHistory()
  const expected = scorePunchForSide('left', history, {}, 'casual')

  assert.deepEqual(scorePunchForSide('left', history, {}), expected)
  assert.deepEqual(scorePunchForSide('left', history, {}, undefined), expected)
  assert.deepEqual(scorePunchForSide('left', history, {}, 'unknown-speed'), expected)

  assert.deepEqual(
    classifyPunch(history, {}, 'unknown-speed'),
    classifyPunch(history, {}, 'casual'),
  )
})

test('translation and uniform image scaling preserve straight classification', () => {
  const original = straightHistory()
  const transformed = structuredClone(original)

  for (const item of transformed) {
    for (const point of item.keypoints) {
      point.x = point.x * 2 + 300
      point.y = point.y * 2 - 200
    }
  }

  assert.deepEqual(
    scorePunchForSide('left', transformed, {}),
    scorePunchForSide('left', original, {}),
  )
})

test('coincident shoulders use the width floor without nonfinite debug scores', () => {
  const history = [1000, 1050, 1100].map((time) => frame(time))
  for (const item of history) {
    const left = pointIn(item, 'left_shoulder')
    const right = pointIn(item, 'right_shoulder')
    right.x = left.x
    right.y = left.y
  }

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.detection, null)
  assert.ok(result.debug)
  assert.ok(Number.isFinite(result.debug.elbowAngle))
  for (const score of Object.values(result.debug.scoreByType)) {
    assert.ok(Number.isFinite(score))
  }
})

test('classifyPunch returns a single detecting side and debug entries in anatomical order', () => {
  for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
    const history = straightHistory(side)
    const expected = scorePunchForSide(side, history, {}).detection
    const result = classifyPunch(history, {})

    assert.deepEqual(result.punch, expected)
    assert.equal(result.punch.type, type)
    assert.deepEqual(result.debug.map((debug) => debug.side), ['left', 'right'])
  }
})

test('classifyPunch resolves equal scores in favor of the left-side candidate', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, STRAIGHT, STRAIGHT),
  ]
  const result = classifyPunch(history, {})

  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.equal(result.debug[0].bestScore, 100)
  assert.equal(result.debug[1].bestScore, 100)
})

test('classifyPunch selects the higher score even when it belongs to the right side', () => {
  const history = [10, 20, 60].map((x, index) =>
    frame(
      1000 + index * 50,
      index === 2 ? STRAIGHT : GUARD,
      { elbow: [0, -50], wrist: [x, -50] },
    ),
  )
  const left = scorePunchForSide('left', history, {})
  const right = scorePunchForSide('right', history, {})

  assertDetection(left, 'jab', 'left', 68)
  assertDetection(right, 'hook', 'right', 62)
  assert.ok(right.detection.score > left.detection.score)
  assert.deepEqual(classifyPunch(history, {}).punch, right.detection)
})

test('classifyPunch excludes a side on cooldown from candidate selection', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, STRAIGHT, STRAIGHT),
  ]
  const result = classifyPunch(history, { left: 900 })

  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' })
  assert.equal(result.debug[0].cooldownRemaining, 100)
  assert.equal(result.debug[1].cooldownRemaining, 0)
})

test('classifyPunch filters null debug entries without discarding the valid side', () => {
  const history = straightHistory('right')
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (point) => point.name !== 'left_hip',
  )

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' })
  assert.deepEqual(result.debug.map((debug) => debug.side), ['right'])
})

test('classification does not mutate frames, world points, or punch timestamps', () => {
  const history = worldStraightHistory()
  const lastPunchBySide = { left: 500, right: 600 }
  const originalHistory = structuredClone(history)
  const originalTimes = structuredClone(lastPunchBySide)

  function deepFreeze(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) deepFreeze(child)
      Object.freeze(value)
    }
    return value
  }

  deepFreeze(history)
  deepFreeze(lastPunchBySide)

  assertDetection(
    scorePunchForSide('left', history, lastPunchBySide),
    'jab',
    'left',
    68,
  )
  assert.equal(classifyPunch(history, lastPunchBySide).punch.type, 'jab')
  assert.deepEqual(history, originalHistory)
  assert.deepEqual(lastPunchBySide, originalTimes)
})
