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

const GUARD = { elbow: [0, 0.5], wrist: [0.3, 0] }
const STRAIGHT = { elbow: [0.6, 0], wrist: [1.2, 0] }
const HOOK_PREP = { elbow: [0, -0.3], wrist: [0.3, -0.3] }
const HOOK = { elbow: [0, -0.3], wrist: [0.6, -0.3] }
const UPPER_PREP = { elbow: [0.6, 0], wrist: [0.6, -0.1] }
const UPPER = { elbow: [0.6, 0], wrist: [0.6, -0.6] }

const WORLD_GUARD = { elbow: [0, 0.5, 0], wrist: [0.3, 0, 0] }
const WORLD_STRAIGHT = { elbow: [0, 0, -0.5], wrist: [0, 0, -1] }
const WORLD_BENT = { elbow: [0.5, 0, 0], wrist: [0.5, -0.5, 0] }

function point(side, joint, coordinates, world = false) {
  const scale = world ? 1 : 100
  const result = {
    name: `${side}_${joint}`,
    x: (side === 'left' ? coordinates[0] : 1 - coordinates[0]) * scale,
    y: coordinates[1] * scale,
    score: 1,
  }
  if (world) result.z = coordinates[2] ?? 0
  else if (coordinates.length > 2) result.z = coordinates[2]
  return result
}

function frame(time, options = {}) {
  const result = {
    time,
    keypoints: [{ name: 'nose', x: 50, y: -80, score: 1 }],
  }

  for (const side of ['left', 'right']) {
    const pose = options[side] ?? GUARD
    for (const [joint, coordinates] of [
      ['shoulder', pose.shoulder ?? [0, 0]],
      ['elbow', pose.elbow],
      ['wrist', pose.wrist],
      ['hip', pose.hip ?? [0, 2]],
    ]) {
      result.keypoints.push(point(side, joint, coordinates))
    }

    const worldPose = options[`${side}3D`]
    if (worldPose) {
      result.keypoints3D ??= []
      for (const [joint, coordinates] of [
        ['shoulder', worldPose.shoulder ?? [0, 0, 0]],
        ['elbow', worldPose.elbow],
        ['wrist', worldPose.wrist],
      ]) {
        result.keypoints3D.push(point(side, joint, coordinates, true))
      }
    }
  }
  return result
}

function historyFor(
  side,
  poses,
  times = poses.map((_, index) => 1000 + index * 100),
  worldPoses = [],
) {
  return poses.map((pose, index) =>
    frame(times[index], {
      [side]: pose,
      [`${side}3D`]: worldPoses[index],
    }),
  )
}

function straightHistory(side = 'left') {
  return historyFor(side, [GUARD, GUARD, STRAIGHT])
}

function worldStraight(reach) {
  return {
    elbow: [0, 0, -reach / 2],
    wrist: [0, 0, -reach],
  }
}

function armAtAngle(degrees) {
  const radians = ((180 - degrees) * Math.PI) / 180
  return {
    elbow: [0.6, 0],
    wrist: [
      0.6 + 0.6 * Math.cos(radians),
      0.6 * Math.sin(radians),
    ],
  }
}

function findKeypoint(value, name, world = false) {
  return value[world ? 'keypoints3D' : 'keypoints']
    .find((entry) => entry.name === name)
}

