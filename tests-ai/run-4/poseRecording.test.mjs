import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECORDING_MS,
  createPoseRecording,
  createLabelTemplate,
} from '../../frontend/src/lib/poseRecording.js'

const options = {
  id: 'recording-123',
  startedAt: '2026-11-26T12:00:00.000Z',
  originMs: 1000,
  videoTime: 5,
  width: 1280,
  height: 720,
  cameraFps: 60,
  mimeType: 'video/webm',
}

const makeRecording = (overrides = {}) =>
  createPoseRecording({ ...options, ...overrides })

const captureAt = (recording, relativeTime, overrides = {}) =>
  recording.capture({
    time: options.originMs + relativeTime,
    mediaTime: options.videoTime + relativeTime / 1000,
    keypoints: [],
    keypoints3D: [],
    speed: 1,
    roundRunning: false,
    ...overrides,
  })

test('MAX_RECORDING_MS is three minutes', () => {
  assert.equal(MAX_RECORDING_MS, 180000)
})

test('stop exports recording metadata and an empty summary', () => {
  const recording = makeRecording()

  assert.equal(recording.frameCount, 0)
  assert.deepEqual(recording.stop(options.originMs + 250), {
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
    durationMs: 250,
    frames: [],
    summary: {
      samples: 0,
      trackedSamples: 0,
      inferenceFps: 0,
    },
  })
})

test('capture returns a sample with independent capture and media timestamps', () => {
  const recording = makeRecording()
  const keypoints = [
    { name: 'nose', x: 10, y: 20, z: 0.1, score: 0.9 },
  ]
  const keypoints3D = [
    { name: 'nose', x: 0.2, y: 0.3, z: -0.4, score: 0.8 },
  ]

  const frame = captureAt(recording, 125, {
    mediaTime: 5.75,
    keypoints,
    keypoints3D,
    speed: 2.5,
    roundRunning: true,
  })

  assert.deepEqual(frame, {
    time: 125,
    mediaTimeMs: 750,
    keypoints,
    keypoints3D,
    speed: 2.5,
    roundRunning: true,
    submittedToClassifier: false,
  })
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(1500).frames[0], frame)
})

test('capture retains negative and nonmonotonic media offsets', () => {
  const recording = makeRecording()
  const first = captureAt(recording, 0, { mediaTime: 4.5 })
  const second = captureAt(recording, 1, { mediaTime: 4.25 })
  const third = captureAt(recording, 2, { mediaTime: 4.25 })

  assert.equal(first.mediaTimeMs, -500)
  assert.equal(second.mediaTimeMs, -750)
  assert.equal(third.mediaTimeMs, -750)
  assert.equal(recording.frameCount, 3)
})

test('capture accepts both time boundaries and rejects samples outside them', () => {
  const recording = makeRecording()

  assert.equal(captureAt(recording, -0.5), null)
  assert.equal(recording.frameCount, 0)

  const first = captureAt(recording, 0)
  assert.equal(first.time, 0)

  assert.equal(captureAt(recording, MAX_RECORDING_MS + 0.5), null)
  assert.equal(recording.frameCount, 1)

  const last = captureAt(recording, MAX_RECORDING_MS)
  assert.equal(last.time, MAX_RECORDING_MS)
  assert.equal(recording.frameCount, 2)

  assert.deepEqual(
    recording.stop(options.originMs + MAX_RECORDING_MS).frames,
    [first, last],
  )
})

test('capture requires strictly increasing times and rejection leaves ordering intact', () => {
  const recording = makeRecording()

  assert.equal(captureAt(recording, 10.25).time, 10.25)
  assert.equal(captureAt(recording, 10.25), null)
  assert.equal(captureAt(recording, 5), null)
  assert.equal(recording.frameCount, 1)

  assert.equal(captureAt(recording, 10.5).time, 10.5)
  assert.equal(recording.frameCount, 2)
  assert.deepEqual(
    recording.stop(1100).frames.map((frame) => frame.time),
    [10.25, 10.5],
  )
})

