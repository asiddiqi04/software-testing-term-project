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

test('exports casual as a valid default speed', () => {
  assert.equal(DEFAULT_SPEED, 'casual');
  assert.equal(isValidSpeed(DEFAULT_SPEED), true);
});

test('exports exactly the expected profiles and configuration values', () => {
  assert.deepEqual(speedProfiles, expectedProfiles);
});

test('the profile map and every individual profile are frozen', () => {
  assert.equal(Object.isFrozen(speedProfiles), true);

  for (const profile of Object.values(speedProfiles)) {
    assert.equal(Object.isFrozen(profile), true);

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

  assert.throws(() => {
    speedProfiles.casual = {};
  }, TypeError);

  assert.throws(() => {
    speedProfiles.extra = {};
  }, TypeError);

  assert.throws(() => {
    delete speedProfiles.form;
  }, TypeError);

  assert.deepEqual(speedProfiles, expectedProfiles);
});

test('isValidSpeed accepts every defined speed', () => {
  for (const speed of Object.keys(expectedProfiles)) {
    assert.equal(isValidSpeed(speed), true, speed);
  }
});

test('isValidSpeed rejects unknown, differently cased, and padded strings', () => {
  for (const speed of [
    '',
    'unknown',
    'fast',
    'FORM',
    'Casual',
    'Intense',
    ' casual',
    'casual ',
    '\tform\n',
  ]) {
    assert.equal(isValidSpeed(speed), false, JSON.stringify(speed));
  }
});

test('isValidSpeed rejects inherited property names', () => {
  for (const speed of [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ]) {
    assert.equal(isValidSpeed(speed), false, speed);
  }
});

test('isValidSpeed rejects non-string values without coercing them', () => {
  const values = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    NaN,
    Infinity,
    1n,
    Symbol('casual'),
    [],
    ['casual'],
    {},
    Object.create(null),
    new String('casual'),
    () => 'casual',
    {
      [Symbol.toPrimitive]() {
        throw new Error('Validation must not coerce its input');
      },
    },
  ];

  assert.equal(isValidSpeed(), false);

  for (const value of values) {
    assert.equal(isValidSpeed(value), false);
  }
});

test('getSpeedProfile returns the original object for every defined speed', () => {
  for (const speed of Object.keys(expectedProfiles)) {
    const profile = getSpeedProfile(speed);

    assert.strictEqual(profile, speedProfiles[speed]);
    assert.deepEqual(profile, expectedProfiles[speed]);
    assert.equal(Object.isFrozen(profile), true);
    assert.strictEqual(getSpeedProfile(speed), profile);
  }
});

test('getSpeedProfile defaults to the casual profile', () => {
  assert.strictEqual(getSpeedProfile(), speedProfiles.casual);
  assert.strictEqual(getSpeedProfile(undefined), speedProfiles.casual);
  assert.strictEqual(getSpeedProfile(DEFAULT_SPEED), speedProfiles.casual);
});

test('getSpeedProfile falls back to casual for missing property keys', () => {
  for (const speed of [
    '',
    'unknown',
    'fast',
    'FORM',
    'Casual',
    'Intense',
    ' casual',
    'casual ',
    null,
    false,
    true,
    0,
    -1,
    NaN,
    Infinity,
    1n,
    Symbol('casual'),
  ]) {
    assert.strictEqual(getSpeedProfile(speed), speedProfiles.casual);
  }
});

test('getSpeedProfile uses JavaScript property-key coercion', () => {
  assert.strictEqual(getSpeedProfile(['form']), speedProfiles.form);
  assert.strictEqual(
    getSpeedProfile(new String('intense')),
    speedProfiles.intense,
  );
  assert.strictEqual(
    getSpeedProfile({
      [Symbol.toPrimitive]() {
        return 'form';
      },
    }),
    speedProfiles.form,
  );
});

test('getSpeedProfile directly exposes inherited properties when addressed', () => {
  // The getter performs a property lookup; it does not call isValidSpeed.
  for (const speed of ['constructor', 'toString', 'valueOf', '__proto__']) {
    assert.equal(isValidSpeed(speed), false);
    assert.strictEqual(getSpeedProfile(speed), speedProfiles[speed]);
  }
});

test('getSpeedProfile propagates property-key coercion errors', () => {
  const error = new Error('Cannot convert speed to a property key');
  const speed = {
    [Symbol.toPrimitive]() {
      throw error;
    },
  };

  assert.throws(() => getSpeedProfile(speed), (actual) => actual === error);
});