function assertClose(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function assertDetection(result, type, side, score) {
  assert.ok(result.detection, `Expected a ${side} ${type}`)
  assert.equal(result.detection.type, type)
  assert.equal(result.detection.side, side)
  assert.ok(Number.isInteger(result.detection.score))
  if (score !== undefined) assert.equal(result.detection.score, score)
  assert.equal(result.debug.bestType, type)
  assert.equal(result.debug.bestScore, result.detection.score)
  assert.ok(result.detection.score >= result.debug.threshold)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

test('punchTypes exposes the four supported types in order', () => {
  assert.deepEqual(punchTypes, ['jab', 'cross', 'hook', 'uppercut'])
})

test('initialPunchCounts returns independent zeroed objects', () => {
  const expected = { jab: 0, cross: 0, hook: 0, uppercut: 0 }
  const first = initialPunchCounts()
  const second = initialPunchCounts()

  assert.deepEqual(first, expected)
  assert.deepEqual(second, expected)
  assert.notStrictEqual(first, second)

  first.jab = 5
  first.extra = 1
  assert.deepEqual(second, expected)
  assert.deepEqual(initialPunchCounts(), expected)
})

test('getPoint handles absent arrays, empty arrays, and missing names', () => {
  assert.equal(getPoint(undefined, 'nose'), undefined)
  assert.equal(getPoint(null, 'nose'), undefined)
  assert.equal(getPoint([], 'nose'), undefined)
  assert.equal(getPoint([{ name: 'wrist', score: 1 }], 'nose'), undefined)
})

test('getPoint returns the first qualifying point by reference', () => {
  const low = { name: 'nose', score: 0.49 }
  const boundary = { name: 'nose', score: 0.5 }
  const later = { name: 'nose', score: 1 }
  const points = [{ name: 'other', score: 1 }, low, boundary, later]

  assert.strictEqual(getPoint(points, 'nose'), boundary)
  assert.strictEqual(getPoint(points, 'nose', 0.9), later)
  assert.equal(getPoint(points, 'nose', 1.01), undefined)
})

test('getPoint defaults nullish scores to one but preserves zero and NaN', () => {
  for (const value of [
    { name: 'nose' },
    { name: 'nose', score: undefined },
    { name: 'nose', score: null },
  ]) {
    assert.strictEqual(getPoint([value], 'nose'), value)
    assert.strictEqual(getPoint([value], 'nose', 1), value)
    assert.equal(getPoint([value], 'nose', 1.01), undefined)
  }

  const zero = { name: 'nose', score: 0 }
  assert.equal(getPoint([zero], 'nose'), undefined)
  assert.strictEqual(getPoint([zero], 'nose', 0), zero)
  assert.equal(getPoint([{ name: 'nose', score: NaN }], 'nose', 0), undefined)
})

test('dist2d calculates symmetric Euclidean distance and ignores depth', () => {
  const a = { x: -2, y: -3, z: -100 }
  const b = { x: 1, y: 1, z: 100 }

  assert.equal(dist2d(a, b), 5)
  assert.equal(dist2d(b, a), 5)
  assert.equal(dist2d(a, a), 0)
  assert.equal(dist2d({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }), 0.5)
})

test('angleDeg measures the angle at the middle point', () => {
  assertClose(angleDeg(
    { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 },
  ), 90)
  assertClose(angleDeg(
    { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 },
  ), 180)
  assertClose(angleDeg(
    { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 },
  ), 0)
  assertClose(angleDeg(
    { x: 1, y: 0 },
    { x: 0, y: 0 },
    { x: 0.5, y: Math.sqrt(3) / 2 },
  ), 60)
})

test('angleDeg returns zero for either zero-length adjacent segment', () => {
  const origin = { x: 0, y: 0 }
  const other = { x: 1, y: 1 }

  assert.equal(angleDeg(origin, origin, other), 0)
  assert.equal(angleDeg(other, origin, origin), 0)
  assert.equal(angleDeg(origin, origin, origin), 0)
})

test('angleDeg supports a custom distance function', () => {
  const a = {}
  const b = {}
  const c = {}
  const calls = []
  const lengths = [3, 4, 5]

  const angle = angleDeg(a, b, c, (first, second) => {
    calls.push([first, second])
    return lengths[calls.length - 1]
  })

  assertClose(angle, 90)
  assert.equal(calls.length, 3)
  for (const [index, pair] of [[0, [a, b]], [1, [b, c]], [2, [a, c]]]) {
    assert.strictEqual(calls[index][0], pair[0])
    assert.strictEqual(calls[index][1], pair[1])
  }
})

test('angleDeg clamps cosine values outside the valid acos range', () => {
  for (const [lengths, expected] of [
    [[1, 2, 0], 0],
    [[1, 1, 3], 180],
  ]) {
    let index = 0
    assert.equal(angleDeg({}, {}, {}, () => lengths[index++]), expected)
  }
})

test('insufficient history returns no detection or debug information', () => {
  for (const length of [0, 1, 2]) {
    const history = straightHistory().slice(0, length)
    for (const side of ['left', 'right']) {
      assert.deepEqual(scorePunchForSide(side, history, {}), {
        detection: null,
        debug: null,
      })
    }
    assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] })
  }
})

