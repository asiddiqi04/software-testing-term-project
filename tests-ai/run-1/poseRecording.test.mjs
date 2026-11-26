import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECORDING_MS,
  createPoseRecording,
  createLabelTemplate,
} from '../../frontend/src/lib/poseRecording.js'

const options = {
  id: 'recording-123',
  startedAt: '2026-11-25T12:00:00.000Z',
  originMs: 1000,
  videoTime: 10,
  width: 1280,
  height: 720,
  cameraFps: 60,
  mimeType: 'video/webm',
}

const sample = (time, overrides = {}) => ({
  time,
  mediaTime: 10,
  keypoints: [],
  keypoints3D: [],
  speed: 1.5,
  roundRunning: true,
  ...overrides,
})

test('MAX_RECORDING_MS is three minutes', () => {
  assert.equal(MAX_RECORDING_MS, 180000)
})

test('an empty recording exports complete metadata and zeroed summary', () => {
  const recording = createPoseRecording(options)

  assert.equal(recording.frameCount, 0)
  assert.deepEqual(recording.stop(options.originMs), {
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
    durationMs: 0,
    frames: [],
    summary: {
      samples: 0,
      trackedSamples: 0,
      inferenceFps: 0,
    },
  })
})

test('capture converts capture and media times using their respective origins', () => {
  const recording = createPoseRecording(options)
  const frame = recording.capture(
    sample(1125, {
      mediaTime: 10.5,
      speed: 0,
      roundRunning: false,
    }),
  )

  assert.deepEqual(frame, {
    time: 125,
    mediaTimeMs: 500,
    keypoints: [],
    keypoints3D: [],
    speed: 0,
    roundRunning: false,
    submittedToClassifier: false,
  })
  assert.equal(recording.frameCount, 1)

  const result = recording.stop(1500)
  assert.equal(result.durationMs, 500)
  assert.strictEqual(result.frames[0], frame)
})

test('capture preserves fractional capture times and negative media offsets', () => {
  const recording = createPoseRecording({
    ...options,
    originMs: 2000.25,
    videoTime: 4.5,
  })

  const frame = recording.capture(
    sample(2000.75, { mediaTime: 4.25 }),
  )

  assert.equal(frame.time, 0.5)
  assert.equal(frame.mediaTimeMs, -250)
})

test('capture copies point arrays and retains only supported point properties', () => {
  const recording = createPoseRecording(options)
  const keypoints = [
    {
      name: 'left_wrist',
      x: 100,
      y: 200,
      z: -0.25,
      score: 0.9,
      extra: 'discard',
    },
    { name: 'right_wrist', x: 300, y: 400 },
  ]
  const keypoints3D = [
    {
      name: 'left_wrist',
      x: 0.1,
      y: 0.2,
      z: 0.3,
      score: 0.8,
      extra: 'discard',
    },
  ]
  const expected2D = [
    { name: 'left_wrist', x: 100, y: 200, z: -0.25, score: 0.9 },
    {
      name: 'right_wrist',
      x: 300,
      y: 400,
      z: undefined,
      score: undefined,
    },
  ]
  const expected3D = [
    { name: 'left_wrist', x: 0.1, y: 0.2, z: 0.3, score: 0.8 },
  ]

  const frame = recording.capture(
    sample(1000, { keypoints, keypoints3D }),
  )

  assert.deepEqual(frame.keypoints, expected2D)
  assert.deepEqual(frame.keypoints3D, expected3D)
  assert.notStrictEqual(frame.keypoints, keypoints)
  assert.notStrictEqual(frame.keypoints3D, keypoints3D)
  for (let i = 0; i < keypoints.length; i += 1) {
    assert.notStrictEqual(frame.keypoints[i], keypoints[i])
  }
  assert.notStrictEqual(frame.keypoints3D[0], keypoints3D[0])

  keypoints[0].x = 999
  keypoints.push({ name: 'nose', x: 1, y: 2 })
  keypoints3D[0].z = 999
  keypoints3D.length = 0

  assert.deepEqual(frame.keypoints, expected2D)
  assert.deepEqual(frame.keypoints3D, expected3D)

  const result = recording.stop(1100)
  assert.deepEqual(result.frames[0].keypoints, expected2D)
  assert.deepEqual(result.frames[0].keypoints3D, expected3D)
})

