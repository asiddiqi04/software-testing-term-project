import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECORDING_MS,
  createPoseRecording,
  createLabelTemplate,
} from '../../frontend/src/lib/poseRecording.js'

const options = {
  id: 'recording-1',
  startedAt: '2026-01-01T12:00:00.000Z',
  originMs: 5000,
  videoTime: 12,
  width: 1280,
  height: 720,
  cameraFps: 60,
  mimeType: 'video/webm',
}

function createRecording(overrides = {}) {
  return createPoseRecording({ ...options, ...overrides })
}

function sample(relativeTime, overrides = {}) {
  return {
    time: options.originMs + relativeTime,
    mediaTime: options.videoTime + relativeTime / 1000,
    keypoints: [],
    keypoints3D: [],
    speed: 0,
    roundRunning: false,
    ...overrides,
  }
}

test('MAX_RECORDING_MS is three minutes', () => {
  assert.equal(MAX_RECORDING_MS, 180000)
})

test('stop exports recording metadata and an empty summary', () => {
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

test('capture computes capture and media timestamps independently', () => {
  const recording = createRecording()
  const frame = recording.capture(
    sample(125.5, {
      mediaTime: options.videoTime + 0.75,
      speed: 3.25,
      roundRunning: true,
    }),
  )

  assert.deepEqual(frame, {
    time: 125.5,
    mediaTimeMs: 750,
    keypoints: [],
    keypoints3D: [],
    speed: 3.25,
    roundRunning: true,
    submittedToClassifier: false,
  })
  assert.equal(recording.frameCount, 1)
})

test('capture permits negative or decreasing media timestamps', () => {
  const recording = createRecording()

  const first = recording.capture(
    sample(0, { mediaTime: options.videoTime + 1 }),
  )
  const second = recording.capture(
    sample(100, { mediaTime: options.videoTime - 0.25 }),
  )

  assert.equal(first.mediaTimeMs, 1000)
  assert.equal(second.mediaTimeMs, -250)
  assert.equal(recording.frameCount, 2)
})

test('capture accepts both time boundaries and rejects times outside them', () => {
  const recording = createRecording()

  assert.equal(recording.capture(sample(-0.5)), null)
  assert.equal(recording.frameCount, 0)

  const first = recording.capture(sample(0))
  assert.equal(first.time, 0)

  assert.equal(recording.capture(sample(MAX_RECORDING_MS + 0.5)), null)
  assert.equal(recording.frameCount, 1)

  const last = recording.capture(sample(MAX_RECORDING_MS))
  assert.equal(last.time, MAX_RECORDING_MS)
  assert.equal(recording.frameCount, 2)

  assert.equal(recording.capture(sample(MAX_RECORDING_MS + 1)), null)
  assert.equal(recording.frameCount, 2)

  assert.deepEqual(
    recording.stop(options.originMs + MAX_RECORDING_MS).frames,
    [first, last],
  )
})

test('capture requires strictly increasing capture times', () => {
  const recording = createRecording()
  const first = recording.capture(sample(100))

  assert.equal(recording.capture(sample(100)), null)
  assert.equal(recording.capture(sample(50)), null)
  assert.equal(recording.frameCount, 1)

  const second = recording.capture(sample(100.25))
  assert.equal(second.time, 100.25)
  assert.equal(recording.frameCount, 2)

  assert.deepEqual(
    recording.stop(options.originMs + 200).frames,
    [first, second],
  )
})

test('capture copies both point arrays and retains only supported fields', () => {
  const recording = createRecording()
  const keypoints = [
    { name: 'nose', x: 10, y: 20, z: -0.1, score: 0.9, extra: 'omit' },
    { name: 'left_wrist', x: 30, y: 40 },
  ]
  const keypoints3D = [
    { name: 'nose', x: 0.1, y: 0.2, z: -0.3, score: 0.8, extra: 'omit' },
  ]

  const frame = recording.capture(sample(0, { keypoints, keypoints3D }))

  assert.notStrictEqual(frame.keypoints, keypoints)
  assert.notStrictEqual(frame.keypoints3D, keypoints3D)
  assert.notStrictEqual(frame.keypoints[0], keypoints[0])
  assert.notStrictEqual(frame.keypoints[1], keypoints[1])
  assert.notStrictEqual(frame.keypoints3D[0], keypoints3D[0])

  keypoints[0].x = 999
  keypoints[1].name = 'changed'
  keypoints.push({ name: 'added' })
  keypoints3D[0].z = 999
  keypoints3D.length = 0

  assert.deepEqual(frame.keypoints, [
    { name: 'nose', x: 10, y: 20, z: -0.1, score: 0.9 },
    {
      name: 'left_wrist',
      x: 30,
      y: 40,
      z: undefined,
      score: undefined,
    },
  ])
  assert.deepEqual(frame.keypoints3D, [
    { name: 'nose', x: 0.1, y: 0.2, z: -0.3, score: 0.8 },
  ])
})

test('missing and null point collections become independent empty arrays', () => {
  const recording = createRecording()
  const missing = recording.capture({
    time: options.originMs,
    mediaTime: options.videoTime,
  })
  const nullable = recording.capture(
    sample(10, { keypoints: null, keypoints3D: null }),
  )

  for (const frame of [missing, nullable]) {
    assert.deepEqual(frame.keypoints, [])
    assert.deepEqual(frame.keypoints3D, [])
    assert.notStrictEqual(frame.keypoints, frame.keypoints3D)
  }

  assert.notStrictEqual(missing.keypoints, nullable.keypoints)
  assert.notStrictEqual(missing.keypoints3D, nullable.keypoints3D)
  assert.equal(missing.speed, undefined)
  assert.equal(missing.roundRunning, undefined)
  assert.equal(nullable.speed, 0)
  assert.equal(nullable.roundRunning, false)
})

test('each capture takes a separate snapshot of reused point data', () => {
  const recording = createRecording()
  const points = [{ name: 'nose', x: 1, y: 2, z: 3, score: 1 }]

  const first = recording.capture(sample(0, { keypoints: points }))
  points[0].x = 4
  const second = recording.capture(sample(100, { keypoints: points }))

  assert.equal(first.keypoints[0].x, 1)
  assert.equal(second.keypoints[0].x, 4)
  assert.notStrictEqual(first.keypoints[0], second.keypoints[0])
})

test('returned frames retain classifier annotations in the completed recording', () => {
  const recording = createRecording()
  const first = recording.capture(sample(0))
  const second = recording.capture(sample(100))

  assert.equal(first.submittedToClassifier, false)
  first.submittedToClassifier = true

  const completed = recording.stop(options.originMs + 200)

  assert.strictEqual(completed.frames[0], first)
  assert.strictEqual(completed.frames[1], second)
  assert.equal(completed.frames[0].submittedToClassifier, true)
  assert.equal(completed.frames[1].submittedToClassifier, false)
})

test('summary counts tracked samples by image points and computes inference FPS', () => {
  const recording = createRecording()
  const point = { name: 'nose', x: 0, y: 0, z: 0, score: 0 }

  recording.capture(sample(100, { keypoints: [point] }))
  recording.capture(sample(200, { keypoints3D: [point] }))
  assert.equal(recording.capture(sample(200)), null)
  recording.capture(sample(500, { keypoints: [point] }))
  recording.capture(sample(1100))

  const completed = recording.stop(options.originMs + 10000)

  assert.equal(completed.durationMs, 10000)
  assert.deepEqual(completed.summary, {
    samples: 4,
    trackedSamples: 2,
    inferenceFps: 3,
  })
  assert.equal(recording.frameCount, 4)
})

test('a single sample has zero inference FPS', () => {
  const recording = createRecording()
  recording.capture(sample(700, { keypoints: [{ name: 'nose' }] }))

  assert.deepEqual(recording.stop(options.originMs + 1000).summary, {
    samples: 1,
    trackedSamples: 1,
    inferenceFps: 0,
  })
})

test('stop clamps negative durations to zero and does not cap long durations', () => {
  for (const [elapsed, expected] of [
    [-100, 0],
    [0, 0],
    [125.5, 125.5],
    [MAX_RECORDING_MS + 5000, MAX_RECORDING_MS + 5000],
  ]) {
    const recording = createRecording()
    assert.equal(
      recording.stop(options.originMs + elapsed).durationMs,
      expected,
    )
  }
})

test('stop is idempotent and prevents further capture', () => {
  const recording = createRecording()
  const frame = recording.capture(sample(100))
  const completed = recording.stop(options.originMs + 250)

  assert.equal(recording.capture(sample(300)), null)
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(options.originMs + 1000), completed)
  assert.strictEqual(recording.stop(options.originMs - 100), completed)
  assert.equal(completed.durationMs, 250)
  assert.deepEqual(completed.frames, [frame])
  assert.equal(completed.summary.samples, 1)
})

test('stopping an empty recording permanently prevents capture', () => {
  const recording = createRecording()
  const completed = recording.stop(options.originMs)

  assert.equal(recording.capture(sample(0)), null)
  assert.equal(recording.capture(sample(100)), null)
  assert.equal(recording.frameCount, 0)
  assert.strictEqual(recording.stop(options.originMs + 100), completed)
  assert.deepEqual(completed.frames, [])
})

test('recordings keep state and timing origins independent', () => {
  const first = createRecording()
  const second = createRecording({
    id: 'recording-2',
    originMs: 9000,
    videoTime: 20,
  })

  first.capture(sample(100))
  first.stop(options.originMs + 200)

  assert.equal(second.frameCount, 0)
  const frame = second.capture({
    time: 9250,
    mediaTime: 20.5,
    speed: 2,
    roundRunning: true,
  })
  const completed = second.stop(9500)

  assert.equal(frame.time, 250)
  assert.equal(frame.mediaTimeMs, 500)
  assert.equal(completed.id, 'recording-2')
  assert.equal(completed.durationMs, 500)
  assert.equal(second.frameCount, 1)
  assert.equal(first.capture(sample(300)), null)
})

test('createLabelTemplate returns the complete labeling schema', () => {
  assert.deepEqual(createLabelTemplate('recording-1'), {
    schemaVersion: 2,
    recordingId: 'recording-1',
    timeUnit: 'video frames',
    fps: 30,
    requiresConstantFpsConversion: true,
    instructions:
      'Convert the exported video to constant 30 FPS before labeling. This is a labeling timebase, not a measured camera or encoding rate. Landmark timestamps remain authoritative.',
    frameIndexBase: 0,
    labels: [],
  })
})

test('label templates preserve the supplied ID and have independent labels', () => {
  const first = createLabelTemplate('first')
  const second = createLabelTemplate('second')

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.labels, second.labels)

  first.labels.push({ startFrame: 0, endFrame: 29, label: 'jab' })

  assert.equal(first.recordingId, 'first')
  assert.equal(second.recordingId, 'second')
  assert.deepEqual(second.labels, [])
  assert.deepEqual(createLabelTemplate('first').labels, [])
})