test('every required current image keypoint must be present and confident', () => {
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
      for (const mode of ['missing', 'low-confidence']) {
        const history = straightHistory(side)
        const current = history.at(-1)
        if (mode === 'missing') {
          current.keypoints = current.keypoints.filter((p) => p.name !== name)
        } else {
          findKeypoint(current, name).score = name === 'nose' ? 0.299 : 0.499
        }
        assert.deepEqual(scorePunchForSide(side, history, {}), {
          detection: null,
          debug: null,
        }, `${side}: ${name}, ${mode}`)
      }
    }
  }

  const history = straightHistory()
  delete history.at(-1).keypoints
  assert.deepEqual(scorePunchForSide('left', history, {}), {
    detection: null,
    debug: null,
  })
})

test('current confidence thresholds are inclusive and missing scores are accepted', () => {
  for (const mode of ['boundary', 'missing', 'null']) {
    const history = straightHistory()
    for (const p of history.at(-1).keypoints) {
      if (mode === 'boundary') p.score = p.name === 'nose' ? 0.3 : 0.5
      else if (mode === 'missing') delete p.score
      else p.score = null
    }
    assertDetection(scorePunchForSide('left', history, {}), 'jab', 'left', 100)
  }
})

for (const [side, type] of [['left', 'jab'], ['right', 'cross']]) {
  test(`${side} image-space extension is classified anatomically as ${type}`, () => {
    const result = scorePunchForSide(side, straightHistory(side), {})
    assertDetection(result, type, side, 100)
    assert.equal(result.debug.side, side)
    assert.equal(result.debug.straightType, type)
    assert.equal(result.debug.threshold, 68)
    assert.equal(result.debug.cues.straight2D, true)
    assert.equal(result.debug.cues.straight3D, false)
    assert.equal(result.debug.cues.elbowMostlyStraight, true)
    assert.equal(result.debug.elbowAngle, 180)
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.cooldownRemaining, 0)
    assert.equal(result.debug.recovered, true)
    assert.deepEqual(Object.keys(result.debug.scoreByType), [
      type, 'hook', 'uppercut',
    ])
  })

  test(`${side} lateral bent-arm motion produces a hook`, () => {
    const history = historyFor(side, [HOOK_PREP, HOOK_PREP, HOOK])
    const result = scorePunchForSide(side, history, {})

    assertDetection(result, 'hook', side, 156)
    assert.equal(result.debug.threshold, 62)
    assert.equal(result.debug.cues.lateralDominant, true)
    assert.equal(result.debug.cues.verticalDominant, false)
    assert.equal(result.debug.cues.armParallelFloor, true)
    assert.equal(result.debug.cues.armPerpendicularFloor, false)
    assert.equal(result.debug.forearmAngleToHorizontal, 0)
    assert.equal(result.debug.elbowAngle, 90)
  })

  test(`${side} rising bent-arm motion from below produces an uppercut`, () => {
    const poses = [0.6, 0.5, 0.3, 0.1, -0.6].map((y) => ({
      elbow: [0.6, 0],
      wrist: [0.6, y],
    }))
    const history = historyFor(side, poses, [1000, 1050, 1100, 1150, 1200])
    const result = scorePunchForSide(side, history, {})

    assertDetection(result, 'uppercut', side, 173)
    assert.equal(result.debug.threshold, 64)
    assert.equal(result.debug.cues.lowPrep, true)
    assert.equal(result.debug.cues.uppercutFromLow, true)
    assert.equal(result.debug.cues.verticalDominant, true)
    assert.equal(result.debug.cues.armPerpendicularFloor, true)
    assert.equal(result.debug.forearmAngleToHorizontal, 90)
  })

  test(`${side} reliable world-space extension works with a bent image projection`, () => {
    const history = historyFor(
      side,
      [GUARD, GUARD, GUARD],
      undefined,
      [WORLD_GUARD, WORLD_GUARD, WORLD_STRAIGHT],
    )
    const result = scorePunchForSide(side, history, {})

    assertDetection(result, type, side, 100)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.debug.cues.straight3D, true)
    assert.equal(result.debug.elbowAngle3D, 180)
  })
}

