import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPEED,
  speedProfiles,
  isValidSpeed,
  getSpeedProfile,
} from '../../frontend/src/training/speedProfiles.js';

const expectedProfiles = {
  form: {
    frameIntervalMs: 80,
    cooldownMs: 480,
    motionWindowMs: 650,
    comboDelayMs: 1000,
    uppercutConfirmMs: 140,
    minMotion: 0.04,
  },
  casual: {
    frameIntervalMs: 50,
    cooldownMs: 300,
    motionWindowMs: 350,
    comboDelayMs: 650,
    uppercutConfirmMs: 80,
    minMotion: 0.1,
  },
  intense: {
    frameIntervalMs: 25,
    cooldownMs: 160,
    motionWindowMs: 220,
    comboDelayMs: 350,
    uppercutConfirmMs: 45,
    minMotion: 0.12,
  },
};

test('exports casual as the valid default speed', () => {
  assert.equal(DEFAULT_SPEED, 'casual');
  assert.equal(isValidSpeed(DEFAULT_SPEED), true);
});

test('exports exactly the expected profiles and settings', () => {
  assert.deepEqual(speedProfiles, expectedProfiles);
});

test('the profile collection and each individual profile are frozen', () => {
  assert.equal(Object.isFrozen(speedProfiles), true);

  for (const profile of Object.values(speedProfiles)) {
    assert.equal(Object.isFrozen(profile), true);
  }

  assert.throws(() => {
    speedProfiles.extra = {};
  }, TypeError);

  assert.throws(() => {
    speedProfiles.casual = {};
  }, TypeError);

  assert.throws(() => {
    delete speedProfiles.form;
  }, TypeError);

  for (const profile of Object.values(speedProfiles)) {
    assert.throws(() => {
      profile.cooldownMs = 0;
    }, TypeError);

    assert.throws(() => {
      profile.extra = true;
    }, TypeError);

    assert.throws(() => {
      delete profile.minMotion;
    }, TypeError);
  }

  assert.deepEqual(speedProfiles, expectedProfiles);
});

test('isValidSpeed accepts every supported speed', () => {
  for (const speed of Object.keys(expectedProfiles)) {
    assert.equal(isValidSpeed(speed), true, speed);
  }
});

test('isValidSpeed rejects unknown strings without normalizing them', () => {
  const invalidSpeeds = [
    '',
    'slow',
    'fast',
    'default',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
    'casual\0',
  ];

  for (const speed of invalidSpeeds) {
    assert.equal(isValidSpeed(speed), false, JSON.stringify(speed));
  }
});

test('isValidSpeed rejects inherited property names', () => {
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(isValidSpeed(key), false, key);
  }
});

test('isValidSpeed rejects non-string inputs, including coercible values', () => {
  const invalidInputs = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    -1,
    NaN,
    Infinity,
    0n,
    Symbol('casual'),
    {},
    Object.create(null),
    [],
    ['casual'],
    new String('casual'),
    () => 'casual',
    { toString: () => 'casual' },
  ];

  assert.equal(isValidSpeed(), false);

  for (const input of invalidInputs) {
    assert.equal(isValidSpeed(input), false);
  }
});

test('isValidSpeed does not attempt to coerce non-string inputs', () => {
  const input = {
    [Symbol.toPrimitive]() {
      throw new Error('Unexpected coercion');
    },
  };

  assert.equal(isValidSpeed(input), false);
});

test('getSpeedProfile returns the exact stored object for each speed', () => {
  for (const speed of Object.keys(expectedProfiles)) {
    const profile = getSpeedProfile(speed);

    assert.strictEqual(profile, speedProfiles[speed]);
    assert.deepEqual(profile, expectedProfiles[speed]);
    assert.strictEqual(getSpeedProfile(speed), profile);
    assert.equal(Object.isFrozen(profile), true);
  }
});

test('getSpeedProfile defaults to the casual profile', () => {
  assert.strictEqual(getSpeedProfile(), speedProfiles.casual);
  assert.strictEqual(getSpeedProfile(undefined), speedProfiles.casual);
});

test('getSpeedProfile falls back when the property lookup is missing', () => {
  const missingKeys = [
    '',
    'unknown',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
    'casual\0',
    null,
    false,
    true,
    0,
    -1,
    NaN,
    Infinity,
    0n,
    Symbol('casual'),
    [],
    {},
  ];

  for (const key of missingKeys) {
    assert.strictEqual(getSpeedProfile(key), speedProfiles.casual);
  }
});

test('getSpeedProfile uses JavaScript property-key coercion', () => {
  assert.strictEqual(
    getSpeedProfile(new String('form')),
    speedProfiles.form,
  );
  assert.strictEqual(getSpeedProfile(['intense']), speedProfiles.intense);
  assert.strictEqual(
    getSpeedProfile({ toString: () => 'form' }),
    speedProfiles.form,
  );

  const hints = [];
  const key = {
    [Symbol.toPrimitive](hint) {
      hints.push(hint);
      return 'intense';
    },
  };

  assert.strictEqual(getSpeedProfile(key), speedProfiles.intense);
  assert.deepEqual(hints, ['string']);
});

test('getSpeedProfile performs an inherited lookup rather than validating speed', () => {
  // Unlike isValidSpeed, this function does not require an own property.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(isValidSpeed(key), false);
    assert.strictEqual(getSpeedProfile(key), speedProfiles[key]);
  }
});

test('getSpeedProfile propagates property-key coercion errors', () => {
  const error = new Error('Cannot convert key');
  const key = {
    [Symbol.toPrimitive]() {
      throw error;
    },
  };

  assert.throws(
    () => getSpeedProfile(key),
    (actual) => actual === error,
  );

  assert.throws(
    () => getSpeedProfile(Object.create(null)),
    TypeError,
  );
});