test('capture copies both point arrays and retains only supported point fields', () => {
  const recording = makeRecording()
  const sourcePoint = {
    name: 'left_wrist',
    x: 12,
    y: 34,
    z: -0.5,
    score: 0.95,
    extra: 'discard me',
  }
  const keypoints = [{ ...sourcePoint }]
  const keypoints3D = [{ ...sourcePoint }]
  const expectedPoint = {
    name: 'left_wrist',
    x: 12,
    y: 34,
    z: -0.5,
    score: 0.95,
  }

  const first = captureAt(recording, 0, { keypoints, keypoints3D })
  const second = captureAt(recording, 10, { keypoints, keypoints3D })

  for (const field of ['keypoints', 'keypoints3D']) {
    const source = field === 'keypoints' ? keypoints : keypoints3D
    assert.notStrictEqual(first[field], source)
    assert.notStrictEqual(first[field][0], source[0])
    assert.notStrictEqual(first[field], second[field])
    assert.notStrictEqual(first[field][0], second[field][0])
    assert.deepEqual(first[field], [expectedPoint])
  }

  keypoints[0].x = 999
  keypoints.push({ name: 'nose' })
  keypoints3D[0].z = 999
  keypoints3D.length = 0

  assert.deepEqual(first.keypoints, [expectedPoint])
  assert.deepEqual(first.keypoints3D, [expectedPoint])
  assert.deepEqual(second.keypoints, [expectedPoint])
  assert.deepEqual(second.keypoints3D, [expectedPoint])

  first.keypoints[0].y = -100
  first.keypoints3D[0].y = -100
  assert.equal(keypoints[0].y, 34)
  assert.deepEqual(second.keypoints, [expectedPoint])
  assert.deepEqual(second.keypoints3D, [expectedPoint])
})

test('capture preserves point order and includes missing point fields as undefined', () => {
  const recording = makeRecording()
  const points = [
    { name: 'left_wrist', x: 0, y: 0, score: 0 },
    { name: 'right_wrist', x: -5, y: 10, z: null },
  ]

  const frame = captureAt(recording, 0, {
    keypoints: points,
    keypoints3D: points,
  })
  const expected = [
    { name: 'left_wrist', x: 0, y: 0, z: undefined, score: 0 },
    { name: 'right_wrist', x: -5, y: 10, z: null, score: undefined },
  ]

  assert.deepEqual(frame.keypoints, expected)
  assert.deepEqual(frame.keypoints3D, expected)
})

