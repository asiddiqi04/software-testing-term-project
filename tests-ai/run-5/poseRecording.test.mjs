import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECORDING_MS,
  createPoseRecording,
  createLabelTemplate,
} from '../../frontend/src/lib/poseRecording.js'

const options = {
  id: 'recording-123',
  startedAt: '2026-01-01T12:00:00.000Z',
  originMs: 1000,
  videoTime: 5,
  width: 1280,
  height: 720,
  cameraFps: 60,
  mimeType: 'video/webm',
}

function createRecording(overrides = {}) {
  return createPoseRecording({ ...options, ...overrides })
}

function capture(recording, relativeTime, overrides = {}) {
  return recording.capture({
    time: options.originMs + relativeTime,
    mediaTime: options.videoTime + relativeTime / 1000,
    keypoints: [],
    keypoints3D: [],
    speed: 2,
    roundRunning: true,
    ...overrides,
  })
}

test('MAX_RECORDING_MS is three minutes', () => {
  assert.equal(MAX_RECORDING_MS, 180000)
})

test('stop exports complete recording metadata and an empty summary', () => {
  const recording = createRecording()

  assert.equal(recording.frameCount, 0)
  assert.deepEqual(recording.stop(options.originMs + 2500), {
    schemaVersion: 1,
    id: options.id,
    startedAt: options.startedAt,
    stance: 'orthodox',
    model: {
      name: 'BlazePose',
      runtime: 'tfjs',
      modelType: 'full',
    },
    video: {
      width: options.width,
      height: options.height,
      cameraFps: options.cameraFps,
      mimeType: options.mimeType,
      mirrored: false,
      audio: false,
    },
    coordinates: {
      keypoints: 'image x/y in pixels; z in meters when available',
      keypoints3D: 'world x/y/z in meters',
      sides: 'anatomical',
    },
    timing: {
      unit: 'milliseconds',
      origin: 'MediaRecorder.start call',
      alignment:
        'approximate; browser video encoding may introduce a start offset',
      sampling:
        'every completed pose inference, independently of classifier sampling',
    },
    durationMs: 2500,
    frames: [],
    summary: {
      samples: 0,
      trackedSamples: 0,
      inferenceFps: 0,
    },
  })
})

test('capture stores relative capture time and independently aligned media time', () => {
  const recording = createRecording({
    originMs: 2000,
    videoTime: 12,
  })

  const frame = recording.capture({
    time: 2125.5,
    mediaTime: 12.75,
    keypoints: [{ name: 'nose', x: 100, y: 200, z: -0.1, score: 0.9 }],
    keypoints3D: [{ name: 'nose', x: 0.1, y: 0.2, z: -0.3, score: 0.8 }],
    speed: 0,
    roundRunning: false,
  })

  assert.deepEqual(frame, {
    time: 125.5,
    mediaTimeMs: 750,
    keypoints: [{ name: 'nose', x: 100, y: 200, z: -0.1, score: 0.9 }],
    keypoints3D: [{ name: 'nose', x: 0.1, y: 0.2, z: -0.3, score: 0.8 }],
    speed: 0,
    roundRunning: false,
    submittedToClassifier: false,
  })
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(2500).frames[0], frame)
})

test('capture rejects negative relative times and includes both time boundaries', () => {
  const recording = createRecording()

  assert.equal(capture(recording, -0.5), null)
  assert.equal(recording.frameCount, 0)

  const first = capture(recording, 0)
  const last = capture(recording, MAX_RECORDING_MS)

  assert.equal(first.time, 0)
  assert.equal(last.time, MAX_RECORDING_MS)
  assert.equal(capture(recording, MAX_RECORDING_MS + 0.5), null)
  assert.equal(recording.frameCount, 2)
  assert.deepEqual(
    recording.stop(options.originMs + MAX_RECORDING_MS).frames,
    [first, last],
  )
})

test('an out-of-range capture does not stop recording or advance accepted time', () => {
  const recording = createRecording()

  assert.equal(capture(recording, MAX_RECORDING_MS + 1), null)
  assert.equal(recording.frameCount, 0)
  assert.equal(capture(recording, 100).time, 100)

  assert.equal(capture(recording, MAX_RECORDING_MS + 2), null)
  assert.equal(capture(recording, 200).time, 200)
  assert.equal(recording.frameCount, 2)
})