test('omitted and null point arrays become distinct empty arrays', () => {
  const recording = createPoseRecording(options)
  const omitted = recording.capture({ time: 1000, mediaTime: 10 })
  const explicitNull = recording.capture(
    sample(1001, { keypoints: null, keypoints3D: null }),
  )

  for (const frame of [omitted, explicitNull]) {
    assert.deepEqual(frame.keypoints, [])
    assert.deepEqual(frame.keypoints3D, [])
    assert.notStrictEqual(frame.keypoints, frame.keypoints3D)
  }
  assert.notStrictEqual(omitted.keypoints, explicitNull.keypoints)
  assert.notStrictEqual(omitted.keypoints3D, explicitNull.keypoints3D)
  assert.equal(omitted.speed, undefined)
  assert.equal(omitted.roundRunning, undefined)
  assert.equal(recording.stop(1100).summary.trackedSamples, 0)
})

test('capture accepts both time boundaries and rejects times outside them', () => {
  const recording = createPoseRecording(options)

  assert.equal(recording.capture(sample(999)), null)
  assert.equal(recording.frameCount, 0)

  const first = recording.capture(sample(1000))
  assert.equal(first.time, 0)

  assert.equal(
    recording.capture(sample(1000 + MAX_RECORDING_MS + 1)),
    null,
  )
  assert.equal(recording.frameCount, 1)

  const last = recording.capture(sample(1000 + MAX_RECORDING_MS))
  assert.equal(last.time, MAX_RECORDING_MS)
  assert.equal(recording.frameCount, 2)

  assert.equal(
    recording.capture(sample(1000 + MAX_RECORDING_MS + 2)),
    null,
  )
  assert.equal(recording.frameCount, 2)
  assert.deepEqual(
    recording.stop(1000 + MAX_RECORDING_MS).frames,
    [first, last],
  )
})

test('capture rejects duplicate and decreasing capture times without advancing state', () => {
  const recording = createPoseRecording(options)
  const first = recording.capture(sample(1100))

  assert.equal(recording.capture(sample(1100)), null)
  assert.equal(recording.capture(sample(1050)), null)
  assert.equal(recording.capture(sample(999)), null)
  assert.equal(recording.frameCount, 1)

  const second = recording.capture(sample(1101))
  assert.equal(second.time, 101)
  assert.equal(recording.frameCount, 2)
  assert.deepEqual(recording.stop(1200).frames, [first, second])
})

test('capture ordering depends on capture time, independently of media time', () => {
  const recording = createPoseRecording(options)
  const first = recording.capture(sample(1000, { mediaTime: 12 }))
  const second = recording.capture(sample(1100, { mediaTime: 11 }))
  const third = recording.capture(sample(1200, { mediaTime: 11 }))

  assert.equal(recording.frameCount, 3)
  assert.deepEqual(
    [first, second, third].map(({ time, mediaTimeMs }) => ({
      time,
      mediaTimeMs,
    })),
    [
      { time: 0, mediaTimeMs: 2000 },
      { time: 100, mediaTimeMs: 1000 },
      { time: 200, mediaTimeMs: 1000 },
    ],
  )
})

test('returned frames allow classifier submission annotations to be exported', () => {
  const recording = createPoseRecording(options)
  const first = recording.capture(sample(1000))
  const second = recording.capture(sample(1100))

  assert.equal(first.submittedToClassifier, false)
  assert.equal(second.submittedToClassifier, false)

  first.submittedToClassifier = true
  const result = recording.stop(1200)

  assert.strictEqual(result.frames[0], first)
  assert.equal(result.frames[0].submittedToClassifier, true)
  assert.equal(result.frames[1].submittedToClassifier, false)
})

test('summary counts image-keypoint samples and uses first-to-last inference timing', () => {
  const recording = createPoseRecording(options)

  recording.capture(
    sample(1100, { keypoints: [{ name: 'nose', x: 1, y: 2 }] }),
  )
  recording.capture(
    sample(1300, {
      keypoints3D: [{ name: 'nose', x: 0.1, y: 0.2, z: 0.3 }],
    }),
  )
  recording.capture(
    sample(1400, {
      keypoints: [{ name: 'nose', x: 3, y: 4, score: 0 }],
      roundRunning: false,
    }),
  )
  recording.capture(sample(1700))

  assert.equal(recording.capture(sample(1700)), null)
  assert.equal(recording.capture(sample(1500)), null)

  const result = recording.stop(6000)
  assert.equal(result.durationMs, 5000)
  assert.equal(recording.frameCount, 4)
  assert.deepEqual(result.summary, {
    samples: 4,
    trackedSamples: 2,
    inferenceFps: 5,
  })
})