test('omitted and null point arrays become separate empty arrays', () => {
  const recording = makeRecording()
  const omitted = recording.capture({
    time: options.originMs,
    mediaTime: options.videoTime,
  })
  const nullPoints = captureAt(recording, 1, {
    keypoints: null,
    keypoints3D: null,
    speed: 0,
    roundRunning: false,
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
  assert.equal(nullPoints.speed, 0)
  assert.equal(nullPoints.roundRunning, false)
})

test('returned frames allow classifier submission annotations to be exported', () => {
  const recording = makeRecording()
  const first = captureAt(recording, 0)
  const second = captureAt(recording, 50)

  assert.equal(first.submittedToClassifier, false)
  assert.equal(second.submittedToClassifier, false)

  first.submittedToClassifier = true
  const completed = recording.stop(1100)

  assert.strictEqual(completed.frames[0], first)
  assert.equal(completed.frames[0].submittedToClassifier, true)
  assert.equal(completed.frames[1].submittedToClassifier, false)
})

test('summary counts all samples and tracks only nonempty image keypoints', () => {
  const recording = makeRecording()

  captureAt(recording, 100, {
    keypoints: [{ name: 'nose', x: 1, y: 2, score: 0 }],
  })
  captureAt(recording, 150, {
    keypoints: [],
    keypoints3D: [{ name: 'nose', x: 0, y: 0, z: 0 }],
  })
  captureAt(recording, 300, { keypoints: null })
  captureAt(recording, 700, {
    keypoints: [{ name: 'left_wrist' }, { name: 'right_wrist' }],
  })

  assert.equal(captureAt(recording, 300), null)

  const completed = recording.stop(options.originMs + 10000)

  assert.equal(completed.durationMs, 10000)
  assert.deepEqual(completed.summary, {
    samples: 4,
    trackedSamples: 2,
    inferenceFps: 5,
  })
  assert.equal(recording.frameCount, 4)
})

test('a single inference sample has zero inference FPS', () => {
  const recording = makeRecording()

  captureAt(recording, 500, {
    keypoints: [{ name: 'nose', x: 0, y: 0 }],
  })

  assert.deepEqual(recording.stop(2000).summary, {
    samples: 1,
    trackedSamples: 1,
    inferenceFps: 0,
  })
})

test('stop clamps negative durations to zero and does not cap positive durations', () => {
  for (const [offset, expectedDuration] of [
    [-100, 0],
    [0, 0],
    [12.5, 12.5],
    [MAX_RECORDING_MS + 1000, MAX_RECORDING_MS + 1000],
  ]) {
    const completed = makeRecording().stop(options.originMs + offset)
    assert.equal(completed.durationMs, expectedDuration)
  }
})

test('stop is idempotent and permanently rejects subsequent capture', () => {
  const recording = makeRecording()
  const frame = captureAt(recording, 100)
  const completed = recording.stop(options.originMs + 500)

  assert.equal(captureAt(recording, 200), null)
  assert.equal(captureAt(recording, 600), null)
  assert.equal(recording.frameCount, 1)
  assert.strictEqual(recording.stop(options.originMs + 9000), completed)
  assert.strictEqual(recording.stop(options.originMs - 100), completed)
  assert.equal(completed.durationMs, 500)
  assert.deepEqual(completed.frames, [frame])
  assert.deepEqual(completed.summary, {
    samples: 1,
    trackedSamples: 0,
    inferenceFps: 0,
  })
})

test('stopping an empty recording prevents its first capture', () => {
  const recording = makeRecording()
  const completed = recording.stop(options.originMs)

  assert.equal(captureAt(recording, 0), null)
  assert.equal(captureAt(recording, 1), null)
  assert.equal(recording.frameCount, 0)
  assert.deepEqual(completed.frames, [])
  assert.strictEqual(recording.stop(options.originMs + 100), completed)
})

test('recording instances keep independent state and use their own origins', () => {
  const first = makeRecording()
  const second = makeRecording({
    id: 'recording-456',
    originMs: 8000,
    videoTime: 20,
  })

  captureAt(first, 0)
  const firstCompleted = first.stop(1100)

  const secondFrame = second.capture({
    time: 8250,
    mediaTime: 20.5,
    keypoints: [],
  })
  const secondCompleted = second.stop(9000)

  assert.equal(secondFrame.time, 250)
  assert.equal(secondFrame.mediaTimeMs, 500)
  assert.equal(firstCompleted.id, options.id)
  assert.equal(secondCompleted.id, 'recording-456')
  assert.equal(firstCompleted.durationMs, 100)
  assert.equal(secondCompleted.durationMs, 1000)
  assert.notStrictEqual(firstCompleted.frames, secondCompleted.frames)
  assert.notStrictEqual(firstCompleted.video, secondCompleted.video)
  assert.notStrictEqual(firstCompleted.model, secondCompleted.model)
  assert.equal(first.frameCount, 1)
  assert.equal(second.frameCount, 1)
})

test('createLabelTemplate returns the complete constant-FPS labeling schema', () => {
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

test('label templates have independent mutable labels and preserve the supplied ID', () => {
  const first = createLabelTemplate('first')
  const second = createLabelTemplate('second')

  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.labels, second.labels)

  first.labels.push({ start: 0, end: 29, label: 'jab' })
  first.fps = 24

  assert.deepEqual(second.labels, [])
  assert.equal(second.fps, 30)
  assert.equal(first.recordingId, 'first')
  assert.equal(second.recordingId, 'second')
  assert.deepEqual(createLabelTemplate('first').labels, [])

  for (const id of ['', 0, null, undefined]) {
    assert.strictEqual(createLabelTemplate(id).recordingId, id)
  }
})
