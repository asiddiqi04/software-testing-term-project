import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECORDING_MS,
  createPoseRecording,
  createLabelTemplate,
} from '../../frontend/src/lib/poseRecording.js'

const defaults = {
  id: 'recording-123',
  startedAt: '2026-01-02T03:04:05.000Z',
  originMs: 1000,
  videoTime: 10,
  width: 1280,
  height: 720,
  cameraFps: 60,
  mimeType: 'video/webm',
}

const makeRecording = (overrides = {}) =>
  createPoseRecording({ ...defaults, ...overrides })

const capture = (recording, overrides = {}) =>
  recording.capture({
    time: defaults.originMs,
    mediaTime: defaults.videoTime,
    keypoints: [],
    keypoints3D: [],
    speed: 0,
    roundRunning: false,
    ...overrides,
  })

test('MAX_RECORDING_MS is three minutes in milliseconds', () => {
  assert.equal(MAX_RECORDING_MS, 180000)
})

test('a new recording is empty and stop exports complete metadata', () => {
  const recording = makeRecording()

  assert.equal(recording.frameCount, 0)
  assert.deepEqual(recording.stop(defaults.originMs), {
    schemaVersion: 1,
    id: defaults.id,
    startedAt: defaults.startedAt,
    stance: 'orthodox',
    model: {
      name: 'BlazePose',
      runtime: 'tfjs',
      modelType: 'full',
    },
    video: {
      width: defaults.width,
      height: defaults.height,
      cameraFps: defaults.cameraFps,
      mimeType: defaults.mimeType,
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
    durationMs: 0,
    frames: [],
    summary: {
      samples: 0,
      trackedSamples: 0,
      inferenceFps: 0,
    },
  })
})

test('capture uses the supplied capture and video origins independently', () => {
  const recording = makeRecording({ originMs: 2500, videoTime: 20 })
  const frame = capture(recording, {
    time: 2625.5,
    mediaTime: 20.25,
    speed: 7.5,
    roundRunning: true,
  })

  assert.deepEqual(frame, {
    time: 125.5,
    mediaTimeMs: 250,
    keypoints: [],
    keypoints3D: [],
    speed: 7.5,
    roundRunning: true,
    submittedToClassifier: false,
  })
  assert.equal(recording.frameCount, 1)
  assert.equal(recording.stop(3000).durationMs, 500)
})

test('capture accepts both recording boundaries and rejects times outside them', () => {
  const recording = makeRecording()

  assert.equal(capture(recording, { time: defaults.originMs - 0.5 }), null)
  assert.equal(recording.frameCount, 0)

  const first = capture(recording)
  assert.equal(first.time, 0)

  assert.equal(
    capture(recording, {
      time: defaults.originMs + MAX_RECORDING_MS + 0.5,
    }),
    null,
  )
  assert.equal(recording.frameCount, 1)

  const last = capture(recording, {
    time: defaults.originMs + MAX_RECORDING_MS,
  })
  assert.equal(last.time, MAX_RECORDING_MS)
  assert.equal(recording.frameCount, 2)

  assert.equal(
    capture(recording, {
      time: defaults.originMs + MAX_RECORDING_MS + 1,
    }),
    null,
  )
  assert.deepEqual(
    recording.stop(defaults.originMs + MAX_RECORDING_MS).frames,
    [first, last],
  )
})

test('capture requires strictly increasing capture times', () => {
  const recording = makeRecording()
  const first = capture(recording, { time: 1100 })

  assert.equal(capture(recording, { time: 1100, mediaTime: 11 }), null)
  assert.equal(capture(recording, { time: 1050, mediaTime: 12 }), null)
  assert.equal(recording.frameCount, 1)

  const second = capture(recording, { time: 1100.5 })
  assert.equal(second.time, 100.5)
  assert.equal(recording.frameCount, 2)
  assert.deepEqual(recording.stop(1200).frames, [first, second])
})

test('media times may be negative, repeated, or decreasing without rejecting samples', () => {
  const recording = makeRecording()

  const first = capture(recording, { time: 1000, mediaTime: 9.75 })
  const second = capture(recording, { time: 1100, mediaTime: 9.75 })
  const third = capture(recording, { time: 1200, mediaTime: 9.5 })

  assert.equal(first.mediaTimeMs, -250)
  assert.equal(second.mediaTimeMs, -250)
  assert.equal(third.mediaTimeMs, -500)
  assert.equal(recording.frameCount, 3)
})

test('capture copies both landmark arrays and retains only supported fields', () => {
  const recording = makeRecording()
  const imagePoint = {
    name: 'left_wrist',
    x: 100,
    y: 200,
    z: -0.25,
    score: 0.9,
    extra: 'discard',
  }
  const worldPoint = {
    name: 'left_wrist',
    x: 0.1,
    y: 0.2,
    z: -0.3,
    score: 0.8,
    visibility: 1,
  }
  const keypoints = [imagePoint]
  const keypoints3D = [worldPoint]
  const frame = capture(recording, { keypoints, keypoints3D })

  assert.notStrictEqual(frame.keypoints, keypoints)
  assert.notStrictEqual(frame.keypoints3D, keypoints3D)
  assert.notStrictEqual(frame.keypoints[0], imagePoint)
  assert.notStrictEqual(frame.keypoints3D[0], worldPoint)

  imagePoint.x = 999
  worldPoint.z = 999
  keypoints.push({ name: 'right_wrist' })
  keypoints3D.length = 0

  assert.deepEqual(frame.keypoints, [
    { name: 'left_wrist', x: 100, y: 200, z: -0.25, score: 0.9 },
  ])
  assert.deepEqual(frame.keypoints3D, [
    { name: 'left_wrist', x: 0.1, y: 0.2, z: -0.3, score: 0.8 },
  ])

  const exportedFrame = recording.stop(1100).frames[0]
  assert.strictEqual(exportedFrame, frame)
})

test('each capture snapshots reused landmark inputs separately', () => {
  const recording = makeRecording()
  const keypoints = [{ name: 'nose', x: 1, y: 2, z: 3, score: 0.5 }]
  const first = capture(recording, { keypoints })

  keypoints[0].x = 10
  const second = capture(recording, { time: 1100, keypoints })
  keypoints[0].x = 20

  assert.equal(first.keypoints[0].x, 1)
  assert.equal(second.keypoints[0].x, 10)
  assert.notStrictEqual(first.keypoints, second.keypoints)
  assert.notStrictEqual(first.keypoints[0], second.keypoints[0])
})

test('missing and null landmark arrays become separate empty arrays', () => {
  const recording = makeRecording()
  const missing = recording.capture({
    time: 1000,
    mediaTime: 10,
  })
  const explicitUndefined = capture(recording, {
    time: 1100,
    keypoints: undefined,
    keypoints3D: undefined,
  })
  const explicitNull = capture(recording, {
    time: 1200,
    keypoints: null,
    keypoints3D: null,
  })

  for (const frame of [missing, explicitUndefined, explicitNull]) {
    assert.deepEqual(frame.keypoints, [])
    assert.deepEqual(frame.keypoints3D, [])
    assert.notStrictEqual(frame.keypoints, frame.keypoints3D)
  }
  assert.notStrictEqual(missing.keypoints, explicitUndefined.keypoints)
  assert.notStrictEqual(explicitUndefined.keypoints, explicitNull.keypoints)
  assert.equal(missing.speed, undefined)
  assert.equal(missing.roundRunning, undefined)
  assert.equal(recording.stop(1300).summary.trackedSamples, 0)
})

test('landmark copying preserves order, zero values, nulls, and missing fields', () => {
  const recording = makeRecording()
  const frame = capture(recording, {
    keypoints: [
      { name: 'nose', x: 0, y: 0, z: 0, score: 0 },
      { name: 'left_eye', x: null, y: 5 },
      {},
    ],
  })

  assert.deepEqual(frame.keypoints, [
    { name: 'nose', x: 0, y: 0, z: 0, score: 0 },
    {
      name: 'left_eye',
      x: null,
      y: 5,
      z: undefined,
      score: undefined,
    },
    {
      name: undefined,
      x: undefined,
      y: undefined,
      z: undefined,
      score: undefined,
    },
  ])
})

test('returned frames can be marked as submitted to the classifier', () => {
  const recording = makeRecording()
  const first = capture(recording)
  const second = capture(recording, { time: 1100 })

  assert.equal(first.submittedToClassifier, false)
  assert.equal(second.submittedToClassifier, false)

  first.submittedToClassifier = true
  const completed = recording.stop(1200)

  assert.strictEqual(completed.frames[0], first)
  assert.strictEqual(completed.frames[1], second)
  assert.equal(completed.frames[0].submittedToClassifier, true)
  assert.equal(completed.frames[1].submittedToClassifier, false)
})

test('summary counts image-tracked samples and computes FPS from capture endpoints', () => {
  const recording = makeRecording()

  capture(recording, {
    time: 1100,
    mediaTime: 10,
    keypoints: [{ name: 'nose', score: 0 }],
    roundRunning: false,
  })
  capture(recording, {
    time: 1150,
    mediaTime: 20,
    keypoints: [],
    keypoints3D: [{ name: 'nose', x: 1, y: 2, z: 3 }],
  })
  capture(recording, {
    time: 1300,
    mediaTime: 30,
    keypoints: [
      { name: 'left_wrist' },
      { name: 'right_wrist' },
    ],
    roundRunning: true,
  })
  capture(recording, { time: 1600, mediaTime: 40 })

  assert.equal(capture(recording, { time: 1500 }), null)

  const completed = recording.stop(11000)
  assert.equal(completed.durationMs, 10000)
  assert.deepEqual(completed.summary, {
    samples: 4,
    trackedSamples: 2,
    inferenceFps: 6,
  })
})

test('a single sample has zero inference FPS', () => {
  const recording = makeRecording()
  capture(recording, {
    time: 1500,
    keypoints: [{ name: 'nose' }],
  })

  assert.deepEqual(recording.stop(3000).summary, {
    samples: 1,
    trackedSamples: 1,
    inferenceFps: 0,
  })
})

test('stop is idempotent and permanently prevents further captures', () => {
  const recording = makeRecording()
  const frame = capture(recording)
  const completed = recording.stop(1500)

  assert.equal(capture(recording, { time: 1600 }), null)
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(900), completed)
  assert.strictEqual(recording.stop(10000), completed)
  assert.equal(completed.durationMs, 500)
  assert.deepEqual(completed.frames, [frame])
  assert.deepEqual(completed.summary, {
    samples: 1,
    trackedSamples: 0,
    inferenceFps: 0,
  })
})

