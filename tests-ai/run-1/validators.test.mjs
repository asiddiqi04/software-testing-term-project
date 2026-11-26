import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePoseFramePayload } from '../../frontend/src/training/validators.js'

const messages = {
  payload: 'Pose frame must be an object.',
  keypoints: 'keypoints must be a non-empty array.',
  point: 'Each keypoint must include name, numeric x, and numeric y values.',
  points3D: 'keypoints3D must contain named points with numeric x, y, and z values.',
  time: 'A monotonic frame timestamp is required.',
}

const point = (overrides = {}) => ({
  name: 'nose',
  x: 0.25,
  y: 0.75,
  ...overrides,
})

const payload = (overrides = {}) => ({
  time: 100,
  keypoints: [point()],
  ...overrides,
})

const expectFailure = (input, message) => {
  assert.deepEqual(validatePoseFramePayload(input), { ok: false, message })
}

const invalidNumbers = [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  '1',
  '',
  true,
  false,
  1n,
  Symbol('number'),
  {},
  [],
  new Number(1),
]

test('accepts a minimal frame and includes optional output properties', () => {
  assert.deepEqual(validatePoseFramePayload(payload()), {
    ok: true,
    value: {
      time: 100,
      keypoints: [
        {
          name: 'nose',
          x: 0.25,
          y: 0.75,
          z: undefined,
          score: undefined,
        },
      ],
      keypoints3D: undefined,
    },
  })
})

test('rejects missing and non-object payloads', () => {
  expectFailure(undefined, messages.payload)
  for (const value of [
    null,
    false,
    true,
    0,
    1,
    '',
    'frame',
    1n,
    Symbol('frame'),
    () => {},
  ]) {
    expectFailure(value, messages.payload)
  }
})

test('requires a non-empty keypoints array', () => {
  expectFailure({}, messages.keypoints)

  for (const keypoints of [
    undefined,
    null,
    [],
    {},
    { 0: point(), length: 1 },
    'points',
    1,
    true,
    new Set([point()]),
  ]) {
    expectFailure(payload({ keypoints }), messages.keypoints)
  }
})

test('rejects invalid keypoint entries anywhere in the array', () => {
  for (const invalid of [
    undefined,
    null,
    false,
    true,
    0,
    1,
    '',
    'nose',
    1n,
    Symbol('point'),
    () => {},
    {},
    [],
  ]) {
    expectFailure(payload({ keypoints: [invalid] }), messages.point)
    expectFailure(payload({ keypoints: [point(), invalid] }), messages.point)
    expectFailure(payload({ keypoints: [invalid, point()] }), messages.point)
  }
})

test('requires each keypoint to have a nonblank primitive string name', () => {
  for (const name of [
    undefined,
    null,
    '',
    ' ',
    '\t\r\n',
    0,
    true,
    {},
    [],
    Symbol('name'),
    new String('nose'),
  ]) {
    expectFailure(payload({ keypoints: [point({ name })] }), messages.point)
  }
})

test('preserves valid names without trimming or normalizing them', () => {
  for (const name of ['nose', '  left wrist\t', '膝']) {
    const result = validatePoseFramePayload(
      payload({ keypoints: [point({ name })] }),
    )

    assert.equal(result.ok, true)
    assert.equal(result.value.keypoints[0].name, name)
  }
})

for (const field of ['x', 'y']) {
  test(`requires ${field} to be a finite primitive number`, () => {
    for (const value of invalidNumbers) {
      expectFailure(
        payload({ keypoints: [point({ [field]: value })] }),
        messages.point,
      )
    }
  })
}

test('accepts finite coordinates without imposing a coordinate range', () => {
  for (const value of [
    0,
    -0,
    -100,
    100,
    0.125,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]) {
    const result = validatePoseFramePayload(
      payload({ keypoints: [point({ x: value, y: value })] }),
    )

    assert.equal(result.ok, true)
    assert.equal(result.value.keypoints[0].x, value)
    assert.equal(result.value.keypoints[0].y, value)
  }
})

for (const field of ['z', 'score']) {
  test(`accepts absent, null, and finite ${field} values in 2D points`, () => {
    for (const value of [
      undefined,
      null,
      0,
      -0,
      -10,
      0.5,
      10,
      Number.MAX_VALUE,
    ]) {
      const result = validatePoseFramePayload(
        payload({ keypoints: [point({ [field]: value })] }),
      )

      assert.equal(result.ok, true)
      assert.equal(result.value.keypoints[0][field], value)
    }
  })

  test(`rejects non-nullish invalid ${field} values in 2D points`, () => {
    for (const value of invalidNumbers.filter((value) => value != null)) {
      expectFailure(
        payload({ keypoints: [point({ [field]: value })] }),
        messages.point,
      )
    }
  })
}

test('accepts omitted, undefined, null, and empty keypoints3D', () => {
  assert.equal(validatePoseFramePayload(payload()).ok, true)

  for (const keypoints3D of [undefined, null, []]) {
    const result = validatePoseFramePayload(payload({ keypoints3D }))

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.value.keypoints3D,
      Array.isArray(keypoints3D) ? [] : undefined,
    )
  }
})