test('capture requires strictly increasing times, including after a zero-time frame', () => {
  const recording = createRecording()

  assert.equal(capture(recording, 0).time, 0)
  assert.equal(capture(recording, 0), null)
  assert.equal(capture(recording, 10).time, 10)
  assert.equal(capture(recording, 10), null)
  assert.equal(capture(recording, 5), null)
  assert.equal(capture(recording, 10.25).time, 10.25)

  assert.equal(recording.frameCount, 3)
  assert.deepEqual(
    recording.stop(options.originMs + 20).frames.map((frame) => frame.time),
    [0, 10, 10.25],
  )
})

test('capture ordering uses capture time rather than media time', () => {
  const recording = createRecording()
  const first = capture(recording, 10, { mediaTime: 6 })
  const second = capture(recording, 20, { mediaTime: 4.5 })
  const third = capture(recording, 30, { mediaTime: 4.5 })

  assert.equal(first.mediaTimeMs, 1000)
  assert.equal(second.mediaTimeMs, -500)
  assert.equal(third.mediaTimeMs, -500)
  assert.equal(recording.frameCount, 3)
})

test('capture copies both point arrays and retains only supported point fields', () => {
  const recording = createRecording()
  const keypoints = [
    { name: 'nose', x: 10, y: 20, z: 30, score: 0, extra: 'discard' },
    { name: 'left_eye', x: 40, y: 50 },
  ]
  const keypoints3D = [
    { name: 'nose', x: 0.1, y: 0.2, z: 0.3, score: 1, extra: true },
  ]
  const expected2D = [
    { name: 'nose', x: 10, y: 20, z: 30, score: 0 },
    {
      name: 'left_eye',
      x: 40,
      y: 50,
      z: undefined,
      score: undefined,
    },
  ]
  const expected3D = [
    { name: 'nose', x: 0.1, y: 0.2, z: 0.3, score: 1 },
  ]

  const first = capture(recording, 0, { keypoints, keypoints3D })
  const second = capture(recording, 10, { keypoints, keypoints3D })

  assert.deepEqual(first.keypoints, expected2D)
  assert.deepEqual(first.keypoints3D, expected3D)

  for (const field of ['keypoints', 'keypoints3D']) {
    const source = field === 'keypoints' ? keypoints : keypoints3D
    assert.notStrictEqual(first[field], source)
    assert.notStrictEqual(first[field], second[field])
    for (let index = 0; index < source.length; index += 1) {
      assert.notStrictEqual(first[field][index], source[index])
      assert.notStrictEqual(first[field][index], second[field][index])
    }
  }

  keypoints[0].x = 999
  keypoints.push({ name: 'right_eye', x: 1, y: 2 })
  keypoints3D[0].z = 999
  keypoints3D.length = 0

  assert.deepEqual(first.keypoints, expected2D)
  assert.deepEqual(first.keypoints3D, expected3D)
  assert.deepEqual(second.keypoints, expected2D)
  assert.deepEqual(second.keypoints3D, expected3D)

  first.keypoints[1].y = -1
  assert.equal(keypoints[1].y, 50)
  assert.equal(second.keypoints[1].y, 50)
})

test('omitted and null point arrays become independent empty arrays', () => {
  const recording = createRecording()
  const omitted = recording.capture({
    time: options.originMs,
    mediaTime: options.videoTime,
  })
  const nullPoints = capture(recording, 10, {
    keypoints: null,
    keypoints3D: null,
  })

  for (const frame of [omitted, nullPoints]) {
    assert.deepEqual(frame.keypoints, [])
    assert.deepEqual(frame.keypoints3D, [])
    assert.notStrictEqual(frame.keypoints, frame.keypoints3D)
  }

  assert.notStrictEqual(omitted.keypoints, nullPoints.keypoints)
  assert.notStrictEqual(omitted.keypoints3D, nullPoints.keypoints3D)
  assert.equal(omitted.speed, undefined)
  assert.equal(omitted.roundRunning, undefined)
})

test('returned frames allow classifier submission status to be recorded', () => {
  const recording = createRecording()
  const submitted = capture(recording, 0)
  const unsubmitted = capture(recording, 100)

  assert.equal(submitted.submittedToClassifier, false)
  submitted.submittedToClassifier = true

  const result = recording.stop(options.originMs + 200)

  assert.strictEqual(result.frames[0], submitted)
  assert.strictEqual(result.frames[1], unsubmitted)
  assert.equal(result.frames[0].submittedToClassifier, true)
  assert.equal(result.frames[1].submittedToClassifier, false)
})

