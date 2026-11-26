import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePoseFramePayload } from '../../frontend/src/training/validators.js'

const errors = {
  payload: 'Pose frame must be an object.',
  keypoints: 'keypoints must be a non-empty array.',
  keypoint: 'Each keypoint must include name, numeric x, and numeric y values.',
  keypoints3D:
    'keypoints3D must contain named points with numeric x, y, and z values.',
  time: 'A monotonic frame timestamp is required.',
}

const point = (overrides = {}) => ({
  name: 'nose',
  x: 10,
  y: 20,
  ...overrides,
})

const frame = (overrides = {}) => ({
  time: 100,
  keypoints: [point()],
  ...overrides,
})

const expectError = (payload, message) => {
  assert.deepStrictEqual(validatePoseFramePayload(payload), {
    ok: false,
    message,
  })
}

const nonFiniteNumbers = [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  '12',
  '',
  true,
  false,
  {},
  [],
  new Number(12),
  12n,
  Symbol('number'),
  () => 12,
]

test('accepts a minimal frame and includes undefined optional output fields', () => {
  assert.deepStrictEqual(validatePoseFramePayload(frame()), {
    ok: true,
    value: {
      time: 100,
      keypoints: [
        { name: 'nose', x: 10, y: 20, z: undefined, score: undefined },
      ],
      keypoints3D: undefined,
    },
  })
})

test('rejects missing, null, primitive, and function payloads', () => {
  expectError(undefined, errors.payload)

  for (const payload of [
    null,
    false,
    true,
    0,
    1,
    NaN,
    '',
    'frame',
    1n,
    Symbol('frame'),
    () => frame(),
  ]) {
    expectError(payload, errors.payload)
  }
})

test('requires a non-empty keypoints array', () => {
  for (const keypoints of [
    undefined,
    null,
    [],
    {},
    { 0: point(), length: 1 },
    'keypoints',
    1,
    true,
    new Set([point()]),
  ]) {
    expectError(frame({ keypoints }), errors.keypoints)
  }

  expectError({}, errors.keypoints)
  expectError([], errors.keypoints)
})

test('rejects keypoints that are not valid point objects', () => {
  for (const keypoint of [
    undefined,
    null,
    false,
    true,
    0,
    1,
    'nose',
    1n,
    Symbol('point'),
    () => point(),
    [],
    {},
  ]) {
    expectError(frame({ keypoints: [keypoint] }), errors.keypoint)
  }
})

test('requires a nonblank string name', () => {
  for (const name of [
    undefined,
    null,
    '',
    ' ',
    '\t\r\n',
    '\u00a0',
    0,
    true,
    {},
    [],
    new String('nose'),
    Symbol('name'),
  ]) {
    expectError(frame({ keypoints: [point({ name })] }), errors.keypoint)
  }

  const unnamed = point()
  delete unnamed.name
  expectError(frame({ keypoints: [unnamed] }), errors.keypoint)
})

test('requires finite numeric x and y without coercion', () => {
  for (const field of ['x', 'y']) {
    const missing = point()
    delete missing[field]
    expectError(frame({ keypoints: [missing] }), errors.keypoint)

    for (const value of nonFiniteNumbers) {
      expectError(
        frame({ keypoints: [point({ [field]: value })] }),
        errors.keypoint,
      )
    }
  }
})

test('permits absent, null, undefined, and finite optional z and score', () => {
  for (const field of ['z', 'score']) {
    for (const value of [undefined, null, 0, -0, -2.5, 2.5, Number.MAX_VALUE]) {
      const result = validatePoseFramePayload(
        frame({ keypoints: [point({ [field]: value })] }),
      )

      assert.equal(result.ok, true)
      assert.equal(result.value.keypoints[0][field], value)
    }
  }
})

test('rejects nonnumeric or nonfinite optional z and score', () => {
  for (const field of ['z', 'score']) {
    for (const value of nonFiniteNumbers) {
      if (value == null) continue

      expectError(
        frame({ keypoints: [point({ [field]: value })] }),
        errors.keypoint,
      )
    }
  }
})

test('checks every 2D keypoint', () => {
  expectError(
    frame({ keypoints: [point(), point({ x: NaN })] }),
    errors.keypoint,
  )
})

test('preserves names and accepts finite coordinates and scores without range limits', () => {
  const keypoints = [
    point({
      name: '  left wrist  ',
      x: -Number.MAX_VALUE,
      y: Number.MIN_VALUE,
      z: -12.5,
      score: 5,
    }),
    point({ name: '右肩', x: -0, y: 0.25, z: 0, score: -3 }),
  ]

  assert.deepStrictEqual(validatePoseFramePayload(frame({ keypoints })), {
    ok: true,
    value: {
      time: 100,
      keypoints,
      keypoints3D: undefined,
    },
  })
})

test('allows omitted, undefined, null, and empty keypoints3D', () => {
  for (const keypoints3D of [undefined, null, []]) {
    const result = validatePoseFramePayload(frame({ keypoints3D }))

    assert.equal(result.ok, true)
    assert.deepStrictEqual(
      result.value.keypoints3D,
      keypoints3D == null ? undefined : [],
    )
  }
})