test('static guard, straight, hook, and uppercut poses do not count as punches', () => {
  for (const pose of [GUARD, STRAIGHT, HOOK, UPPER]) {
    const history = historyFor('left', [pose, pose, pose])
    const result = scorePunchForSide('left', history, {})
    assert.equal(result.detection, null)
    assert.equal(result.debug.bestType, null)
    assert.equal(result.debug.bestScore, 0)
    assert.equal(result.debug.threshold, null)
  }

  const result = scorePunchForSide(
    'left', historyFor('left', [HOOK, HOOK, HOOK]), {},
  )
  assert.equal(result.debug.scoreByType.hook, 98)
})

test('eligible candidates below their confidence threshold remain undetected', () => {
  const prep = { elbow: [0, 0.6], wrist: [0.55, 0.6, 0.1] }
  const endpoint = { elbow: [0, 0.6], wrist: [0.6, 0.6, 0] }
  const result = scorePunchForSide(
    'left', historyFor('left', [prep, prep, endpoint]), {}, 'form',
  )

  assert.equal(result.detection, null)
  assert.equal(result.debug.bestType, 'hook')
  assert.equal(result.debug.bestScore, 60)
  assert.equal(result.debug.threshold, 62)
})

test('previous wrist confidence uses the lower, inclusive motion threshold', () => {
  for (const [score, expected] of [[0.25, 'hook'], [0.249, null]]) {
    const history = historyFor('left', [HOOK_PREP, HOOK_PREP, HOOK])
    findKeypoint(history[1], 'left_wrist').score = score
    const result = scorePunchForSide('left', history, {})
    assert.equal(result.detection?.type ?? null, expected)
  }
})

test('a slightly bent straight requires strong temporal opening and reach', () => {
  const strong = historyFor('left', [GUARD, GUARD, armAtAngle(147)])
  const result = scorePunchForSide('left', strong, {})
  assertDetection(result, 'jab', 'left', 100)
  assert.equal(result.debug.elbowAngle, 147)
  assert.equal(result.debug.cues.elbowMostlyStraight, false)
  assert.equal(result.debug.cues.straight2D, true)

  for (const poses of [
    [GUARD, GUARD, armAtAngle(144)],
    [armAtAngle(110), armAtAngle(110), armAtAngle(147)],
  ]) {
    const rejected = scorePunchForSide('left', historyFor('left', poses), {})
    assert.equal(rejected.detection, null)
    assert.equal(rejected.debug.cues.straight2D, false)
  }
})

test('image straight detection tolerates tiny recoil but rejects substantial retreat', () => {
  for (const [previousReach, eligible] of [[1.21, true], [1.23, false]]) {
    const previous = {
      elbow: [previousReach / 2, 0],
      wrist: [previousReach, 0],
    }
    const result = scorePunchForSide(
      'left', historyFor('left', [GUARD, previous, STRAIGHT]), {},
    )
    assert.equal(result.debug.cues.straight2D, eligible)
    assert.equal(result.detection?.type ?? null, eligible ? 'jab' : null)
  }
})

test('world-space recoil is not mistaken for a new extension', () => {
  const history = historyFor(
    'left',
    [GUARD, GUARD, GUARD],
    undefined,
    [WORLD_GUARD, worldStraight(1.2), worldStraight(1)],
  )
  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.straight3D, false)
  assert.equal(result.detection, null)
})

test('lowering an arm is rejected in 2D while reliable 3D can confirm a downward punch', () => {
  const lowered = { elbow: [0, 0.6], wrist: [0, 1.2] }
  const history = historyFor('left', [GUARD, GUARD, lowered])
  const rejected = scorePunchForSide('left', history, {})
  assert.equal(rejected.debug.cues.straight2D, false)
  assert.equal(rejected.detection, null)

  const confirmed = historyFor(
    'left',
    [GUARD, GUARD, lowered],
    undefined,
    [
      WORLD_GUARD,
      WORLD_GUARD,
      { elbow: [0, 0.5, 0], wrist: [0, 1, 0] },
    ],
  )
  const result = scorePunchForSide('left', confirmed, {})
  assertDetection(result, 'jab', 'left', 100)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.cues.straight3D, true)
})

test('bent world-space geometry rejects a straight-looking arm across the body', () => {
  const history = historyFor(
    'left',
    [GUARD, GUARD, STRAIGHT],
    undefined,
    [WORLD_BENT, WORLD_BENT, WORLD_BENT],
  )
  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.elbowAngle, 180)
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.debug.cues.straight3D, false)
  assert.equal(result.detection, null)
})

