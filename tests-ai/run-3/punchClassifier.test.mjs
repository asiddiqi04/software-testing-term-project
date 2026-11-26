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

const GUARD = { elbow: [-0.4, 0.4], wrist: [0, -0.2] }
const STRAIGHT = { elbow: [-0.75, 0], wrist: [-1.5, 0] }
const HOOK_START = { elbow: [0, 0.2], wrist: [0.2, 0.2] }
const HOOK_MIDDLE = { elbow: [0, 0.2], wrist: [0.4, 0.2] }
const HOOK_END = { elbow: [0, 0.2], wrist: [0.8, 0.2] }

const WORLD_FOLDED = {
  shoulder: [0, 0, 0],
  elbow: [0, 0, 0.5],
  wrist: [0.1, 0, 0.1],
}
const WORLD_STRAIGHT = {
  shoulder: [0, 0, 0],
  elbow: [0, 0, 0.5],
  wrist: [0, 0, 1],
}
const WORLD_BENT = {
  shoulder: [0, 0, 0],
  elbow: [0.5, 0, 0],
  wrist: [0.5, 0.5, 0],
}

function frame(time, poses = {}, worlds = {}) {
  const keypoints = [{ name: 'nose', x: 50, y: -50, score: 1 }]
  const keypoints3D = []

  for (const side of ['left', 'right']) {
    const originX = side === 'left' ? 0 : 100
    const direction = side === 'left' ? 1 : -1
    const pose = poses[side] ?? GUARD

    for (const [joint, [x, y]] of Object.entries({
      shoulder: [0, 0],
      hip: [0, 2],
      elbow: pose.elbow,
      wrist: pose.wrist,
    })) {
      keypoints.push({
        name: `${side}_${joint}`,
        x: originX + direction * x * 100,
        y: y * 100,
        score: 1,
      })
    }

    if (worlds[side]) {
      for (const [joint, [x, y, z]] of Object.entries(worlds[side])) {
        keypoints3D.push({
          name: `${side}_${joint}`,
          x: direction * x,
          y,
          z,
          score: 1,
        })
      }
    }
  }

  return { time, keypoints, keypoints3D }
}

function poseHistory(side, poses, times = poses.map((_, i) => 1000 + i * 50)) {
  return poses.map((pose, i) => frame(times[i], { [side]: pose }))
}

function straightHistory(side = 'left', times) {
  return poseHistory(side, [GUARD, GUARD, STRAIGHT], times)
}

function hookHistory(side = 'left') {
  return poseHistory(side, [HOOK_START, HOOK_MIDDLE, HOOK_END])
}

function uppercutHistory(side = 'left') {
  return poseHistory(
    side,
    [0.6, 0.5, 0.4, 0.2, -0.6].map((y) => ({
      elbow: [0.5, 0],
      wrist: [0.5, y],
    })),
  )
}

function guardUppercutHistory(side = 'left', duration = 100) {
  return poseHistory(
    side,
    [
      { elbow: [1.5, 0.1], wrist: [1.5, -0.3] },
      { elbow: [1.5, -0.05], wrist: [1.5, -0.45] },
      { elbow: [1.5, -0.2], wrist: [1.5, -0.6] },
    ],
    [1000, 1000 + duration / 2, 1000 + duration],
  )
}

