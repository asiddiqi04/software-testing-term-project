import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePoseFramePayload } from '../../frontend/src/training/validators.js'

const messages = {
  payload: 'Pose frame must be an object.',
  keypoints: 'keypoints must be a non-empty array.',
  point: 'Each keypoint must include name, numeric x, and numeric y values.',
  points3D:
    'keypoints3D must contain named points with numeric x, y, and z values.',
  time: 'A monotonic frame timestamp is required.',
}

const point = (overrides = {}) => ({
  name: 'left_shoulder',
  x: 0.25,
  y: 0.75,
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

const invalidNumbers = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['numeric string', '1'],
  ['empty string', ''],
  ['boolean true', true],
  ['boolean false', false],
  ['array', []],
  ['object', {}],
  ['boxed number', new Number(1)],
  ['bigint', 1n],
  ['symbol', Symbol('number')],
]

test('accepts a minimal frame and includes optional output properties', () => {
  assert.deepStrictEqual(
    validatePoseFramePayload({
      time: 0,
      keypoints: [{ name: 'nose', x: 0, y: 0 }],
    }),
    {
      ok: true,
      value: {
        time: 0,
        keypoints: [
          { name: 'nose', x: 0, y: 0, z: undefined, score: undefined },
        ],
        keypoints3D: undefined,
      },
    },
  )
})

test('rejects missing and non-object payloads', () => {
  assertInvalid(undefined, messages.payload)

  for (const payload of [
    null,
    false,
    true,
    0,
    42,
    NaN,
    '',
    'frame',
    1n,
    Symbol('frame'),
    () => {},
  ]) {
    assertInvalid(payload, messages.payload)
  }
})

test('requires a non-empty keypoints array', () => {
  assertInvalid({}, messages.keypoints)
  assertInvalid([], messages.keypoints)

  for (const keypoints of [
    undefined,
    null,
    [],
    {},
    { 0: point(), length: 1 },
    'keypoints',
    1,
    false,
    new Set([point()]),
  ]) {
    assertInvalid(frame({ keypoints }), messages.keypoints)
  }
})

test('rejects non-object keypoints and objects missing required fields', () => {
  for (const keypoint of [
    undefined,
    null,
    false,
    true,
    0,
    'nose',
    1n,
    Symbol('point'),
    () => {},
    [],
    {},
    { name: 'nose' },
    { name: 'nose', x: 1 },
    { name: 'nose', y: 1 },
    { x: 1, y: 1 },
  ]) {
    assertInvalid(frame({ keypoints: [keypoint] }), messages.point)
  }
})

test('requires a primitive string name containing non-whitespace text', () => {
  for (const name of [
    undefined,
    null,
    '',
    ' ',
    '\t\n\r',
    '\u00a0',
    123,
    false,
    [],
    {},
    new String('nose'),
    Symbol('nose'),
  ]) {
    assertInvalid(frame({ keypoints: [point({ name })] }), messages.point)
  }
})

for (const field of ['x', 'y']) {
  for (const [label, value] of invalidNumbers) {
    test(`rejects ${label} for keypoint ${field}`, () => {
      assertInvalid(
        frame({ keypoints: [point({ [field]: value })] }),
        messages.point,
      )
    })
  }
}

for (const field of ['z', 'score']) {
  test(`allows omitted, undefined, and null keypoint ${field}`, () => {
    for (const keypoint of [
      point(),
      point({ [field]: undefined }),
      point({ [field]: null }),
    ]) {
      const result = validatePoseFramePayload(frame({ keypoints: [keypoint] }))
      assert.equal(result.ok, true)
      assert.equal(result.value.keypoints[0][field], keypoint[field])
      assert.equal(Object.hasOwn(result.value.keypoints[0], field), true)
    }
  })

  for (const [label, value] of invalidNumbers.filter(
    ([, value]) => value != null,
  )) {
    test(`rejects ${label} for optional keypoint ${field}`, () => {
      assertInvalid(
        frame({ keypoints: [point({ [field]: value })] }),
        messages.point,
      )
    })
  }
}

test('accepts finite coordinates and scores without range restrictions', () => {
  for (const value of [
    -Number.MAX_VALUE,
    -10.5,
    -0,
    0,
    Number.MIN_VALUE,
    1.5,
    Number.MAX_VALUE,
  ]) {
    const keypoint = point({ x: value, y: value, z: value, score: value })
    const result = validatePoseFramePayload(frame({ keypoints: [keypoint] }))
    assert.equal(result.ok, true)
    assert.deepStrictEqual(result.value.keypoints, [keypoint])
  }
})

test('preserves names verbatim and allows duplicate names', () => {
  const keypoints = [
    point({ name: '  鼻 \t' }),
    point({ name: '  鼻 \t', x: 2 }),
  ]
  const result = validatePoseFramePayload(frame({ keypoints }))
  assert.equal(result.ok, true)
  assert.deepStrictEqual(
    result.value.keypoints.map(({ name }) => name),
    ['  鼻 \t', '  鼻 \t'],
  )
})

test('validates every 2D keypoint regardless of position', () => {
  for (let index = 0; index < 3; index += 1) {
    const keypoints = [point(), point(), point()]
    keypoints[index] = point({ y: NaN })
    assertInvalid(frame({ keypoints }), messages.point)
  }
})

test('allows omitted, undefined, null, and empty keypoints3D', () => {
  for (const payload of [
    frame(),
    frame({ keypoints3D: undefined }),
    frame({ keypoints3D: null }),
  ]) {
    const result = validatePoseFramePayload(payload)
    assert.equal(result.ok, true)
    assert.equal(result.value.keypoints3D, undefined)
    assert.equal(Object.hasOwn(result.value, 'keypoints3D'), true)
  }

  const result = validatePoseFramePayload(frame({ keypoints3D: [] }))
  assert.equal(result.ok, true)
  assert.deepStrictEqual(result.value.keypoints3D, [])
})

test('rejects non-array keypoints3D when supplied', () => {
  for (const keypoints3D of [
    false,
    0,
    '',
    'points',
    {},
    { 0: point({ z: 1 }), length: 1 },
    new Set([point({ z: 1 })]),
  ]) {
    assertInvalid(frame({ keypoints3D }), messages.points3D)
  }
})

test('requires valid named 3D points', () => {
  for (const keypoint of [
    undefined,
    null,
    false,
    1,
    'nose',
    [],
    {},
    point({ name: '' }),
    point({ name: ' \t', z: 1 }),
    point({ name: 1, z: 1 }),
  ]) {
    assertInvalid(frame({ keypoints3D: [keypoint] }), messages.points3D)
  }
})

for (const field of ['x', 'y', 'z']) {
  for (const [label, value] of invalidNumbers) {
    test(`rejects ${label} for 3D keypoint ${field}`, () => {
      assertInvalid(
        frame({ keypoints3D: [point({ z: 1, [field]: value })] }),
        messages.points3D,
      )
    })
  }
}

test('requires z on 3D points even when omitted entirely', () => {
  assertInvalid(frame({ keypoints3D: [point()] }), messages.points3D)
})

test('validates optional 3D scores', () => {
  for (const score of [undefined, null, -2, 0, 0.5, 2]) {
    const result = validatePoseFramePayload(
      frame({ keypoints3D: [point({ z: -3, score })] }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.value.keypoints3D[0].score, score)
  }

  for (const [, score] of invalidNumbers.filter(([, value]) => value != null)) {
    assertInvalid(
      frame({ keypoints3D: [point({ z: 1, score })] }),
      messages.points3D,
    )
  }
})

test('validates every 3D keypoint regardless of position', () => {
  for (let index = 0; index < 3; index += 1) {
    const keypoints3D = [point({ z: 1 }), point({ z: 2 }), point({ z: 3 })]
    keypoints3D[index] = point({ z: Infinity })
    assertInvalid(frame({ keypoints3D }), messages.points3D)
  }
})

test('does not require 2D and 3D points to match in name or count', () => {
  const result = validatePoseFramePayload(
    frame({
      keypoints3D: [
        point({ name: 'right_hip', z: -1 }),
        point({ name: 'left_knee', z: 0 }),
      ],
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.value.keypoints.length, 1)
  assert.equal(result.value.keypoints3D.length, 2)
})

for (const [label, time] of invalidNumbers) {
  test(`rejects ${label} as a timestamp`, () => {
    assertInvalid(frame({ time }), messages.time)
  })
}

test('rejects omitted and negative timestamps', () => {
  assertInvalid({ keypoints: [point()] }, messages.time)
  for (const time of [-Number.MIN_VALUE, -1, -Number.MAX_VALUE]) {
    assertInvalid(frame({ time }), messages.time)
  }
})

test('accepts finite nonnegative timestamps and preserves their values', () => {
  for (const time of [0, -0, Number.MIN_VALUE, 0.5, 1234, Number.MAX_VALUE]) {
    const result = validatePoseFramePayload(frame({ time }))
    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('does not track timestamp monotonicity across calls', () => {
  for (const time of [100, 100, 5, 0]) {
    const result = validatePoseFramePayload(frame({ time }))
    assert.equal(result.ok, true)
    assert.equal(result.value.time, time)
  }
})

test('reports validation failures in field-validation order', () => {
  assertInvalid(
    { keypoints: [], keypoints3D: false, time: -1 },
    messages.keypoints,
  )
  assertInvalid(
    frame({ keypoints: [null], keypoints3D: false, time: -1 }),
    messages.point,
  )
  assertInvalid(frame({ keypoints3D: false, time: -1 }), messages.points3D)
  assertInvalid(frame({ keypoints3D: [], time: -1 }), messages.time)
})

test('projects supported properties, preserves ordering, and copies input data', () => {
  const payload = Object.freeze({
    time: 42.5,
    extra: 'discard',
    keypoints: Object.freeze([
      Object.freeze({ name: 'nose', x: 1, y: 2, extra: 'discard' }),
      Object.freeze({
        name: 'hip',
        x: -3,
        y: 4,
        z: null,
        score: 0.8,
      }),
    ]),
    keypoints3D: Object.freeze([
      Object.freeze({
        name: 'ankle',
        x: 5,
        y: 6,
        z: -7,
        score: null,
        extra: 'discard',
      }),
      Object.freeze({ name: 'knee', x: 8, y: 9, z: 0 }),
    ]),
  })

  const result = validatePoseFramePayload(payload)
  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      time: 42.5,
      keypoints: [
        { name: 'nose', x: 1, y: 2, z: undefined, score: undefined },
        { name: 'hip', x: -3, y: 4, z: null, score: 0.8 },
      ],
      keypoints3D: [
        { name: 'ankle', x: 5, y: 6, z: -7, score: null },
        { name: 'knee', x: 8, y: 9, z: 0, score: undefined },
      ],
    },
  })

  assert.notStrictEqual(result.value, payload)
  for (const field of ['keypoints', 'keypoints3D']) {
    assert.notStrictEqual(result.value[field], payload[field])
    for (let index = 0; index < payload[field].length; index += 1) {
      assert.notStrictEqual(result.value[field][index], payload[field][index])
    }
  }

  result.value.time = 99
  result.value.keypoints[0].x = 99
  result.value.keypoints3D[0].z = 99
  result.value.keypoints.push(point())
  result.value.keypoints3D.pop()

  assert.equal(payload.time, 42.5)
  assert.equal(payload.keypoints[0].x, 1)
  assert.equal(payload.keypoints3D[0].z, -7)
  assert.equal(payload.keypoints.length, 2)
  assert.equal(payload.keypoints3D.length, 2)
})

test('later input mutations do not change a validated result', () => {
  const payload = frame({ keypoints3D: [point({ z: 3 })] })
  const result = validatePoseFramePayload(payload)
  assert.equal(result.ok, true)

  payload.time = 200
  payload.keypoints[0].name = 'changed'
  payload.keypoints3D[0].z = 10
  payload.keypoints.length = 0
  payload.keypoints3D.length = 0

  assert.equal(result.value.time, 100)
  assert.equal(result.value.keypoints.length, 1)
  assert.equal(result.value.keypoints[0].name, 'left_shoulder')
  assert.equal(result.value.keypoints3D.length, 1)
  assert.equal(result.value.keypoints3D[0].z, 3)
})