test('a flared elbow and inward sweep with a bent world arm identify a projected hook', () => {
  const flared = { elbow: [-0.6, -0.2], wrist: [-0.1, -0.2] }
  const history = historyFor(
    'left',
    [flared, flared, STRAIGHT],
    undefined,
    [WORLD_BENT, WORLD_BENT, WORLD_BENT],
  )
  const result = scorePunchForSide('left', history, {})

  assertDetection(result, 'hook', 'left', 100)
  assert.equal(result.debug.elbowAngle, 180)
  assert.equal(result.debug.elbowAngle3D, 90)
  assert.equal(result.debug.cues.sweepingBentArm, true)
})

test('world-space evidence can confirm an uppercut with a sharply bent 2D projection', () => {
  const prep = { elbow: [0.4, 0.3], wrist: [0.4, 0.4] }
  const endpoint = { elbow: [0.4, 0.3], wrist: [0.4, -0.6] }
  const poses = [prep, prep, endpoint]

  const unconfirmed = scorePunchForSide('left', historyFor('left', poses), {})
  assert.equal(unconfirmed.detection, null)

  const history = historyFor(
    'left', poses, undefined, [WORLD_BENT, WORLD_BENT, WORLD_BENT],
  )
  const result = scorePunchForSide('left', history, {})
  assertDetection(result, 'uppercut', 'left')
  assert.equal(result.debug.cues.risingBentArm, true)
  assert.ok(result.debug.elbowAngle < 65)
  assert.equal(result.debug.elbowAngle3D, 90)
})

test('straight recoil is not classified as a curved punch', () => {
  for (const endpoint of [HOOK, UPPER]) {
    const result = scorePunchForSide(
      'left', historyFor('left', [GUARD, STRAIGHT, endpoint]), {},
    )
    assert.equal(result.debug.cues.returningFromStraight, true)
    assert.equal(result.detection, null)
  }
})

test('whole-body upward motion does not supply an uppercut trajectory', () => {
  const history = historyFor('left', [UPPER_PREP, UPPER_PREP, UPPER_PREP])
  for (const p of history.at(-1).keypoints) p.y -= 60

  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.verticalDominant, true)
  assert.equal(result.debug.cues.uppercutFromLow, false)
  assert.equal(result.debug.cues.uppercutFromGuard, false)
  assert.equal(result.detection, null)
})

test('uppercuts from guard respect each speed profile confirmation duration', () => {
  for (const [speed, confirmation] of [
    ['form', 140], ['casual', 80], ['intense', 45],
  ]) {
    for (const elapsed of [confirmation - 1, confirmation]) {
      const history = historyFor(
        'left',
        [UPPER_PREP, { elbow: [0.6, 0], wrist: [0.6, -0.25] }, UPPER],
        [1000, 1000 + elapsed / 2, 1000 + elapsed],
      )
      const result = scorePunchForSide('left', history, {}, speed)
      const confirmed = elapsed === confirmation
      assert.equal(result.debug.cues.uppercutFromGuard, confirmed, speed)
      assert.equal(
        result.detection?.type ?? null,
        confirmed ? 'uppercut' : null,
        speed,
      )
    }
  }
})

test('hook motion is normalized across capture intervals', () => {
  const slow = historyFor(
    'left', [HOOK_PREP, HOOK_PREP, HOOK], [1000, 1100, 1200],
  )
  const fast = historyFor(
    'left',
    [HOOK_PREP, { elbow: [0, -0.3], wrist: [0.525, -0.3] }, HOOK],
    [1150, 1175, 1200],
  )

  for (const history of [slow, fast]) {
    const result = scorePunchForSide('left', history, {})
    assertDetection(result, 'hook', 'left')
    assert.equal(result.debug.cues.lateralDominant, true)
  }
})

test('motion normalization is capped at four for extremely short intervals', () => {
  const endpoint = { elbow: [0, -0.3], wrist: [0.35, -0.3] }
  const history = historyFor(
    'left', [HOOK_PREP, HOOK_PREP, endpoint], [1000, 1100, 1110],
  )
  const result = scorePunchForSide('left', history, {})
  assertDetection(result, 'hook', 'left', 98)
  assert.equal(result.debug.cues.lateralDominant, false)
})

