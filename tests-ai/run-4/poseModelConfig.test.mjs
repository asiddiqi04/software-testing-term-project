import test from 'node:test';
import assert from 'node:assert/strict';
import { poseModelConfig } from '../../frontend/src/lib/poseModelConfig.js';

test('poseModelConfig exports the expected configuration fields', () => {
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

test('poseModelConfig uses the TensorFlow.js runtime', () => {
  assert.equal(poseModelConfig.runtime, 'tfjs');
});

test('poseModelConfig selects the full BlazePose model', () => {
  assert.equal(poseModelConfig.modelType, 'full');
});

test('poseModelConfig serves the detector model from the expected local path', () => {
  assert.equal(
    poseModelConfig.detectorModelUrl,
    '/models/blazepose/detector/model.json',
  );
});

test('poseModelConfig serves the full landmark model from the expected local path', () => {
  assert.equal(
    poseModelConfig.landmarkModelUrl,
    '/models/blazepose/landmark-full/model.json',
  );
});
