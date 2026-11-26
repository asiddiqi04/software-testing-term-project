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

test('DEFAULT_SPEED is casual and names a valid profile', () => {
  assert.equal(DEFAULT_SPEED, 'casual');
  assert.equal(isValidSpeed(DEFAULT_SPEED), true);
});

test('speedProfiles contains exactly the expected profiles and settings', () => {
  assert.deepEqual(speedProfiles, expectedProfiles);
});

test('speedProfiles and each individual profile are frozen', () => {
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
      profile.frameIntervalMs = 999;
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

for (const speed of Object.keys(expectedProfiles)) {
  test(`isValidSpeed accepts "${speed}"`, () => {
    assert.equal(isValidSpeed(speed), true);
  });

  test(`getSpeedProfile returns the shared "${speed}" profile`, () => {
    const profile = getSpeedProfile(speed);

    assert.strictEqual(profile, speedProfiles[speed]);
    assert.strictEqual(getSpeedProfile(speed), profile);
    assert.deepEqual(profile, expectedProfiles[speed]);
  });
}

test('isValidSpeed rejects unknown, case-mismatched, and padded strings', () => {
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
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ]) {
    assert.equal(isValidSpeed(speed), false, speed);
  }
});

test('isValidSpeed rejects non-string values without coercing them', () => {
  const mustNotBeCoerced = {
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
    0n,
    Symbol('casual'),
    {},
    Object.create(null),
    [],
    ['casual'],
    new String('casual'),
    () => 'casual',
    mustNotBeCoerced,
  ]) {
    assert.equal(isValidSpeed(speed), false);
  }

  assert.equal(isValidSpeed(), false);
});

test('getSpeedProfile uses casual when omitted or explicitly undefined', () => {
  assert.strictEqual(getSpeedProfile(), speedProfiles.casual);
  assert.strictEqual(getSpeedProfile(undefined), speedProfiles.casual);
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
    1,
    NaN,
    Infinity,
    0n,
    Symbol('form'),
    {},
    [],
    ['form', 'intense'],
  ]) {
    assert.strictEqual(getSpeedProfile(speed), speedProfiles.casual);
  }
});

test('getSpeedProfile applies JavaScript property-key coercion', () => {
  assert.strictEqual(
    getSpeedProfile(new String('form')),
    speedProfiles.form,
  );
  assert.strictEqual(getSpeedProfile(['intense']), speedProfiles.intense);
  assert.strictEqual(
    getSpeedProfile({ toString: () => 'form' }),
    speedProfiles.form,
  );
  assert.strictEqual(
    getSpeedProfile({
      [Symbol.toPrimitive](hint) {
        assert.equal(hint, 'string');
        return 'intense';
      },
    }),
    speedProfiles.intense,
  );
});

test('getSpeedProfile can return inherited properties despite validation rejecting them', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(isValidSpeed(key), false);
    assert.strictEqual(getSpeedProfile(key), Object.prototype[key]);
  }

  assert.equal(isValidSpeed('__proto__'), false);
  assert.strictEqual(getSpeedProfile('__proto__'), Object.prototype);
});

test('getSpeedProfile propagates property-key coercion errors', () => {
  const failure = new Error('Cannot convert speed');

  assert.throws(
    () => getSpeedProfile({
      [Symbol.toPrimitive]() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );

  assert.throws(() => getSpeedProfile(Object.create(null)), TypeError);
});