test('rejects non-array, non-nullish keypoints3D', () => {
  for (const keypoints3D of [
    false,
    true,
    0,
    '',
    'points',
    {},
    { 0: point({ z: 1 }), length: 1 },
    new Set([point({ z: 1 })]),
  ]) {
    expectFailure(payload({ keypoints3D }), messages.points3D)
  }
})

test('requires every 3D point to be valid and have a finite z', () => {
  const valid = point({ z: 1 })
  const invalidPoints = [
    undefined,
    null,
    false,
    1,
    'point',
    {},
    [],
    point(),
    point({ name: '' , z: 1 }),
    point({ name: ' \t', z: 1 }),
    point({ name: 123, z: 1 }),
  ]

  for (const field of ['x', 'y', 'z']) {
    for (const value of invalidNumbers) {
      invalidPoints.push(point({ z: 1, [field]: value }))
    }
  }

  for (const score of invalidNumbers.filter((value) => value != null)) {
    invalidPoints.push(point({ z: 1, score }))
  }

  for (const invalid of invalidPoints) {
    expectFailure(
      payload({ keypoints3D: [invalid] }),
      messages.points3D,
    )
    expectFailure(
      payload({ keypoints3D: [valid, invalid] }),
      messages.points3D,
    )
    expectFailure(
      payload({ keypoints3D: [invalid, valid] }),
      messages.points3D,
    )
  }
})

test('accepts finite 3D coordinates and optional scores without range limits', () => {
  const keypoints3D = [
    point({ x: -10, y: 20, z: 0 }),
    point({ name: 'wrist', z: -2.5, score: null }),
    point({ name: 'ankle', z: Number.MAX_VALUE, score: -3 }),
    point({ name: 'hip', z: -Number.MAX_VALUE, score: 2 }),
  ]
  const result = validatePoseFramePayload(payload({ keypoints3D }))

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.value.keypoints3D,
    keypoints3D.map(({ name, x, y, z, score }) => ({
      name,
      x,
      y,
      z,
      score,
    })),
  )
})

test('requires a finite nonnegative timestamp', () => {
  for (const time of [...invalidNumbers, -1, -0.001, -Number.MIN_VALUE]) {
    expectFailure(payload({ time }), messages.time)
  }

  const input = payload()
  delete input.time
  expectFailure(input, messages.time)
})

test('preserves valid timestamps, including zero and fractional values', () => {
  for (const time of [0, -0, Number.MIN_VALUE, 0.5, 123.456, Number.MAX_VALUE]) {
    const result = validatePoseFramePayload(payload({ time }))

    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('validates timestamps independently across calls', () => {
  for (const time of [100, 100, 50, 0]) {
    assert.equal(validatePoseFramePayload(payload({ time })).ok, true)
  }
})

test('copies supported fields, preserves order, and leaves input untouched', () => {
  const first = Object.freeze({
    name: '  nose  ',
    x: 1,
    y: 2,
    z: null,
    score: 0,
    extra: 'discard',
  })
  const second = Object.freeze({
    name: 'wrist',
    x: 3,
    y: 4,
    extra: 'discard',
  })
  const third = Object.freeze({
    name: 'hip',
    x: 5,
    y: 6,
    z: 7,
    score: 0.8,
    extra: 'discard',
  })
  const fourth = Object.freeze({
    name: 'ankle',
    x: 8,
    y: 9,
    z: 10,
  })
  const input = Object.freeze({
    time: 12.5,
    keypoints: Object.freeze([first, second]),
    keypoints3D: Object.freeze([third, fourth]),
    extra: 'discard',
  })

  const result = validatePoseFramePayload(input)

  assert.deepEqual(result, {
    ok: true,
    value: {
      time: 12.5,
      keypoints: [
        { name: '  nose  ', x: 1, y: 2, z: null, score: 0 },
        { name: 'wrist', x: 3, y: 4, z: undefined, score: undefined },
      ],
      keypoints3D: [
        { name: 'hip', x: 5, y: 6, z: 7, score: 0.8 },
        { name: 'ankle', x: 8, y: 9, z: 10, score: undefined },
      ],
    },
  })

  assert.notStrictEqual(result.value, input)
  for (const field of ['keypoints', 'keypoints3D']) {
    assert.notStrictEqual(result.value[field], input[field])
    for (let index = 0; index < input[field].length; index += 1) {
      assert.notStrictEqual(result.value[field][index], input[field][index])
    }
  }

  result.value.keypoints[0].x = 999
  result.value.keypoints3D[0].z = 999
  result.value.keypoints.push(point())
  result.value.keypoints3D.pop()

  assert.equal(first.x, 1)
  assert.equal(third.z, 7)
  assert.equal(input.keypoints.length, 2)
  assert.equal(input.keypoints3D.length, 2)
  assert.equal(input.extra, 'discard')
  assert.equal(first.extra, 'discard')
  assert.equal(third.extra, 'discard')
})

test('reports validation failures in the defined order', () => {
  expectFailure(
    { keypoints: [], keypoints3D: false, time: -1 },
    messages.keypoints,
  )
  expectFailure(
    { keypoints: [{}], keypoints3D: false, time: -1 },
    messages.point,
  )
  expectFailure(
    payload({ keypoints3D: [{}], time: -1 }),
    messages.points3D,
  )
  expectFailure(
    payload({ keypoints3D: [point({ z: 1 })], time: -1 }),
    messages.time,
  )
})