function worldStraightHistory(side = 'left') {
  return [
    frame(1000, {}, { [side]: WORLD_FOLDED }),
    frame(1050, {}, { [side]: WORLD_FOLDED }),
    frame(1100, {}, { [side]: WORLD_STRAIGHT }),
  ]
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function expectDetection(result, type, side, score) {
  assert.ok(result.detection, `Expected a ${side} ${type}`)
  assert.equal(result.detection.type, type)
  assert.equal(result.detection.side, side)
  assert.ok(Number.isInteger(result.detection.score))
  assert.equal(result.debug.bestType, type)
  assert.equal(result.debug.bestScore, result.detection.score)
  assert.equal(result.debug.scoreByType[type], result.detection.score)
  assert.ok(result.detection.score >= result.debug.threshold)

  if (score !== undefined) {
    assert.equal(result.detection.score, score)
  }
}

test('punchTypes lists all supported punch types in order', () => {
  assert.deepEqual(punchTypes, ['jab', 'cross', 'hook', 'uppercut'])
})

test('initialPunchCounts returns independent objects with zero counts', () => {
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

test('getPoint handles absent collections and missing names', () => {
  assert.equal(getPoint(undefined, 'nose'), undefined)
  assert.equal(getPoint(null, 'nose'), undefined)
  assert.equal(getPoint([], 'nose'), undefined)
  assert.equal(getPoint([{ name: 'left_wrist' }], 'nose'), undefined)
  assert.equal(getPoint([{ name: 'Nose' }], 'nose'), undefined)
})

test('getPoint returns the first matching point meeting the confidence cutoff', () => {
  const points = [
    { name: 'nose', score: 0.49 },
    { name: 'left_wrist', score: 1 },
    { name: 'nose', score: 0.5 },
    { name: 'nose', score: 0.9 },
  ]

  assert.strictEqual(getPoint(points, 'nose'), points[2])
  assert.strictEqual(getPoint(points, 'nose', 0.8), points[3])
  assert.strictEqual(getPoint(points, 'nose', 0), points[0])
  assert.equal(getPoint(points, 'nose', 1), undefined)
})

test('getPoint defaults missing or null scores to one but preserves zero', () => {
  const missing = { name: 'nose' }
  const nullScore = { name: 'nose', score: null }
  const zero = { name: 'nose', score: 0 }

  assert.strictEqual(getPoint([missing], 'nose', 1), missing)
  assert.strictEqual(getPoint([nullScore], 'nose', 1), nullScore)
  assert.equal(getPoint([missing], 'nose', 1.01), undefined)
  assert.equal(getPoint([zero], 'nose'), undefined)
  assert.strictEqual(getPoint([zero], 'nose', 0), zero)
  assert.equal(getPoint([{ name: 'nose', score: NaN }], 'nose'), undefined)
})

test('dist2d computes symmetric Euclidean distance and ignores z', () => {
  const a = { x: -1, y: -2, z: -100 }
  const b = { x: 2, y: 2, z: 100 }

  assert.equal(dist2d(a, b), 5)
  assert.equal(dist2d(b, a), 5)
  assert.equal(dist2d(a, a), 0)
  closeTo(dist2d({ x: 0, y: 0 }, { x: 1, y: 1 }), Math.sqrt(2))
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

test('angleDeg returns zero for either zero-length adjacent segment', () => {
  const a = { x: 1, y: 2 }
  const b = { x: 4, y: 6 }

  assert.equal(angleDeg(a, a, b), 0)
  assert.equal(angleDeg(a, b, b), 0)
  assert.equal(angleDeg(a, a, a), 0)
})

test('angleDeg accepts a custom distance function', () => {
  const a = { x: 1, y: 0, z: 0 }
  const b = { x: 0, y: 0, z: 0 }
  const c = { x: 0, y: 0, z: 1 }
  const calls = []
  const distance = (p, q) => {
    calls.push([p, q])
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
  }

  closeTo(angleDeg(a, b, c, distance), 90)
  assert.deepEqual(calls, [[a, b], [b, c], [a, c]])
})

test('angleDeg clamps cosine values outside the valid acos range', () => {
  for (const [distances, expected] of [
    [[1, 2, 0], 0],
    [[1, 1, 3], 180],
  ]) {
    let index = 0
    assert.equal(angleDeg({}, {}, {}, () => distances[index++]), expected)
  }
})

test('histories shorter than three frames produce no detection or debug', () => {
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

test('each required current-frame landmark must be present', () => {
  for (const side of ['left', 'right']) {
    const opposite = side === 'left' ? 'right' : 'left'
    const required = [
      `${side}_wrist`,
      `${side}_elbow`,
      `${side}_shoulder`,
      `${side}_hip`,
      `${opposite}_shoulder`,
      'nose',
    ]

    for (const name of required) {
      const history = straightHistory(side)
      history.at(-1).keypoints = history.at(-1).keypoints.filter(
        (point) => point.name !== name,
      )
      assert.deepEqual(
        scorePunchForSide(side, history, {}),
        { detection: null, debug: null },
        `Missing ${name}`,
      )
    }
  }
})

test('current landmark confidence thresholds are inclusive', () => {
  const history = straightHistory()
  for (const point of history.at(-1).keypoints) {
    point.score = point.name === 'nose' ? 0.3 : 0.5
  }
  expectDetection(scorePunchForSide('left', history, {}), 'jab', 'left', 100)

  for (const name of [
    'left_wrist',
    'left_elbow',
    'left_shoulder',
    'left_hip',
    'right_shoulder',
    'nose',
  ]) {
    const invalid = structuredClone(history)
    const point = invalid.at(-1).keypoints.find((entry) => entry.name === name)
    point.score = name === 'nose' ? 0.299 : 0.499
    assert.deepEqual(scorePunchForSide('left', invalid, {}), {
      detection: null,
      debug: null,
    })
  }
})

test('missing current keypoints produce an empty result', () => {
  const history = straightHistory()
  delete history.at(-1).keypoints
  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

test('stationary guard and stationary extension do not count as punches', () => {
  for (const pose of [GUARD, STRAIGHT, HOOK_END]) {
    const history = poseHistory('left', [pose, pose, pose])
    const result = scorePunchForSide('left', history, {})

    assert.equal(result.detection, null)
    assert.equal(result.debug.bestType, null)
    assert.equal(result.debug.bestScore, 0)
    assert.equal(result.debug.threshold, null)
    assert.equal(result.debug.cooldownRemaining, 0)
    assert.equal(result.debug.recovered, true)
  }
})

test('straight punches use anatomical left=jab and right=cross labels', () => {
  for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
    const result = scorePunchForSide(side, straightHistory(side), {})

    expectDetection(result, type, side, 100)
    assert.equal(result.debug.side, side)
    assert.equal(result.debug.straightType, type)
    assert.equal(result.debug.threshold, 68)
    assert.equal(result.debug.elbowAngle, 180)
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.cues.straight2D, true)
    assert.equal(result.debug.cues.straight3D, false)
    assert.deepEqual(Object.keys(result.debug.scoreByType), [
      type, 'hook', 'uppercut',
    ])
  }
})

test('upward-directed straight punches remain straight punches', () => {
  const diagonal = { elbow: [-0.45, -0.6], wrist: [-0.9, -1.2] }
  const history = poseHistory('left', [GUARD, GUARD, diagonal])
  const result = scorePunchForSide('left', history, {})

  expectDetection(result, 'jab', 'left', 100)
  assert.equal(result.debug.cues.straight2D, true)
})

test('bent lateral motion detects hooks on either side', () => {
  for (const side of ['left', 'right']) {
    const result = scorePunchForSide(side, hookHistory(side), {})

    expectDetection(result, 'hook', side)
    assert.equal(result.debug.threshold, 62)
    assert.equal(result.debug.elbowAngle, 90)
    assert.equal(result.debug.cues.lateralDominant, true)
    assert.equal(result.debug.cues.armParallelFloor, true)
    assert.equal(result.debug.cues.straight2D, false)
  }
})

test('rising bent arms from below the shoulder detect uppercuts', () => {
  for (const side of ['left', 'right']) {
    const result = scorePunchForSide(side, uppercutHistory(side), {})

    expectDetection(result, 'uppercut', side)
    assert.equal(result.debug.threshold, 64)
    assert.equal(result.debug.cues.lowPrep, true)
    assert.equal(result.debug.cues.verticalDominant, true)
    assert.equal(result.debug.cues.armPerpendicularFloor, true)
    assert.equal(result.debug.cues.uppercutFromLow, true)
    assert.equal(result.debug.cues.openingIntoStraight, false)
  }
})

test('compact uppercuts from guard require the pace-specific confirmation time', () => {
  for (const [speed, confirmMs] of [
    ['form', 140],
    ['casual', 80],
    ['intense', 45],
  ]) {
    const tooSoon = scorePunchForSide(
      'left', guardUppercutHistory('left', confirmMs - 1), {}, speed,
    )
    assert.equal(tooSoon.debug.cues.uppercutFromLow, false)
    assert.equal(tooSoon.debug.cues.uppercutFromGuard, false)
    assert.equal(tooSoon.detection, null)

    const confirmed = scorePunchForSide(
      'left', guardUppercutHistory('left', confirmMs), {}, speed,
    )
    assert.equal(confirmed.debug.cues.uppercutFromGuard, true)
    expectDetection(confirmed, 'uppercut', 'left')
  }
})

test('whole-body upward translation does not supply an uppercut trajectory', () => {
  const history = [0, 30, 60].map((offset, i) => {
    const item = frame(1000 + i * 50, {
      left: { elbow: [1, 0], wrist: [1, -0.4] },
    })
    item.keypoints = item.keypoints.map((point) => ({
      ...point,
      y: point.y - offset,
    }))
    return item
  })

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.verticalDominant, true)
  assert.equal(result.debug.cues.uppercutFromLow, false)
  assert.equal(result.debug.cues.uppercutFromGuard, false)
  assert.equal(result.detection, null)
})

test('3D extension can detect a straight without 2D extension', () => {
  for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
    const result = scorePunchForSide(side, worldStraightHistory(side), {})

    expectDetection(result, type, side, 100)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.straight3D, true)
    assert.equal(result.debug.elbowAngle3D, 180)
  }
})

test('invalid 3D geometry is ignored without disabling valid 2D evidence', () => {
  const corruptions = [
    (points) => points.filter((point) => point.name !== 'left_wrist'),
    (points) => {
      points.find((point) => point.name === 'left_elbow').score = 0.49
      return points
    },
    ...['x', 'y', 'z'].flatMap((axis) =>
      [NaN, Infinity, undefined, '0'].map((value) => (points) => {
        points.find((point) => point.name === 'left_wrist')[axis] = value
        return points
      }),
    ),
    (points) => points.map((point) => ({
      ...point, x: 0, y: 0, z: 0,
    })),
    (points) => points.map((point) => ({
      ...point, x: point.x * 0.01, y: point.y * 0.01, z: point.z * 0.01,
    })),
  ]

  for (const corrupt of corruptions) {
    const worldOnly = worldStraightHistory()
    worldOnly.at(-1).keypoints3D = corrupt(worldOnly.at(-1).keypoints3D)
    const invalidResult = scorePunchForSide('left', worldOnly, {})
    assert.equal(invalidResult.debug.elbowAngle3D, null)
    assert.equal(invalidResult.debug.cues.straight3D, false)
    assert.equal(invalidResult.detection, null)

    const imageHistory = straightHistory()
    imageHistory.at(-1).keypoints3D = structuredClone(
      worldOnly.at(-1).keypoints3D,
    )
    expectDetection(
      scorePunchForSide('left', imageHistory, {}), 'jab', 'left', 100,
    )
  }
})

test('a bent 3D estimate does not veto strong outward 2D extension', () => {
  const history = straightHistory()
  for (const item of history) {
    item.keypoints3D = frame(item.time, {}, { left: WORLD_BENT }).keypoints3D
  }

  const result = scorePunchForSide('left', history, {})
  expectDetection(result, 'jab', 'left', 100)
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.straight2D, true)
  assert.equal(result.debug.cues.straight3D, false)
})

test('lowering an arm is rejected in 2D but reliable 3D extension can qualify', () => {
  const lowered = { elbow: [0, 0.75], wrist: [0, 1.5] }
  const history = poseHistory('left', [GUARD, GUARD, lowered])

  const imageOnly = scorePunchForSide('left', history, {})
  assert.equal(imageOnly.debug.cues.straight2D, false)
  assert.equal(imageOnly.detection, null)

  for (let i = 0; i < history.length; i += 1) {
    history[i].keypoints3D = frame(history[i].time, {}, {
      left: i === history.length - 1 ? WORLD_STRAIGHT : WORLD_FOLDED,
    }).keypoints3D
  }

  const withWorld = scorePunchForSide('left', history, {})
  expectDetection(withWorld, 'jab', 'left', 100)
  assert.equal(withWorld.debug.cues.straight3D, true)
})

test('a confirmed sweep with a bent 3D elbow overrides a straight projection', () => {
  const poses = [
    { elbow: [-0.6, 0], wrist: [-0.6, -0.2] },
    { elbow: [-0.6, 0], wrist: [-0.2, 0] },
    { elbow: [0.75, 0], wrist: [1.5, 0] },
  ]
  const history = poseHistory('left', poses)

  expectDetection(scorePunchForSide('left', history, {}), 'jab', 'left', 100)

  for (const item of history) {
    item.keypoints3D = frame(item.time, {}, { left: WORLD_BENT }).keypoints3D
  }

  const result = scorePunchForSide('left', history, {})
  expectDetection(result, 'hook', 'left', 100)
  assert.equal(result.debug.cues.sweepingBentArm, true)
  assert.equal(result.debug.cues.straight2D, false)
})

test('straight-punch recoil is not counted as a new curved punch', () => {
  const history = poseHistory('left', [GUARD, STRAIGHT, HOOK_END])
  const result = scorePunchForSide('left', history, {})

  assert.equal(result.debug.cues.returningFromStraight, true)
  assert.equal(result.detection, null)
})

test('tracking gaps greater than 250 ms break motion continuity', () => {
  const boundary = straightHistory('left', [1000, 1050, 1300])
  expectDetection(scorePunchForSide('left', boundary, {}), 'jab', 'left', 100)

  const gap = straightHistory('left', [1000, 1050, 1301])
  const result = scorePunchForSide('left', gap, {})
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('duplicate or decreasing timestamps do not establish motion', () => {
  for (const times of [[1000, 1050, 1050], [1000, 1100, 1050]]) {
    const result = scorePunchForSide('left', straightHistory('left', times), {})
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.lateralDominant, false)
    assert.equal(result.debug.cues.verticalDominant, false)
    assert.equal(result.detection, null)
  }
})

test('motion windows vary by speed and exclude stale preparation', () => {
  const history = poseHistory(
    'left', [GUARD, STRAIGHT, STRAIGHT], [1000, 1200, 1400],
  )

  expectDetection(scorePunchForSide('left', history, {}, 'form'), 'jab', 'left')
  for (const speed of ['casual', 'intense']) {
    const result = scorePunchForSide('left', history, {}, speed)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.detection, null)
  }
})

test('frames at the last punch timestamp cannot seed a new motion', () => {
  const history = straightHistory()
  const result = scorePunchForSide('left', history, { left: 1050 })

  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('each speed enforces its cooldown through the exact boundary', () => {
  const history = straightHistory()
  const now = history.at(-1).time

  for (const [speed, cooldownMs] of [
    ['form', 480],
    ['casual', 300],
    ['intense', 160],
  ]) {
    const blocked = scorePunchForSide(
      'left', history, { left: now - cooldownMs + 1 }, speed,
    )
    assert.equal(blocked.detection, null)
    assert.equal(blocked.debug.bestType, 'jab')
    assert.equal(blocked.debug.bestScore, 100)
    assert.equal(blocked.debug.cooldownRemaining, 1)

    const ready = scorePunchForSide(
      'left', history, { left: now - cooldownMs }, speed,
    )
    expectDetection(ready, 'jab', 'left', 100)
    assert.equal(ready.debug.cooldownRemaining, 0)
  }
})

test('cooldowns are independent for each side', () => {
  const history = straightHistory()
  expectDetection(
    scorePunchForSide('left', history, { right: 1099 }), 'jab', 'left', 100,
  )
})

test('missing, null, and zero last-punch timestamps allow initial detections', () => {
  for (const lastPunchBySide of [{}, { left: null }, { left: 0 }]) {
    const result = scorePunchForSide('left', straightHistory(), lastPunchBySide)
    expectDetection(result, 'jab', 'left', 100)
    assert.equal(result.debug.cooldownRemaining, 0)
    assert.equal(result.debug.recovered, true)
  }
})

test('continuing 3D extension is blocked without recovery even after cooldown', () => {
  const worldAtReach = (reach) => ({
    ...WORLD_STRAIGHT,
    wrist: [0, 0, reach],
  })
  const history = [
    frame(1000, {}, { left: WORLD_FOLDED }),
    frame(1050, {}, { left: WORLD_FOLDED }),
    frame(1100, {}, { left: worldAtReach(0.7) }),
    frame(1250, {}, { left: worldAtReach(0.8) }),
    frame(1400, {}, { left: WORLD_STRAIGHT }),
  ]

  const result = scorePunchForSide('left', history, { left: 1100 })
  assert.equal(result.debug.cues.straight3D, true)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('observable 2D recoil permits another punch once cooldown expires', () => {
  const history = poseHistory(
    'left',
    [GUARD, GUARD, STRAIGHT, GUARD, STRAIGHT],
    [1000, 1050, 1100, 1250, 1400],
  )
  const result = scorePunchForSide('left', history, { left: 1100 })

  assert.equal(result.debug.recovered, true)
  expectDetection(result, 'jab', 'left', 100)
})

test('observable 3D recoil permits another punch with stationary 2D landmarks', () => {
  const history = [
    frame(1000, {}, { left: WORLD_FOLDED }),
    frame(1050, {}, { left: WORLD_FOLDED }),
    frame(1100, {}, { left: WORLD_STRAIGHT }),
    frame(1250, {}, { left: WORLD_FOLDED }),
    frame(1400, {}, { left: WORLD_STRAIGHT }),
  ]
  const result = scorePunchForSide('left', history, { left: 1100 })

  assert.equal(result.debug.recovered, true)
  expectDetection(result, 'jab', 'left', 100)
})

test('previous wrist confidence uses its separate motion threshold', () => {
  const history = hookHistory()
  const previousWrist = history.at(-2).keypoints.find(
    (point) => point.name === 'left_wrist',
  )

  previousWrist.score = 0.25
  expectDetection(scorePunchForSide('left', history, {}), 'hook', 'left')

  previousWrist.score = 0.249
  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.lateralDominant, false)
  assert.equal(result.detection, null)
})

test('default and unrecognized speeds behave like casual speed', () => {
  const history = straightHistory()
  const lastPunchBySide = { left: 850 }
  const casual = scorePunchForSide('left', history, lastPunchBySide, 'casual')

  for (const speed of [undefined, 'unknown-speed', null]) {
    assert.deepEqual(
      scorePunchForSide('left', history, lastPunchBySide, speed),
      casual,
    )
    assert.deepEqual(
      classifyPunch(history, lastPunchBySide, speed),
      classifyPunch(history, lastPunchBySide, 'casual'),
    )
  }
})

test('translation and uniform image scaling preserve classifications', () => {
  for (const history of [
    straightHistory(),
    hookHistory(),
    uppercutHistory(),
  ]) {
    const transformed = history.map((item) => ({
      ...item,
      keypoints: item.keypoints.map((point) => ({
        ...point,
        x: point.x * 2 + 300,
        y: point.y * 2 + 200,
      })),
    }))

    assert.deepEqual(classifyPunch(transformed, {}), classifyPunch(history, {}))
  }
})

test('coincident shoulders use the minimum width without nonfinite scores', () => {
  const history = poseHistory('left', [GUARD, GUARD, GUARD])
  for (const item of history) {
    const opposite = item.keypoints.find(
      (point) => point.name === 'right_shoulder',
    )
    opposite.x = 0
    opposite.y = 0
  }

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.detection, null)
  for (const score of Object.values(result.debug.scoreByType)) {
    assert.ok(Number.isFinite(score))
  }
  assert.ok(Number.isFinite(result.debug.elbowAngle))
})

test('classifyPunch includes debug for both valid sides without a punch', () => {
  const result = classifyPunch([frame(1000), frame(1050), frame(1100)], {})
  assert.equal(result.punch, null)
  assert.deepEqual(result.debug.map((entry) => entry.side), ['left', 'right'])
})

test('classifyPunch filters unavailable debug and still detects the valid side', () => {
  const history = straightHistory()
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (point) => point.name !== 'right_hip',
  )

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.deepEqual(result.debug.map((entry) => entry.side), ['left'])

  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (point) => point.name !== 'nose',
  )
  assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] })
})

