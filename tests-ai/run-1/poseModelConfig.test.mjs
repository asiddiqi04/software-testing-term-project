import test from 'node:test';
import assert from 'node:assert/strict';

import { poseModelConfig } from '../../frontend/src/lib/poseModelConfig.js';

test('poseModelConfig configures TF.js BlazePose full with local model URLs', () => {
  assert.deepStrictEqual(poseModelConfig, {
    runtime: 'tfjs',
    modelType: 'full',
    detectorModelUrl: '/models/blazepose/detector/model.json',
    landmarkModelUrl: '/models/blazepose/landmark-full/model.json',
  });
});
