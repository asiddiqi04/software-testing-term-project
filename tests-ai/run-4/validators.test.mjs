import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePoseFramePayload } from '../../frontend/src/training/validators.js'

const messages = {
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

const assertInvalid = (payload, message) => {
  assert.deepStrictEqual(validatePoseFramePayload(payload), {
    ok: false,
    message,
  })
}

const nonFiniteNumbers = [
  ['undefined', undefined],
  ['null', null],
  ['numeric string', '12'],
  ['empty string', ''],
  ['true', true],
  ['false', false],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['object', {}],
  ['array', []],
  ['boxed number', new Number(12)],
  ['bigint', 12n],
  ['symbol', Symbol('number')],
  ['function', () => 12],
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

for (const [label, payload] of [
  ['undefined', undefined],
  ['null', null],
  ['false', false],
  ['true', true],
  ['zero', 0],
  ['number', 42],
  ['NaN', NaN],
  ['empty string', ''],
  ['string', 'frame'],
  ['bigint', 1n],
  ['symbol', Symbol('frame')],
  ['function', () => {}],
]) {
  test(`rejects a non-object payload: ${label}`, () => {
    assertInvalid(payload, messages.payload)
  })
}

test('rejects an object without keypoints', () => {
  assertInvalid({ time: 100 }, messages.keypoints)
})

for (const [label, keypoints] of [
  ['undefined', undefined],
  ['null', null],
  ['empty array', []],
  ['object', {}],
  ['array-like object', { 0: point(), length: 1 }],
  ['string', 'nose'],
  ['number', 1],
  ['boolean', true],
  ['typed array', new Float32Array([1, 2])],
]) {
  test(`rejects invalid keypoints container: ${label}`, () => {
    assertInvalid(frame({ keypoints }), messages.keypoints)
  })
}

const invalidPoints = [
  ['undefined', undefined],
  ['null', null],
  ['false', false],
  ['number', 1],
  ['string', 'nose'],
  ['empty object', {}],
  ['empty array', []],
  ['function', () => {}],
  ...[
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', ' \t\n '],
    ['number', 1],
    ['boolean', true],
    ['boxed string', new String('nose')],
    ['object', {}],
    ['symbol', Symbol('nose')],
  ].map(([label, name]) => [`name is ${label}`, point({ name })]),
  ...['x', 'y', 'z', 'score'].flatMap((field) =>
    nonFiniteNumbers
      .filter(
        ([, value]) =>
          !((field === 'z' || field === 'score') && value == null),
      )
      .map(([label, value]) => [
        `${field} is ${label}`,
        point({ [field]: value }),
      ]),
  ),
]

for (const [label, invalidPoint] of invalidPoints) {
  test(`rejects an invalid 2D keypoint: ${label}`, () => {
    assertInvalid(
      frame({ keypoints: [point(), invalidPoint, point({ name: 'ankle' })] }),
      messages.keypoint,
    )
  })
}

for (const field of ['name', 'x', 'y']) {
  test(`rejects a keypoint missing required field ${field}`, () => {
    const keypoint = point()
    delete keypoint[field]
    assertInvalid(frame({ keypoints: [keypoint] }), messages.keypoint)
  })
}

for (const optional of [undefined, null]) {
  test(`accepts ${String(optional)} z and score on 2D keypoints`, () => {
    const keypoint = point({ z: optional, score: optional })
    const result = validatePoseFramePayload(frame({ keypoints: [keypoint] }))

    assert.equal(result.ok, true)
    assert.deepStrictEqual(result.value.keypoints, [keypoint])
  })
}

test('accepts finite coordinates and scores without imposing ranges', () => {
  const keypoints = [
    point({
      name: ' nose ',
      x: -Number.MAX_VALUE,
      y: Number.MAX_VALUE,
      z: -Number.MIN_VALUE,
      score: -10,
    }),
    point({ name: '足首', x: 0, y: -0, z: 0, score: 2 }),
    point({ name: 'fractional', x: 0.25, y: -0.75, z: 1.5, score: 0 }),
  ]

  const result = validatePoseFramePayload(frame({ keypoints }))

  assert.equal(result.ok, true)
  assert.deepStrictEqual(result.value.keypoints, keypoints)
})

for (const [label, keypoints3D, expected] of [
  ['undefined', undefined, undefined],
  ['null', null, undefined],
  ['empty array', [], []],
]) {
  test(`accepts ${label} keypoints3D`, () => {
    const result = validatePoseFramePayload(frame({ keypoints3D }))

    assert.equal(result.ok, true)
    assert.deepStrictEqual(result.value.keypoints3D, expected)
  })
}

for (const [label, keypoints3D] of [
  ['object', {}],
  ['array-like object', { 0: point({ z: 1 }), length: 1 }],
  ['string', 'points'],
  ['number', 1],
  ['zero', 0],
  ['false', false],
  ['true', true],
  ['typed array', new Float32Array([1, 2, 3])],
]) {
  test(`rejects invalid keypoints3D container: ${label}`, () => {
    assertInvalid(frame({ keypoints3D }), messages.keypoints3D)
  })
}

for (const [label, invalidPoint] of invalidPoints) {
  test(`rejects an invalid 3D keypoint: ${label}`, () => {
    const candidate =
      invalidPoint && typeof invalidPoint === 'object'
        ? { z: 1, ...invalidPoint }
        : invalidPoint

    assertInvalid(
      frame({ keypoints3D: [point({ z: 1 }), candidate] }),
      messages.keypoints3D,
    )
  })
}

for (const [label, z] of nonFiniteNumbers) {
  test(`rejects a 3D keypoint whose z is ${label}`, () => {
    assertInvalid(
      frame({ keypoints3D: [point({ z })] }),
      messages.keypoints3D,
    )
  })
}

test('requires z on every 3D keypoint', () => {
  assertInvalid(frame({ keypoints3D: [point()] }), messages.keypoints3D)
})

test('accepts 3D points with optional scores and independent names and counts', () => {
  const keypoints3D = [
    point({ name: 'hip', z: 0, score: undefined }),
    point({ name: 'heel', z: -3.5, score: null }),
    point({ name: 'toe', z: Number.MAX_VALUE, score: 1.5 }),
  ]

  const result = validatePoseFramePayload(frame({ keypoints3D }))

  assert.equal(result.ok, true)
  assert.deepStrictEqual(result.value.keypoints3D, keypoints3D)
})

for (const [label, time] of [
  ...nonFiniteNumbers,
  ['negative integer', -1],
  ['negative fraction', -0.5],
  ['smallest negative magnitude', -Number.MIN_VALUE],
]) {
  test(`rejects invalid timestamp: ${label}`, () => {
    assertInvalid(frame({ time }), messages.time)
  })
}

test('rejects a missing timestamp', () => {
  assertInvalid({ keypoints: [point()] }, messages.time)
})

for (const time of [0, -0, Number.MIN_VALUE, 0.5, 42, Number.MAX_VALUE]) {
  test(`accepts a finite nonnegative timestamp: ${Object.is(time, -0) ? '-0' : time}`, () => {
    const result = validatePoseFramePayload(frame({ time }))

    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  })
}

test('validates timestamps independently across calls', () => {
  for (const time of [100, 100, 1, 0]) {
    const result = validatePoseFramePayload(frame({ time }))
    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('reports errors in validation order', () => {
  assertInvalid(
    { keypoints: [], keypoints3D: false, time: -1 },
    messages.keypoints,
  )
  assertInvalid(
    { keypoints: [null], keypoints3D: false, time: -1 },
    messages.keypoint,
  )
  assertInvalid(
    frame({ keypoints3D: [point()], time: -1 }),
    messages.keypoints3D,
  )
  assertInvalid(
    frame({ keypoints3D: [point({ z: 1 })], time: -1 }),
    messages.time,
  )
})

test('copies supported fields, preserves order, and does not mutate the input', () => {
  const first = Object.freeze(
    point({ name: ' wrist ', z: null, score: 0, extra: 'discard' }),
  )
  const second = Object.freeze(
    point({ name: 'elbow', x: -1, y: 0.5, extra: 'discard' }),
  )
  const third = Object.freeze(
    point({ name: 'hip', z: -2, score: null, extra: 'discard' }),
  )
  const payload = Object.freeze({
    time: 12.5,
    keypoints: Object.freeze([first, second]),
    keypoints3D: Object.freeze([third]),
    extra: 'discard',
  })

  const result = validatePoseFramePayload(payload)

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      time: 12.5,
      keypoints: [
        { name: ' wrist ', x: 10, y: 20, z: null, score: 0 },
        { name: 'elbow', x: -1, y: 0.5, z: undefined, score: undefined },
      ],
      keypoints3D: [
        { name: 'hip', x: 10, y: 20, z: -2, score: null },
      ],
    },
  })

  assert.notStrictEqual(result.value, payload)
  assert.notStrictEqual(result.value.keypoints, payload.keypoints)
  assert.notStrictEqual(result.value.keypoints3D, payload.keypoints3D)
  assert.notStrictEqual(result.value.keypoints[0], first)
  assert.notStrictEqual(result.value.keypoints[1], second)
  assert.notStrictEqual(result.value.keypoints3D[0], third)

  result.value.keypoints[0].x = 999
  result.value.keypoints3D[0].z = 999
  result.value.keypoints.push(point())
  result.value.keypoints3D.length = 0

  assert.equal(first.x, 10)
  assert.equal(third.z, -2)
  assert.equal(payload.keypoints.length, 2)
  assert.equal(payload.keypoints3D.length, 1)
  assert.equal(payload.extra, 'discard')
  assert.equal(first.extra, 'discard')
})

test('returns fresh arrays and point objects for repeated validation', () => {
  const payload = frame({ keypoints3D: [point({ z: 1 })] })
  const first = validatePoseFramePayload(payload)
  const second = validatePoseFramePayload(payload)

  assert.deepStrictEqual(first, second)
  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.value, second.value)
  assert.notStrictEqual(first.value.keypoints, second.value.keypoints)
  assert.notStrictEqual(first.value.keypoints[0], second.value.keypoints[0])
  assert.notStrictEqual(first.value.keypoints3D, second.value.keypoints3D)
  assert.notStrictEqual(first.value.keypoints3D[0], second.value.keypoints3D[0])
})