test('a single sample has zero inference FPS', () => {
  for (const keypoints of [[], [{ name: 'nose', x: 1, y: 2 }]]) {
    const recording = createPoseRecording(options)
    recording.capture(sample(1250, { keypoints }))

    assert.deepEqual(recording.stop(2000).summary, {
      samples: 1,
      trackedSamples: keypoints.length ? 1 : 0,
      inferenceFps: 0,
    })
  }
})

test('stop clamps negative duration to zero and does not cap long durations', () => {
  for (const [stopTime, expectedDuration] of [
    [900, 0],
    [1000, 0],
    [1000.5, 0.5],
    [1000 + MAX_RECORDING_MS + 5000, MAX_RECORDING_MS + 5000],
  ]) {
    const recording = createPoseRecording(options)
    assert.equal(recording.stop(stopTime).durationMs, expectedDuration)
  }
})

test('stop is idempotent and prevents further captures', () => {
  const recording = createPoseRecording(options)
  const frame = recording.capture(sample(1100))
  const completed = recording.stop(1200)

  assert.equal(recording.capture(sample(1300)), null)
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(9000), completed)
  assert.strictEqual(recording.stop(900), completed)
  assert.equal(completed.durationMs, 200)
  assert.deepEqual(completed.frames, [frame])
  assert.deepEqual(completed.summary, {
    samples: 1,
    trackedSamples: 0,
    inferenceFps: 0,
  })
})

test('stopping an empty recording permanently closes it', () => {
  const recording = createPoseRecording(options)
  const completed = recording.stop(900)

  assert.equal(recording.capture(sample(1000)), null)
  assert.equal(recording.frameCount, 0)
  assert.strictEqual(recording.stop(2000), completed)
  assert.equal(completed.durationMs, 0)
  assert.deepEqual(completed.frames, [])
})

test('recording instances have independent state and configuration', () => {
  const first = createPoseRecording(options)
  const second = createPoseRecording({
    ...options,
    id: 'second-recording',
    originMs: 5000,
    videoTime: 20,
    width: 640,
    height: 480,
    cameraFps: 24,
    mimeType: 'video/mp4',
  })

  first.capture(sample(1000))
  const firstResult = first.stop(1100)

  assert.equal(second.frameCount, 0)
  const secondFrame = second.capture(
    sample(5250, { mediaTime: 20.5 }),
  )
  const secondResult = second.stop(5500)

  assert.equal(secondFrame.time, 250)
  assert.equal(secondFrame.mediaTimeMs, 500)
  assert.equal(secondResult.id, 'second-recording')
  assert.equal(secondResult.durationMs, 500)
  assert.deepEqual(secondResult.video, {
    width: 640,
    height: 480,
    cameraFps: 24,
    mimeType: 'video/mp4',
    mirrored: false,
    audio: false,
  })
  assert.notStrictEqual(firstResult.frames, secondResult.frames)
  assert.equal(firstResult.frames.length, 1)
  assert.equal(firstResult.id, options.id)
})

test('createLabelTemplate exports the complete constant-FPS labeling template', () => {
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

test('label templates are fresh objects with independent labels arrays', () => {
  const first = createLabelTemplate('first')
  const second = createLabelTemplate('second')
  const sameId = createLabelTemplate('first')

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first, sameId)
  assert.notStrictEqual(first.labels, second.labels)
  assert.notStrictEqual(first.labels, sameId.labels)

  first.labels.push({ start: 0, end: 29, label: 'jab' })
  first.fps = 24

  assert.equal(second.recordingId, 'second')
  assert.equal(sameId.recordingId, 'first')
  assert.equal(second.fps, 30)
  assert.equal(sameId.fps, 30)
  assert.deepEqual(second.labels, [])
  assert.deepEqual(sameId.labels, [])
})