test('requires provided keypoints3D to be an array', () => {
  for (const keypoints3D of [
    {},
    { 0: point({ z: 1 }), length: 1 },
    '',
    'points',
    false,
    0,
    1,
    new Set([point({ z: 1 })]),
    () => [],
  ]) {
    expectError(frame({ keypoints3D }), errors.keypoints3D)
  }
})

test('requires every 3D point to have valid name, x, y, and finite z', () => {
  const invalidPoints = [
    undefined,
    null,
    false,
    0,
    'point',
    [],
    {},
    point(),
    point({ name: '' , z: 1 }),
    point({ name: ' \t ', z: 1 }),
    point({ name: 123, z: 1 }),
  ]

  for (const field of ['x', 'y', 'z']) {
    for (const value of nonFiniteNumbers) {
      invalidPoints.push(point({ z: 1, [field]: value }))
    }
  }

  for (const invalidPoint of invalidPoints) {
    expectError(
      frame({ keypoints3D: [point({ z: 0 }), invalidPoint] }),
      errors.keypoints3D,
    )
  }
})

test('validates optional scores on 3D points', () => {
  for (const score of nonFiniteNumbers) {
    const payload = frame({ keypoints3D: [point({ z: 1, score })] })

    if (score == null) {
      const result = validatePoseFramePayload(payload)
      assert.equal(result.ok, true)
      assert.equal(result.value.keypoints3D[0].score, score)
    } else {
      expectError(payload, errors.keypoints3D)
    }
  }
})

test('accepts multiple 3D points without requiring correspondence to 2D points', () => {
  const keypoints3D = [
    point({ name: 'left_hip', x: -1, y: 0.5, z: -2, score: 4 }),
    point({ name: 'right_hip', x: 0, y: -4, z: 0, score: null }),
  ]

  const result = validatePoseFramePayload(frame({ keypoints3D }))

  assert.equal(result.ok, true)
  assert.deepStrictEqual(result.value.keypoints3D, keypoints3D)
})

test('requires a finite nonnegative numeric timestamp', () => {
  const missingTime = frame()
  delete missingTime.time
  expectError(missingTime, errors.time)

  for (const time of [...nonFiniteNumbers, -1, -0.001, -Number.MIN_VALUE]) {
    expectError(frame({ time }), errors.time)
  }
})

test('accepts and preserves zero, negative zero, fractional, and large timestamps', () => {
  for (const time of [0, -0, Number.MIN_VALUE, 0.125, Number.MAX_VALUE]) {
    const result = validatePoseFramePayload(frame({ time }))

    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('timestamp validation is independent between calls', () => {
  for (const time of [100, 100, 10, 0]) {
    assert.equal(validatePoseFramePayload(frame({ time })).ok, true)
  }
})

test('reports validation failures in field-validation order', () => {
  expectError(
    { keypoints: [], keypoints3D: {}, time: -1 },
    errors.keypoints,
  )
  expectError(
    { keypoints: [null], keypoints3D: {}, time: -1 },
    errors.keypoint,
  )
  expectError(frame({ keypoints3D: [{}], time: -1 }), errors.keypoints3D)
  expectError(frame({ keypoints3D: [], time: -1 }), errors.time)
})

test('projects supported fields into fresh objects without mutating frozen input', () => {
  const keypoint = Object.freeze(
    point({ name: ' nose ', z: null, score: 0.9, extra: 'discard' }),
  )
  const keypoint3D = Object.freeze(
    point({ z: -3, score: 0.8, extra: 'discard' }),
  )
  const keypoints = Object.freeze([keypoint])
  const keypoints3D = Object.freeze([keypoint3D])
  const payload = Object.freeze(
    frame({ keypoints, keypoints3D, extra: 'discard' }),
  )

  const result = validatePoseFramePayload(payload)

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      time: 100,
      keypoints: [
        { name: ' nose ', x: 10, y: 20, z: null, score: 0.9 },
      ],
      keypoints3D: [
        { name: 'nose', x: 10, y: 20, z: -3, score: 0.8 },
      ],
    },
  })

  assert.notStrictEqual(result.value, payload)
  assert.notStrictEqual(result.value.keypoints, keypoints)
  assert.notStrictEqual(result.value.keypoints[0], keypoint)
  assert.notStrictEqual(result.value.keypoints3D, keypoints3D)
  assert.notStrictEqual(result.value.keypoints3D[0], keypoint3D)

  result.value.keypoints[0].x = 999
  result.value.keypoints3D[0].z = 999
  result.value.keypoints.push(point())
  result.value.keypoints3D.push(point({ z: 1 }))

  assert.equal(keypoint.x, 10)
  assert.equal(keypoint3D.z, -3)
  assert.equal(keypoints.length, 1)
  assert.equal(keypoints3D.length, 1)
  assert.equal(payload.extra, 'discard')
  assert.equal(keypoint.extra, 'discard')
  assert.equal(keypoint3D.extra, 'discard')
})