test('speed profiles change the minimum curved-punch motion requirement', () => {
  const endpoint = { elbow: [0, -0.3], wrist: [0.32, -0.3] }
  const history = historyFor(
    'left', [HOOK_PREP, HOOK_PREP, endpoint], [1000, 1050, 1055],
  )

  assertDetection(scorePunchForSide('left', history, {}, 'form'), 'hook', 'left')
  for (const speed of ['casual', 'intense']) {
    assert.equal(scorePunchForSide('left', history, {}, speed).detection, null)
  }
})

test('invalid current frame intervals suppress motion-based detections', () => {
  for (const times of [
    [1000, 1100, 1100],
    [1000, 1100, 1099],
    [1000, 1100, 1351],
  ]) {
    for (const poses of [
      [GUARD, GUARD, STRAIGHT],
      [HOOK_PREP, HOOK_PREP, HOOK],
      [UPPER_PREP, UPPER_PREP, UPPER],
    ]) {
      const result = scorePunchForSide('left', historyFor('left', poses, times), {})
      assert.equal(result.detection, null)
      assert.equal(result.debug.cues.lateralDominant, false)
      assert.equal(result.debug.cues.verticalDominant, false)
    }
  }
})

test('the casual motion window includes its boundary and excludes older evidence', () => {
  const halfway = { elbow: [0.5, 0], wrist: [1, 0] }
  for (const [oldestTime, expected] of [[1000, true], [999, false]]) {
    const history = historyFor(
      'left', [GUARD, halfway, STRAIGHT], [oldestTime, 1175, 1350],
    )
    const result = scorePunchForSide('left', history, {})
    assert.equal(result.debug.cues.straight2D, expected)
    assert.equal(result.detection?.type ?? null, expected ? 'jab' : null)
  }
})

test('slower profiles can retain extension evidence outside the casual window', () => {
  const halfway = { elbow: [0.5, 0], wrist: [1, 0] }
  const history = historyFor(
    'left', [GUARD, halfway, STRAIGHT], [1000, 1200, 1400],
  )

  assertDetection(scorePunchForSide('left', history, {}, 'form'), 'jab', 'left')
  for (const speed of ['casual', 'intense']) {
    const result = scorePunchForSide('left', history, {}, speed)
    assert.equal(result.debug.cues.straight2D, false)
    assert.equal(result.detection, null)
  }
})

test('historical gaps accept 250 ms but break on larger or non-increasing intervals', () => {
  const halfway = { elbow: [0.5, 0], wrist: [1, 0] }
  for (const [times, expected] of [
    [[1000, 1250, 1500], true],
    [[1000, 1251, 1501], false],
    [[1000, 1000, 1100], false],
    [[1100, 1000, 1200], false],
  ]) {
    const history = historyFor('left', [GUARD, halfway, STRAIGHT], times)
    const result = scorePunchForSide('left', history, {}, 'form')
    assert.equal(result.debug.cues.straight2D, expected)
    assert.equal(result.detection?.type ?? null, expected ? 'jab' : null)
  }
})