test('classifyPunch selects the higher scoring side', () => {
  const history = [
    frame(1000, { left: GUARD, right: HOOK_START }),
    frame(1050, { left: GUARD, right: HOOK_MIDDLE }),
    frame(1100, { left: STRAIGHT, right: HOOK_END }),
  ]
  const left = scorePunchForSide('left', history, {})
  const right = scorePunchForSide('right', history, {})

  expectDetection(left, 'jab', 'left', 100)
  expectDetection(right, 'hook', 'right')
  assert.ok(right.detection.score > left.detection.score)

  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, right.detection)
  assert.deepEqual(result.debug, [left.debug, right.debug])
})

test('classifyPunch resolves equal scores in favor of the left side', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, { left: STRAIGHT, right: STRAIGHT }),
  ]
  const result = classifyPunch(history, {})

  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.equal(result.debug[0].bestScore, 100)
  assert.equal(result.debug[1].bestScore, 100)
})

test('classifyPunch excludes detections blocked by cooldown', () => {
  const history = [
    frame(1000, { left: GUARD, right: HOOK_START }),
    frame(1050, { left: GUARD, right: HOOK_MIDDLE }),
    frame(1100, { left: STRAIGHT, right: HOOK_END }),
  ]
  const result = classifyPunch(history, { right: 850 })

  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.equal(result.debug[1].bestType, 'hook')
  assert.equal(result.debug[1].cooldownRemaining, 50)
})

test('classifyPunch forwards the selected speed to both sides', () => {
  const history = straightHistory()
  const lastPunchBySide = { left: 900 }

  assert.equal(classifyPunch(history, lastPunchBySide, 'casual').punch, null)
  assert.deepEqual(
    classifyPunch(history, lastPunchBySide, 'intense').punch,
    { type: 'jab', score: 100, side: 'left' },
  )
})

test('classification does not mutate history, landmarks, or cooldown state', () => {
  const history = uppercutHistory()
  const lastPunchBySide = { left: 100, right: 200 }
  const historyBefore = structuredClone(history)
  const cooldownBefore = structuredClone(lastPunchBySide)

  function deepFreeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze)
      Object.freeze(value)
    }
    return value
  }

  deepFreeze(history)
  deepFreeze(lastPunchBySide)

  scorePunchForSide('left', history, lastPunchBySide)
  scorePunchForSide('right', history, lastPunchBySide)
  classifyPunch(history, lastPunchBySide)

  assert.deepEqual(history, historyBefore)
  assert.deepEqual(lastPunchBySide, cooldownBefore)
})
