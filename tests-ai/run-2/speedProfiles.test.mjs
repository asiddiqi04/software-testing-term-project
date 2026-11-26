import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SPEED,
  speedProfiles,
  isValidSpeed,
  getSpeedProfile,
} from '../../frontend/src/training/speedProfiles.js'

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
}

test('exports casual as the default and exactly the expected profiles', () => {
  assert.equal(DEFAULT_SPEED, 'casual')
  assert.deepEqual(speedProfiles, expectedProfiles)
  assert.equal(isValidSpeed(DEFAULT_SPEED), true)
})

for (const [speed, expected] of Object.entries(expectedProfiles)) {
  test(`isValidSpeed accepts ${speed}`, () => {
    assert.equal(isValidSpeed(speed), true)
  })

  test(`getSpeedProfile returns the original ${speed} profile`, () => {
    const profile = getSpeedProfile(speed)

    assert.strictEqual(profile, speedProfiles[speed])
    assert.deepEqual(profile, expected)
    assert.strictEqual(getSpeedProfile(speed), profile)
  })

  test(`${speed} profile is frozen and rejects changes`, () => {
    const profile = getSpeedProfile(speed)

    assert.equal(Object.isFrozen(profile), true)
    assert.throws(() => {
      profile.cooldownMs = -1
    }, TypeError)
    assert.throws(() => {
      profile.extra = true
    }, TypeError)
    assert.throws(() => {
      delete profile.minMotion
    }, TypeError)
    assert.deepEqual(profile, expected)
  })
}

test('the profile registry is frozen and rejects changes', () => {
  assert.equal(Object.isFrozen(speedProfiles), true)

  assert.throws(() => {
    speedProfiles.casual = {}
  }, TypeError)
  assert.throws(() => {
    speedProfiles.fast = {}
  }, TypeError)
  assert.throws(() => {
    delete speedProfiles.form
  }, TypeError)

  assert.deepEqual(speedProfiles, expectedProfiles)
})

test('isValidSpeed rejects unknown, case-mismatched, and padded strings', () => {
  for (const speed of [
    '',
    'fast',
    'unknown',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
  ]) {
    assert.equal(isValidSpeed(speed), false, JSON.stringify(speed))
  }
})

test('isValidSpeed rejects non-string values without coercion', () => {
  const throwingCoercion = {
    [Symbol.toPrimitive]() {
      throw new Error('must not coerce')
    },
  }

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
    [],
    ['casual'],
    new String('casual'),
    () => 'casual',
    throwingCoercion,
  ]) {
    assert.equal(isValidSpeed(speed), false)
  }

  assert.equal(isValidSpeed(), false)
})

test('isValidSpeed rejects inherited property names', () => {
  for (const speed of [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ]) {
    assert.equal(isValidSpeed(speed), false, speed)
  }
})

test('getSpeedProfile defaults to the original casual profile', () => {
  assert.strictEqual(getSpeedProfile(), speedProfiles.casual)
  assert.strictEqual(getSpeedProfile(undefined), speedProfiles.casual)
})

test('getSpeedProfile falls back when a property lookup finds no profile', () => {
  for (const speed of [
    '',
    'unknown',
    'FORM',
    'Casual',
    'INTENSE',
    ' form',
    'casual ',
    '\tintense\n',
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
    [],
  ]) {
    assert.strictEqual(getSpeedProfile(speed), speedProfiles.casual)
  }
})

test('getSpeedProfile uses JavaScript property-key coercion', () => {
  assert.strictEqual(
    getSpeedProfile(new String('form')),
    speedProfiles.form,
  )
  assert.strictEqual(getSpeedProfile(['intense']), speedProfiles.intense)
  assert.strictEqual(
    getSpeedProfile({ toString: () => 'form' }),
    speedProfiles.form,
  )
  assert.strictEqual(
    getSpeedProfile({ [Symbol.toPrimitive]: () => 'intense' }),
    speedProfiles.intense,
  )
})

test('getSpeedProfile propagates property-key coercion errors', () => {
  const error = new Error('cannot convert speed to a property key')
  const speed = {
    [Symbol.toPrimitive]() {
      throw error
    },
  }

  assert.throws(
    () => getSpeedProfile(speed),
    (caught) => caught === error,
  )
})

test('getSpeedProfile exposes inherited properties through direct lookup', () => {
  // The getter does not perform the own-property validation of isValidSpeed.
  for (const speed of [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
  ]) {
    assert.strictEqual(getSpeedProfile(speed), Object.prototype[speed])
  }

  assert.strictEqual(
    getSpeedProfile('__proto__'),
    Object.getPrototypeOf(speedProfiles),
  )
})
