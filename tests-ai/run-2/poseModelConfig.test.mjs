import test from 'node:test';
import assert from 'node:assert/strict';
import { poseModelConfig } from '../../frontend/src/lib/poseModelConfig.js';

test('exports a configuration object with the expected fields', () => {
  assert.ok(poseModelConfig !== null);
  assert.equal(typeof poseModelConfig, 'object');
  assert.equal(Array.isArray(poseModelConfig), false);
  assert.deepEqual(Object.keys(poseModelConfig).sort(), [
    'detectorModelUrl',
    'landmarkModelUrl',
    'modelType',
    'runtime',
  ]);
});

test('uses the TensorFlow.js runtime', () => {
  assert.equal(poseModelConfig.runtime, 'tfjs');
});

test('selects the full BlazePose model', () => {
  assert.equal(poseModelConfig.modelType, 'full');
});

test('serves the detector model from the local model directory', () => {
  assert.equal(
    poseModelConfig.detectorModelUrl,
    '/models/blazepose/detector/model.json',
  );
});

test('serves the full landmark model from the local model directory', () => {
  assert.equal(
    poseModelConfig.landmarkModelUrl,
    '/models/blazepose/landmark-full/model.json',
  );
});
