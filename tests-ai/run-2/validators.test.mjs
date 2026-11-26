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
  x: 0,
  y: -1.5,
  ...overrides,
})

const frame = (overrides = {}) => ({
  time: 0,
  keypoints: [point()],
  ...overrides,
})

const expectInvalid = (payload, message) => {
  assert.deepStrictEqual(validatePoseFramePayload(payload), {
    ok: false,
    message,
  })
}

const nonFiniteNumbers = [
  ['undefined', undefined],
  ['null', null],
  ['numeric string', '1'],
  ['empty string', ''],
  ['true', true],
  ['false', false],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['object', {}],
  ['array', []],
  ['boxed number', new Number(1)],
  ['bigint', 1n],
  ['symbol', Symbol('number')],
  ['function', () => 1],
]

test('accepts a minimal frame and includes undefined optional output fields', () => {
  assert.deepStrictEqual(validatePoseFramePayload(frame()), {
    ok: true,
    value: {
      time: 0,
      keypoints: [
        { name: 'nose', x: 0, y: -1.5, z: undefined, score: undefined },
      ],
      keypoints3D: undefined,
    },
  })
})

test('rejects missing and non-object payloads', () => {
  for (const payload of [
    undefined,
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
    expectInvalid(payload, messages.payload)
  }
})

test('requires a non-empty keypoints array', () => {
  for (const payload of [{}, [], { time: 0 }]) {
    expectInvalid(payload, messages.keypoints)
  }

  for (const keypoints of [
    undefined,
    null,
    [],
    {},
    { 0: point(), length: 1 },
    'nose',
    1,
    false,
    new Set([point()]),
  ]) {
    expectInvalid(frame({ keypoints }), messages.keypoints)
  }
})

test('rejects invalid keypoint entries anywhere in the array', () => {
  for (const invalidPoint of [
    undefined,
    null,
    false,
    true,
    0,
    1,
    'nose',
    [],
    {},
    () => {},
  ]) {
    for (const keypoints of [
      [invalidPoint],
      [point(), invalidPoint],
      [invalidPoint, point()],
    ]) {
      expectInvalid(frame({ keypoints }), messages.keypoint)
    }
  }
})

test('requires a non-blank primitive string name', () => {
  for (const name of [
    undefined,
    null,
    '',
    ' ',
    '\t\n\r',
    '\u00a0',
    0,
    false,
    {},
    [],
    new String('nose'),
    Symbol('nose'),
  ]) {
    expectInvalid(
      frame({ keypoints: [point({ name })] }),
      messages.keypoint,
    )
  }

  const missingName = point()
  delete missingName.name
  expectInvalid(frame({ keypoints: [missingName] }), messages.keypoint)
})

test('preserves valid names without trimming or enforcing uniqueness', () => {
  const keypoints = [
    point({ name: '  nose\t' }),
    point({ name: '鼻' }),
    point({ name: '鼻' }),
  ]
  const result = validatePoseFramePayload(frame({ keypoints }))

  assert.equal(result.ok, true)
  assert.deepStrictEqual(
    result.value.keypoints.map(({ name }) => name),
    ['  nose\t', '鼻', '鼻'],
  )
})

for (const field of ['x', 'y']) {
  test(`requires the ${field} coordinate`, () => {
    const keypoint = point()
    delete keypoint[field]
    expectInvalid(frame({ keypoints: [keypoint] }), messages.keypoint)
  })

  for (const [label, value] of nonFiniteNumbers) {
    test(`rejects ${label} as keypoint ${field}`, () => {
      expectInvalid(
        frame({ keypoints: [point({ [field]: value })] }),
        messages.keypoint,
      )
    })
  }
}

for (const field of ['z', 'score']) {
  test(`allows absent, undefined, and null keypoint ${field}`, () => {
    for (const keypoint of [
      point(),
      point({ [field]: undefined }),
      point({ [field]: null }),
    ]) {
      const result = validatePoseFramePayload(frame({ keypoints: [keypoint] }))
      assert.equal(result.ok, true)
      assert.equal(result.value.keypoints[0][field], keypoint[field])
    }
  })

  for (const [label, value] of nonFiniteNumbers) {
    if (value == null) continue

    test(`rejects ${label} as optional keypoint ${field}`, () => {
      expectInvalid(
        frame({ keypoints: [point({ [field]: value })] }),
        messages.keypoint,
      )
    })
  }
}

test('accepts finite coordinates and scores without range restrictions', () => {
  for (const value of [
    0,
    -0,
    -100,
    0.25,
    100,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]) {
    const result = validatePoseFramePayload(
      frame({
        keypoints: [point({ x: value, y: value, z: value, score: value })],
      }),
    )

    assert.equal(result.ok, true)
    for (const field of ['x', 'y', 'z', 'score']) {
      assert.ok(Object.is(result.value.keypoints[0][field], value))
    }
  }
})

test('allows omitted, undefined, null, and empty keypoints3D', () => {
  for (const payload of [
    frame(),
    frame({ keypoints3D: undefined }),
    frame({ keypoints3D: null }),
    frame({ keypoints3D: [] }),
  ]) {
    const result = validatePoseFramePayload(payload)
    assert.equal(result.ok, true)
    assert.deepStrictEqual(
      result.value.keypoints3D,
      Array.isArray(payload.keypoints3D) ? [] : undefined,
    )
  }
})

test('rejects non-array keypoints3D values', () => {
  for (const keypoints3D of [
    false,
    true,
    0,
    1,
    '',
    'points',
    {},
    { 0: point({ z: 1 }), length: 1 },
    new Set([point({ z: 1 })]),
  ]) {
    expectInvalid(frame({ keypoints3D }), messages.keypoints3D)
  }
})

test('requires every 3D entry to be a valid named keypoint', () => {
  const invalidPoints = [
    undefined,
    null,
    false,
    1,
    'nose',
    [],
    {},
    point({ name: undefined, z: 1 }),
    point({ name: ' \t', z: 1 }),
    point({ name: 1, z: 1 }),
    point({ x: undefined, z: 1 }),
    point({ y: undefined, z: 1 }),
  ]

  for (const field of ['x', 'y', 'score']) {
    for (const [, value] of nonFiniteNumbers) {
      if (field === 'score' && value == null) continue
      invalidPoints.push(point({ z: 1, [field]: value }))
    }
  }

  for (const invalidPoint of invalidPoints) {
    expectInvalid(
      frame({ keypoints3D: [point({ z: 0 }), invalidPoint] }),
      messages.keypoints3D,
    )
  }
})

test('requires an explicit finite z coordinate for 3D points', () => {
  expectInvalid(frame({ keypoints3D: [point()] }), messages.keypoints3D)

  for (const [, z] of nonFiniteNumbers) {
    expectInvalid(
      frame({ keypoints3D: [point({ z })] }),
      messages.keypoints3D,
    )
  }
})

test('accepts valid 3D points with optional scores and independent names', () => {
  const keypoints3D = [
    point({ name: 'left_ankle', z: -2 }),
    point({ name: 'right_ankle', z: 0, score: null }),
    point({ name: 'hip', z: 0.5, score: 2 }),
  ]
  const result = validatePoseFramePayload(frame({ keypoints3D }))

  assert.equal(result.ok, true)
  assert.deepStrictEqual(result.value.keypoints3D, [
    { name: 'left_ankle', x: 0, y: -1.5, z: -2, score: undefined },
    { name: 'right_ankle', x: 0, y: -1.5, z: 0, score: null },
    { name: 'hip', x: 0, y: -1.5, z: 0.5, score: 2 },
  ])
})

test('requires a timestamp', () => {
  const payload = frame()
  delete payload.time
  expectInvalid(payload, messages.time)
})

for (const [label, time] of nonFiniteNumbers) {
  test(`rejects ${label} as timestamp`, () => {
    expectInvalid(frame({ time }), messages.time)
  })
}

test('rejects negative timestamps', () => {
  for (const time of [-1, -0.001, -Number.MIN_VALUE, -Number.MAX_VALUE]) {
    expectInvalid(frame({ time }), messages.time)
  }
})

test('accepts finite nonnegative timestamps and preserves their values', () => {
  for (const time of [0, -0, 0.125, Number.MIN_VALUE, Number.MAX_VALUE]) {
    const result = validatePoseFramePayload(frame({ time }))
    assert.equal(result.ok, true)
    assert.ok(Object.is(result.value.time, time))
  }
})

test('validates timestamps independently across calls', () => {
  for (const time of [100, 100, 50, 0]) {
    const result = validatePoseFramePayload(frame({ time }))
    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('reports validation errors in field-check order', () => {
  expectInvalid(
    frame({ keypoints: [], keypoints3D: false, time: -1 }),
    messages.keypoints,
  )
  expectInvalid(
    frame({ keypoints: [null], keypoints3D: false, time: -1 }),
    messages.keypoint,
  )
  expectInvalid(
    frame({ keypoints3D: [point()], time: -1 }),
    messages.keypoints3D,
  )
  expectInvalid(frame({ time: -1 }), messages.time)
})

test('projects supported fields into fresh objects without mutating input', () => {
  const keypoint = Object.freeze({
    name: 'nose',
    x: 1,
    y: 2,
    z: null,
    score: 0,
    extra: 'discard',
  })
  const point3D = Object.freeze({
    name: 'hip',
    x: 3,
    y: 4,
    z: 5,
    score: 0.8,
    extra: 'discard',
  })
  const payload = Object.freeze({
    time: 12.5,
    keypoints: Object.freeze([keypoint]),
    keypoints3D: Object.freeze([point3D]),
    extra: 'discard',
  })

  const result = validatePoseFramePayload(payload)

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      time: 12.5,
      keypoints: [{ name: 'nose', x: 1, y: 2, z: null, score: 0 }],
      keypoints3D: [{ name: 'hip', x: 3, y: 4, z: 5, score: 0.8 }],
    },
  })

  assert.notStrictEqual(result.value, payload)
  assert.notStrictEqual(result.value.keypoints, payload.keypoints)
  assert.notStrictEqual(result.value.keypoints[0], keypoint)
  assert.notStrictEqual(result.value.keypoints3D, payload.keypoints3D)
  assert.notStrictEqual(result.value.keypoints3D[0], point3D)

  result.value.keypoints[0].x = 99
  result.value.keypoints3D[0].z = 99
  result.value.keypoints.push(point())

  assert.equal(keypoint.x, 1)
  assert.equal(point3D.z, 5)
  assert.equal(payload.keypoints.length, 1)
  assert.equal(payload.extra, 'discard')
  assert.equal(keypoint.extra, 'discard')
  assert.equal(point3D.extra, 'discard')
})