test('summary counts tracked 2D samples and computes FPS over accepted sample times', () => {
  const recording = createRecording()

  capture(recording, 100, {
    keypoints: [{ name: 'nose', x: 1, y: 2, score: 0 }],
  })
  capture(recording, 200, {
    keypoints3D: [{ name: 'nose', x: 1, y: 2, z: 3 }],
  })
  assert.equal(capture(recording, 200), null)
  assert.equal(capture(recording, 150), null)
  capture(recording, 600, { keypoints: null })
  capture(recording, 1100, {
    keypoints: [
      { name: 'nose', x: 1, y: 2 },
      { name: 'left_eye', x: 3, y: 4 },
    ],
  })

  const result = recording.stop(options.originMs + 5000)

  assert.equal(result.durationMs, 5000)
  assert.equal(recording.frameCount, 4)
  assert.deepEqual(result.summary, {
    samples: 4,
    trackedSamples: 2,
    inferenceFps: 3,
  })
})

test('a single sample has zero inference FPS regardless of tracking status', () => {
  for (const keypoints of [[], [{ name: 'nose', x: 1, y: 2 }]]) {
    const recording = createRecording()
    capture(recording, 250, { keypoints })

    assert.deepEqual(recording.stop(options.originMs + 1000).summary, {
      samples: 1,
      trackedSamples: keypoints.length ? 1 : 0,
      inferenceFps: 0,
    })
  }
})

test('stop clamps negative duration to zero and does not cap positive duration', () => {
  for (const [offset, expected] of [
    [-100, 0],
    [0, 0],
    [12.5, 12.5],
    [MAX_RECORDING_MS + 5000, MAX_RECORDING_MS + 5000],
  ]) {
    const recording = createRecording()
    assert.equal(
      recording.stop(options.originMs + offset).durationMs,
      expected,
    )
  }
})

test('stop is idempotent and permanently rejects further captures', () => {
  const recording = createRecording()
  const frame = capture(recording, 100)
  const completed = recording.stop(options.originMs + 200)

  assert.equal(capture(recording, 300), null)
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(
    recording.stop(options.originMs + MAX_RECORDING_MS),
    completed,
  )
  assert.strictEqual(recording.stop(options.originMs - 1), completed)
  assert.equal(completed.durationMs, 200)
  assert.deepEqual(completed.frames, [frame])
  assert.deepEqual(completed.summary, {
    samples: 1,
    trackedSamples: 0,
    inferenceFps: 0,
  })
})

test('stopping an empty recording also permanently rejects captures', () => {
  const recording = createRecording()
  const completed = recording.stop(options.originMs)

  assert.equal(capture(recording, 0), null)
  assert.equal(capture(recording, 1), null)
  assert.equal(recording.frameCount, 0)
  assert.strictEqual(recording.stop(options.originMs + 100), completed)
  assert.deepEqual(completed.frames, [])
})

test('recording instances maintain independent frames and lifecycle state', () => {
  const first = createRecording({ id: 'first' })
  const second = createRecording({ id: 'second' })

  capture(first, 0)
  const firstResult = first.stop(options.originMs + 10)

  assert.equal(second.frameCount, 0)
  assert.equal(capture(second, 0).time, 0)
  assert.equal(capture(second, 20).time, 20)
  assert.equal(capture(first, 20), null)

  const secondResult = second.stop(options.originMs + 30)

  assert.equal(firstResult.id, 'first')
  assert.equal(secondResult.id, 'second')
  assert.equal(first.frameCount, 1)
  assert.equal(second.frameCount, 2)
  assert.notStrictEqual(firstResult.frames, secondResult.frames)
})

test('createLabelTemplate returns the complete constant-FPS labeling template', () => {
  assert.deepEqual(createLabelTemplate('recording-123'), {
    schemaVersion: 2,
    recordingId: 'recording-123',
    timeUnit: 'video frames',
    fps: 30,
    requiresConstantFpsConversion: true,
    instructions:
      'Convert the exported video to constant 30 FPS before labeling. This is a labeling timebase, not a measured camera or encoding rate. Landmark timestamps remain authoritative.',
    frameIndexBase: 0,
    labels: [],
  })
})

test('createLabelTemplate preserves the supplied ID without substituting a default', () => {
  for (const id of ['another-recording', '', 0, null, undefined]) {
    assert.equal(createLabelTemplate(id).recordingId, id)
  }
})

test('createLabelTemplate returns independent objects and label arrays', () => {
  const first = createLabelTemplate('same-id')
  const second = createLabelTemplate('same-id')

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.labels, second.labels)

  first.labels.push({ start: 0, end: 10, label: 'jab' })
  first.fps = 24

  assert.deepEqual(second.labels, [])
  assert.equal(second.fps, 30)
  assert.deepEqual(createLabelTemplate('same-id'), second)
})