test('a missing immediately previous arm prevents a 2D straight detection', () => {
  const history = straightHistory()
  history[1].keypoints = history[1].keypoints.filter(
    (p) => p.name !== 'left_elbow',
  )
  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

test('invalid world geometry falls back to usable image geometry', () => {
  const corruptions = [
    (value) => { delete value.keypoints3D },
    (value) => { value.keypoints3D = [] },
    (value) => {
      value.keypoints3D = value.keypoints3D.filter((p) => p.name !== 'left_elbow')
    },
    (value) => { findKeypoint(value, 'left_wrist', true).score = 0.49 },
    (value) => { findKeypoint(value, 'left_wrist', true).x = NaN },
    (value) => { findKeypoint(value, 'left_elbow', true).y = Infinity },
    (value) => { delete findKeypoint(value, 'left_shoulder', true).z },
    (value) => {
      for (const p of value.keypoints3D) {
        p.x = 0
        p.y = 0
        p.z = 0
      }
    },
  ]

  for (const corrupt of corruptions) {
    const history = historyFor(
      'left',
      [GUARD, GUARD, STRAIGHT],
      undefined,
      [WORLD_GUARD, WORLD_GUARD, WORLD_STRAIGHT],
    )
    corrupt(history.at(-1))
    const result = scorePunchForSide('left', history, {})
    assertDetection(result, 'jab', 'left', 100)
    assert.equal(result.debug.elbowAngle3D, null)
    assert.equal(result.debug.cues.straight3D, false)
  }
})

test('world geometry accepts the minimum arm length and rejects shorter arms', () => {
  for (const [length, expectedAngle] of [[0.1, 180], [0.099, null]]) {
    const history = historyFor(
      'left',
      [GUARD, GUARD, GUARD],
      undefined,
      [undefined, undefined, worldStraight(length)],
    )
    const result = scorePunchForSide('left', history, {})
    assert.equal(result.debug.elbowAngle3D, expectedAngle)
    assert.equal(result.detection, null)
  }
})

test('world straight detection requires usable immediately previous geometry', () => {
  const history = historyFor(
    'left',
    [GUARD, GUARD, GUARD],
    undefined,
    [WORLD_GUARD, undefined, WORLD_STRAIGHT],
  )
  const result = scorePunchForSide('left', history, {})
  assert.equal(result.debug.elbowAngle3D, 180)
  assert.equal(result.debug.cues.straight3D, false)
  assert.equal(result.detection, null)
})

test('cooldown blocks an otherwise eligible punch until its exact boundary', () => {
  for (const [speed, cooldown] of [
    ['form', 480], ['casual', 300], ['intense', 160],
  ]) {
    const history = historyFor(
      'left', [GUARD, GUARD, STRAIGHT], [1100, 1150, 1200],
    )
    for (const [remaining, expected] of [[1, false], [0, true]]) {
      const lastPunch = { left: 1200 - cooldown + remaining }
      const result = scorePunchForSide('left', history, lastPunch, speed)
      assert.equal(result.debug.bestType, 'jab')
      assert.equal(result.debug.bestScore, 100)
      assert.equal(result.debug.cooldownRemaining, remaining)
      assert.equal(result.debug.recovered, true)
      assert.equal(result.detection?.type ?? null, expected ? 'jab' : null)
    }
  }
})

test('cooldown uses unrounded time even when debug rounds the remainder to zero', () => {
  const result = scorePunchForSide(
    'left', straightHistory(), { left: 900.4 },
  )
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.detection, null)
})

test('zero or absent timestamps impose no cooldown; opposite-side timestamps are independent', () => {
  const history = straightHistory()
  for (const lastPunch of [{}, { left: 0 }, { left: null }, { right: 1199 }]) {
    assertDetection(scorePunchForSide('left', history, lastPunch), 'jab', 'left')
  }
})

test('motion evidence at or before the previous punch is excluded', () => {
  const halfway = { elbow: [0.5, 0], wrist: [1, 0] }
  const history = historyFor(
    'left', [GUARD, halfway, STRAIGHT], [1000, 1200, 1400],
  )
  const result = scorePunchForSide('left', history, { left: 1000 }, 'form')
  assert.equal(result.debug.cues.straight2D, false)
  assert.equal(result.detection, null)
})

function continuingExtensionHistory() {
  return historyFor(
    'left',
    [STRAIGHT, STRAIGHT, STRAIGHT, STRAIGHT],
    [1000, 1100, 1200, 1400],
    [worldStraight(1), worldStraight(1.1), worldStraight(1.2), worldStraight(1.6)],
  )
}

test('an expired cooldown still requires recoil before another continuing extension', () => {
  const result = scorePunchForSide(
    'left', continuingExtensionHistory(), { left: 1000 },
  )
  assert.equal(result.debug.cooldownRemaining, 0)
  assert.equal(result.debug.cues.straight3D, true)
  assert.equal(result.debug.bestType, 'jab')
  assert.equal(result.debug.bestScore, 100)
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('intermediate image recoil permits another punch after cooldown', () => {
  const history = continuingExtensionHistory()
  history[2] = frame(1200, { left: GUARD, left3D: worldStraight(1.2) })
  const result = scorePunchForSide('left', history, { left: 1000 })
  assert.equal(result.debug.recovered, true)
  assertDetection(result, 'jab', 'left', 100)
})

test('intermediate world-space recoil permits another punch after cooldown', () => {
  const history = continuingExtensionHistory()
  history[2] = frame(1200, { left: STRAIGHT, left3D: worldStraight(0.7) })
  const result = scorePunchForSide('left', history, { left: 1000 })
  assert.equal(result.debug.recovered, true)
  assert.equal(result.debug.cues.straight2D, false)
  assertDetection(result, 'jab', 'left', 100)
})

test('the current frame alone cannot establish recovery', () => {
  const history = historyFor(
    'left', [STRAIGHT, STRAIGHT, GUARD], [1000, 1100, 1400],
  )
  const result = scorePunchForSide('left', history, { left: 1000 })
  assert.equal(result.debug.recovered, false)
  assert.equal(result.detection, null)
})

test('recovery defaults to true when the previous punch is no longer in history', () => {
  const history = continuingExtensionHistory().slice(1)
  const result = scorePunchForSide('left', history, { left: 1000 })
  assert.equal(result.debug.recovered, true)
  assertDetection(result, 'jab', 'left', 100)
})

test('default and unknown speeds use casual behavior', () => {
  const history = straightHistory()
  const timestamps = { left: 950 }
  const expected = scorePunchForSide('left', history, timestamps, 'casual')
  assert.deepEqual(scorePunchForSide('left', history, timestamps), expected)
  assert.deepEqual(scorePunchForSide('left', history, timestamps, 'unknown'), expected)
  assert.deepEqual(
    classifyPunch(history, timestamps, 'unknown'),
    classifyPunch(history, timestamps, 'casual'),
  )
})

test('classifyPunch returns both debug entries even when no punch is detected', () => {
  const history = [frame(1000), frame(1100), frame(1200)]
  const result = classifyPunch(history, {})
  assert.equal(result.punch, null)
  assert.deepEqual(result.debug.map((entry) => entry.side), ['left', 'right'])
})

test('classifyPunch returns the detected side and omits unavailable debug entries', () => {
  const history = straightHistory('right')
  history.at(-1).keypoints = history.at(-1).keypoints.filter(
    (p) => p.name !== 'left_wrist',
  )
  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' })
  assert.deepEqual(result.debug.map((entry) => entry.side), ['right'])
})

test('classifyPunch selects the stronger detection across sides', () => {
  const history = [
    frame(1000, { left: GUARD, right: HOOK_PREP }),
    frame(1100, { left: GUARD, right: HOOK_PREP }),
    frame(1200, { left: STRAIGHT, right: HOOK }),
  ]
  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'hook', score: 156, side: 'right' })
  assert.deepEqual(result.debug.map((entry) => entry.bestType), ['jab', 'hook'])
})

test('classifyPunch resolves equal scores in favor of the left side', () => {
  const history = [
    frame(1000),
    frame(1100),
    frame(1200, { left: STRAIGHT, right: STRAIGHT }),
  ]
  const result = classifyPunch(history, {})
  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' })
  assert.deepEqual(result.debug.map((entry) => entry.bestScore), [100, 100])
})

test('classifyPunch respects independent cooldowns and passes through speed', () => {
  const history = [
    frame(1100),
    frame(1150),
    frame(1200, { left: STRAIGHT, right: STRAIGHT }),
  ]

  const result = classifyPunch(history, { left: 950 })
  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' })
  assert.deepEqual(result.debug.map((entry) => entry.cooldownRemaining), [50, 0])

  assert.equal(classifyPunch(history, { left: 900, right: 900 }, 'form').punch, null)
  assert.deepEqual(
    classifyPunch(history, { left: 900, right: 900 }, 'intense').punch,
    { type: 'jab', score: 100, side: 'left' },
  )
})

test('scoring and classification do not mutate caller-owned input', () => {
  const history = straightHistory()
  const timestamps = { left: 0, right: 0 }
  const originalHistory = structuredClone(history)
  const originalTimestamps = structuredClone(timestamps)

  deepFreeze(history)
  deepFreeze(timestamps)

  const first = classifyPunch(history, timestamps)
  const second = classifyPunch(history, timestamps)
  scorePunchForSide('left', history, timestamps)
  scorePunchForSide('right', history, timestamps)

  assert.deepEqual(first, second)
  assert.deepEqual(history, originalHistory)
  assert.deepEqual(timestamps, originalTimestamps)
})
