import test from 'node:test';
import assert from 'node:assert/strict';
import { poseModelConfig } from '../../frontend/src/lib/poseModelConfig.js';

test('exports a configuration object with the expected options', () => {
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

test('loads the detector model from the local models directory', () => {
  assert.equal(
    poseModelConfig.detectorModelUrl,
    '/models/blazepose/detector/model.json',
  );
});

test('loads the full landmark model from the local models directory', () => {
  assert.equal(
    poseModelConfig.landmarkModelUrl,
    '/models/blazepose/landmark-full/model.json',
  );
});
