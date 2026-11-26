import test from 'node:test';
import assert from 'node:assert/strict';
import { poseModelConfig } from '../../frontend/src/lib/poseModelConfig.js';

test('poseModelConfig exports the complete expected configuration', () => {
  assert.deepStrictEqual(poseModelConfig, {
    runtime: 'tfjs',
    modelType: 'full',
    detectorModelUrl: '/models/blazepose/detector/model.json',
    landmarkModelUrl: '/models/blazepose/landmark-full/model.json',
  });
});

test('poseModelConfig uses the TensorFlow.js runtime and full model', () => {
  assert.equal(poseModelConfig.runtime, 'tfjs');
  assert.equal(poseModelConfig.modelType, 'full');
});

test('poseModelConfig serves the detector model locally', () => {
  assert.equal(
    poseModelConfig.detectorModelUrl,
    '/models/blazepose/detector/model.json',
  );
});

test('poseModelConfig serves the full landmark model locally', () => {
  assert.equal(
    poseModelConfig.landmarkModelUrl,
    '/models/blazepose/landmark-full/model.json',
  );
});
