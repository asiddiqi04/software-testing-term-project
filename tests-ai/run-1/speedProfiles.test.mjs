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

test('exports the expected default and complete profile values', () => {
  assert.equal(DEFAULT_SPEED, 'casual');
  assert.deepEqual(speedProfiles, expectedProfiles);
  assert.equal(isValidSpeed(DEFAULT_SPEED), true);
});

test('the profile collection and every individual profile are frozen', () => {
  assert.equal(Object.isFrozen(speedProfiles), true);

  assert.throws(() => {
    speedProfiles.extra = {};
  }, TypeError);
  assert.throws(() => {
    speedProfiles.form = {};
  }, TypeError);
  assert.throws(() => {
    delete speedProfiles.casual;
  }, TypeError);

  for (const profile of Object.values(speedProfiles)) {
    assert.equal(Object.isFrozen(profile), true);

    for (const key of Object.keys(profile)) {
      assert.throws(() => {
        profile[key] = -1;
      }, TypeError);
      assert.throws(() => {
        delete profile[key];
      }, TypeError);
    }

    assert.throws(() => {
      profile.extra = 1;
    }, TypeError);
  }

  assert.deepEqual(speedProfiles, expectedProfiles);
});

for (const speed of Object.keys(expectedProfiles)) {
  test(`isValidSpeed accepts "${speed}"`, () => {
    assert.equal(isValidSpeed(speed), true);
  });

  test(`getSpeedProfile returns the shared "${speed}" profile`, () => {
    assert.strictEqual(getSpeedProfile(speed), speedProfiles[speed]);
    assert.strictEqual(getSpeedProfile(speed), getSpeedProfile(speed));
  });
}

test('isValidSpeed rejects unknown, differently cased, and padded strings', () => {
  for (const speed of [
    '',
    'unknown',
    'fast',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
  ]) {
    assert.equal(isValidSpeed(speed), false, JSON.stringify(speed));
  }
});

test('isValidSpeed rejects inherited property names', () => {
  for (const speed of [
    'toString',
    'constructor',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
  ]) {
    assert.equal(isValidSpeed(speed), false, speed);
  }
});

test('isValidSpeed rejects nonstrings without coercing them', () => {
  const mustNotCoerce = {
    [Symbol.toPrimitive]() {
      throw new Error('Unexpected coercion');
    },
  };

  for (const speed of [
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
    {},
    [],
    ['casual'],
    new String('casual'),
    () => 'casual',
    mustNotCoerce,
  ]) {
    assert.equal(isValidSpeed(speed), false);
  }

  assert.equal(isValidSpeed(), false);
});

test('getSpeedProfile defaults to the shared casual profile', () => {
  assert.strictEqual(getSpeedProfile(), speedProfiles.casual);
  assert.strictEqual(getSpeedProfile(undefined), speedProfiles.casual);
});

test('getSpeedProfile falls back for missing property keys', () => {
  for (const speed of [
    '',
    'unknown',
    'fast',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
    null,
    false,
    true,
    0,
    -1,
    NaN,
    Infinity,
    1n,
    Symbol('casual'),
    {},
    [],
  ]) {
    assert.strictEqual(getSpeedProfile(speed), speedProfiles.casual);
  }
});

test('getSpeedProfile uses JavaScript property-key coercion', () => {
  for (const speed of Object.keys(expectedProfiles)) {
    assert.strictEqual(getSpeedProfile(new String(speed)), speedProfiles[speed]);
    assert.strictEqual(getSpeedProfile([speed]), speedProfiles[speed]);
    assert.strictEqual(
      getSpeedProfile({ [Symbol.toPrimitive]: () => speed }),
      speedProfiles[speed],
    );
  }
});

test('getSpeedProfile returns inherited values when the lookup finds them', () => {
  // Lookup is intentionally tested separately from own-property validation.
  for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    assert.strictEqual(getSpeedProfile(key), Object.prototype[key]);
  }
  assert.strictEqual(getSpeedProfile('__proto__'), Object.prototype);
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