test('stop clamps negative durations to zero, including for empty recordings', () => {
  const recording = makeRecording()
  const completed = recording.stop(defaults.originMs - 100)

  assert.equal(completed.durationMs, 0)
  assert.deepEqual(completed.frames, [])
  assert.equal(capture(recording), null)
  assert.equal(recording.frameCount, 0)
  assert.strictEqual(recording.stop(defaults.originMs + 100), completed)
})

test('stop duration is not capped at the maximum capture duration', () => {
  const recording = makeRecording()
  capture(recording, { time: defaults.originMs + MAX_RECORDING_MS })

  const durationMs = MAX_RECORDING_MS + 1234.5
  const completed = recording.stop(defaults.originMs + durationMs)

  assert.equal(completed.durationMs, durationMs)
  assert.equal(completed.frames[0].time, MAX_RECORDING_MS)
})

test('recording instances have independent state and metadata', () => {
  const first = makeRecording({ id: 'first' })
  const second = makeRecording({
    id: 'second',
    width: 640,
    height: 480,
    cameraFps: 24,
    mimeType: 'video/mp4',
  })

  capture(first)
  const firstCompleted = first.stop(1100)

  assert.equal(second.frameCount, 0)
  assert.notEqual(capture(second), null)
  assert.notEqual(capture(second, { time: 1200 }), null)

  const secondCompleted = second.stop(1300)
  assert.equal(firstCompleted.id, 'first')
  assert.equal(secondCompleted.id, 'second')
  assert.equal(first.frameCount, 1)
  assert.equal(second.frameCount, 2)
  assert.notStrictEqual(firstCompleted.frames, secondCompleted.frames)
  assert.deepEqual(secondCompleted.video, {
    width: 640,
    height: 480,
    cameraFps: 24,
    mimeType: 'video/mp4',
    mirrored: false,
    audio: false,
  })
})

test('createLabelTemplate returns the complete constant-30-FPS labeling schema', () => {
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

test('label templates and their label arrays are independent between calls', () => {
  const first = createLabelTemplate('same-id')
  const second = createLabelTemplate('same-id')

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.labels, second.labels)

  first.labels.push({ frame: 0, label: 'jab' })
  first.fps = 60
  first.recordingId = 'changed'

  assert.deepEqual(second.labels, [])
  assert.equal(second.fps, 30)
  assert.equal(second.recordingId, 'same-id')
  assert.equal(createLabelTemplate('different-id').recordingId, 'different-id')
})
