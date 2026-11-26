import test from 'node:test';
import assert from 'node:assert/strict';
import {
  punchTypes,
  initialPunchCounts,
  getPoint,
  dist2d,
  angleDeg,
  scorePunchForSide,
  classifyPunch,
} from '../../frontend/src/training/punchClassifier.js';

// Arm coordinates are [elbow, wrist], relative to the shoulder and
// measured in shoulder widths. Right-hand fixtures mirror anatomically.
const GUARD = [[0, 0.6], [0.4, 0]];
const STRAIGHT = [[0.7, 0], [1.4, 0]];
const HOOK = [[0, -0.3], [0.6, -0.3]];
const UPPER = [[0.6, 0], [0.6, -0.5]];

const worldBent = [[0, 0, 0], [0.3, 0, 0], [0.3, 0, -0.3]];
const worldStraight = [[0, 0, 0], [0.3, 0, 0], [0.6, 0, 0]];

function frame(time, left = GUARD, right = GUARD) {
  const keypoints = [{ name: 'nose', x: 50, y: -40, score: 1 }];

  for (const [side, arm, origin, sign] of [
    ['left', left, 0, 1],
    ['right', right, 100, -1],
  ]) {
    for (const [joint, coords] of [
      ['shoulder', [0, 0]],
      ['hip', [0, 1.5]],
      ['elbow', arm[0]],
      ['wrist', arm[1]],
    ]) {
      keypoints.push({
        name: `${side}_${joint}`,
        x: origin + sign * coords[0] * 100,
        y: coords[1] * 100,
        score: 1,
      });
    }
  }

  return { time, keypoints };
}

function historyFor(poses, side = 'left', step = 50, start = 1000) {
  return poses.map((pose, index) =>
    side === 'left'
      ? frame(start + index * step, pose)
      : frame(start + index * step, GUARD, pose),
  );
}

function straightHistory(side = 'left') {
  return historyFor([GUARD, GUARD, STRAIGHT], side);
}

function hookHistory(side = 'left') {
  return historyFor([
    [[0, -0.3], [0.1, -0.3]],
    [[0, -0.3], [0.3, -0.3]],
    HOOK,
  ], side);
}

function upperHistory(side = 'left') {
  return historyFor([
    [[0.6, 0.5], [0.6, 0.3]],
    [[0.6, 0.2], [0.6, -0.1]],
    UPPER,
  ], side);
}

function withWorld(history, poses, side = 'left') {
  history.forEach((f, index) => {
    f.keypoints3D = ['shoulder', 'elbow', 'wrist'].map((joint, jointIndex) => {
      const [x, y, z] = poses[index][jointIndex];
      return { name: `${side}_${joint}`, x, y, z, score: 1 };
    });
  });
  return history;
}

function point(f, name) {
  return f.keypoints.find(p => p.name === name);
}

function closeTo(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${actual} should approximately equal ${expected}`,
  );
}

test('punchTypes lists the four supported punches in order', () => {
  assert.deepEqual(punchTypes, ['jab', 'cross', 'hook', 'uppercut']);
});

test('initialPunchCounts creates independent zeroed counters', () => {
  const first = initialPunchCounts();
  const second = initialPunchCounts();

  assert.deepEqual(first, { jab: 0, cross: 0, hook: 0, uppercut: 0 });
  assert.notStrictEqual(first, second);

  first.jab = 7;

  assert.deepEqual(second, { jab: 0, cross: 0, hook: 0, uppercut: 0 });
  assert.deepEqual(initialPunchCounts(), second);
});

test('getPoint handles absent collections and unknown names', () => {
  for (const points of [undefined, null, []]) {
    assert.equal(getPoint(points, 'left_wrist'), undefined);
  }

  assert.equal(
    getPoint([{ name: 'right_wrist', score: 1 }], 'left_wrist'),
    undefined,
  );
});

test('getPoint returns the first matching point meeting the inclusive threshold', () => {
  const points = [
    { name: 'right_wrist', score: 1 },
    { name: 'left_wrist', score: 0.49 },
    { name: 'left_wrist', score: 0.5 },
    { name: 'left_wrist', score: 1 },
  ];

  assert.strictEqual(getPoint(points, 'left_wrist'), points[2]);
  assert.strictEqual(getPoint(points, 'left_wrist', 0.9), points[3]);
  assert.equal(getPoint(points, 'left_wrist', 1.1), undefined);
});

test('getPoint defaults nullish scores to one but honors zero scores', () => {
  for (const score of [undefined, null]) {
    const p = { name: 'wrist', score };
    assert.strictEqual(getPoint([p], 'wrist'), p);
    assert.equal(getPoint([p], 'wrist', 1.01), undefined);
  }

  const zero = { name: 'wrist', score: 0 };
  assert.equal(getPoint([zero], 'wrist'), undefined);
  assert.strictEqual(getPoint([zero], 'wrist', 0), zero);

  const nose = { name: 'nose', score: 0.3 };
  assert.strictEqual(getPoint([nose], 'nose', 0.3), nose);
  assert.equal(getPoint([{ name: 'wrist', score: NaN }], 'wrist'), undefined);
});

test('dist2d measures Euclidean distance symmetrically and ignores z', () => {
  const a = { x: -1, y: -2, z: 100 };
  const b = { x: 2, y: 2, z: -100 };

  assert.equal(dist2d(a, b), 5);
  assert.equal(dist2d(b, a), 5);
  assert.equal(dist2d(a, a), 0);
  closeTo(dist2d({ x: 0, y: 0 }, { x: 1, y: 1 }), Math.SQRT2);
});

test('angleDeg measures the angle at the middle point', () => {
  const b = { x: 0, y: 0 };

  closeTo(angleDeg({ x: 1, y: 0 }, b, { x: 0, y: 1 }), 90);
  closeTo(angleDeg({ x: 1, y: 0 }, b, { x: -1, y: 0 }), 180);
  closeTo(angleDeg({ x: 1, y: 0 }, b, { x: 2, y: 0 }), 0);
  closeTo(
    angleDeg({ x: 1, y: 0 }, b, { x: 0.5, y: Math.sqrt(3) / 2 }),
    60,
  );

  assert.equal(angleDeg(b, b, { x: 1, y: 0 }), 0);
  assert.equal(angleDeg({ x: 1, y: 0 }, b, b), 0);
});

test('angleDeg accepts a custom distance function', () => {
  const a = { x: 0, y: 0, z: 1 };
  const b = { x: 0, y: 0, z: 0 };
  const c = { x: 1, y: 0, z: 0 };
  const calls = [];

  const distance = (p, q) => {
    calls.push([p, q]);
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  };

  closeTo(angleDeg(a, b, c, distance), 90);
  assert.deepEqual(calls, [[a, b], [b, c], [a, c]]);
});

test('angleDeg clamps floating-point cosine overflow in both directions', () => {
  for (const [lengths, expected] of [
    [[1, 1, 2 + 1e-12], 180],
    [[1, 1e-10, 0.999999999], 0],
  ]) {
    let index = 0;
    assert.equal(angleDeg({}, {}, {}, () => lengths[index++]), expected);
  }
});

test('short histories return no detections or debug entries', () => {
  for (const length of [0, 1, 2]) {
    const history = straightHistory().slice(0, length);

    for (const side of ['left', 'right']) {
      assert.deepEqual(scorePunchForSide(side, history, {}), {
        detection: null,
        debug: null,
      });
    }

    assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] });
  }
});

for (const name of [
  'left_wrist',
  'left_elbow',
  'left_shoulder',
  'left_hip',
  'right_shoulder',
  'nose',
]) {
  test(`a missing or low-confidence ${name} rejects the current pose`, () => {
    for (const missing of [true, false]) {
      const history = straightHistory();

      if (missing) {
        history.at(-1).keypoints =
          history.at(-1).keypoints.filter(p => p.name !== name);
      } else {
        point(history.at(-1), name).score = name === 'nose' ? 0.299 : 0.499;
      }

      assert.deepEqual(scorePunchForSide('left', history, {}), {
        detection: null,
        debug: null,
      });
    }
  });
}

test('current keypoints can be absent without throwing', () => {
  const history = straightHistory();
  delete history.at(-1).keypoints;

  assert.deepEqual(classifyPunch(history, {}), { punch: null, debug: [] });
});

test('current confidence thresholds are inclusive and absent scores default to one', () => {
  for (const useScores of [true, false]) {
    const history = straightHistory();

    for (const p of history.at(-1).keypoints) {
      if (useScores) {
        p.score = p.name === 'nose' ? 0.3 : 0.5;
      } else {
        delete p.score;
      }
    }

    assert.equal(scorePunchForSide('left', history, {}).detection.type, 'jab');
  }
});

for (const side of ['left', 'right']) {
  for (const [makeHistory, type, score] of [
    [straightHistory, side === 'left' ? 'jab' : 'cross', 100],
    [hookHistory, 'hook', 156],
    [upperHistory, 'uppercut', 121],
  ]) {
    test(`${side} ${type} has the expected detection and diagnostics`, () => {
      const result = scorePunchForSide(side, makeHistory(side), {});

      assert.deepEqual(result.detection, { type, score, side });
      assert.equal(result.debug.side, side);
      assert.equal(result.debug.straightType, side === 'left' ? 'jab' : 'cross');
      assert.equal(result.debug.bestType, type);
      assert.equal(result.debug.bestScore, score);
      assert.equal(result.debug.scoreByType[type], score);
      assert.equal(
        result.debug.threshold,
        type === 'hook' ? 62 : type === 'uppercut' ? 64 : 68,
      );
      assert.equal(result.debug.cooldownRemaining, 0);
      assert.equal(result.debug.recovered, true);
      assert.equal(result.debug.elbowAngle3D, null);
    });
  }
}

test('straight detection tolerates camera tilt', () => {
  const baseline = scorePunchForSide('left', straightHistory(), {});

  assert.equal(baseline.debug.cues.straight2D, true);
  assert.equal(baseline.debug.cues.straight3D, false);
  assert.equal(baseline.debug.elbowAngle, 180);

  const history = straightHistory();
  const theta = -Math.PI / 3;

  for (const f of history) {
    for (const p of f.keypoints) {
      const { x, y } = p;
      p.x = x * Math.cos(theta) - y * Math.sin(theta);
      p.y = x * Math.sin(theta) + y * Math.cos(theta);
    }
  }

  assert.deepEqual(
    scorePunchForSide('left', history, {}).detection,
    baseline.detection,
  );
});

test('scale, translation, and preview mirroring preserve anatomical labels', () => {
  for (const side of ['left', 'right']) {
    for (const makeHistory of [straightHistory, hookHistory, upperHistory]) {
      const expected = scorePunchForSide(side, makeHistory(side), {}).detection;

      for (const scale of [0.5, 2]) {
        const history = makeHistory(side);

        for (const f of history) {
          for (const p of f.keypoints) {
            p.x = 400 - scale * p.x;
            p.y = 70 + scale * p.y;
          }
        }

        assert.deepEqual(scorePunchForSide(side, history, {}).detection, expected);
      }
    }
  }
});

test('stationary straight, hook, and high-guard poses do not count as punches', () => {
  for (const pose of [GUARD, STRAIGHT, HOOK, UPPER]) {
    const result = scorePunchForSide(
      'left',
      historyFor([pose, pose, pose]),
      {},
    );

    assert.equal(result.detection, null);
    assert.equal(result.debug.bestType, null);
    assert.equal(result.debug.bestScore, 0);
    assert.equal(result.debug.threshold, null);
  }
});

test('a lowered arm is not a 2D straight punch', () => {
  const history = historyFor([GUARD, GUARD, [[0, 0.7], [0, 1.4]]]);
  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.elbowAngle, 180);
  assert.equal(result.debug.cues.straight2D, false);
  assert.equal(result.detection, null);
});

test('a slightly bent straight endpoint needs opening and reach evidence', () => {
  const radians = 33 * Math.PI / 180;
  const endpoint = [
    [0.7, 0],
    [0.7 + 0.7 * Math.cos(radians), 0.7 * Math.sin(radians)],
  ];

  const result = scorePunchForSide(
    'left',
    historyFor([GUARD, GUARD, endpoint]),
    {},
  );

  assert.equal(result.debug.elbowAngle, 147);
  assert.equal(result.debug.cues.elbowMostlyStraight, false);
  assert.equal(result.debug.cues.straight2D, true);
  assert.equal(result.detection.type, 'jab');

  assert.equal(
    scorePunchForSide(
      'left',
      historyFor([endpoint, endpoint, endpoint]),
      {},
    ).detection,
    null,
  );
});

test('straight recoil does not become a hook despite a high hook score', () => {
  const result = scorePunchForSide(
    'left',
    historyFor([GUARD, STRAIGHT, HOOK]),
    {},
  );

  assert.equal(result.debug.cues.returningFromStraight, true);
  assert.ok(result.debug.scoreByType.hook >= 62);
  assert.equal(result.detection, null);
});

test('whole-body upward movement cannot supply an uppercut trajectory', () => {
  const history = historyFor([UPPER, UPPER, UPPER]);

  history.forEach((f, index) => {
    f.keypoints.forEach(p => {
      p.y -= index * 40;
    });
  });

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.cues.verticalDominant, true);
  assert.equal(result.debug.cues.uppercutFromLow, false);
  assert.equal(result.debug.cues.uppercutFromGuard, false);
  assert.equal(result.detection, null);
});

test('an eligible candidate below its confidence threshold is not detected', () => {
  const history = historyFor([
    [[0.6, 0.6], [0.6, 0.3]],
    [[0.6, 0.4], [0.6, 0.1]],
    [[0.6, 0.6 / Math.tan(70 * Math.PI / 180)], [0.6, -0.1]],
  ]);

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.bestType, 'uppercut');
  assert.equal(result.debug.bestScore, 54);
  assert.equal(result.debug.threshold, 64);
  assert.equal(result.detection, null);
});

test('low preparation uses the fifth-from-last wrist when present', () => {
  const history = historyFor([
    [[0.6, 0.8], [0.6, 0.6]],
    [[0.6, 0.7], [0.6, 0.5]],
    [[0.6, 0.5], [0.6, 0.3]],
    [[0.6, 0.2], [0.6, -0.1]],
    UPPER,
  ]);

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.cues.lowPrep, true);
  assert.equal(result.debug.cues.uppercutFromLow, true);
  assert.equal(result.detection.type, 'uppercut');
});

test('guard uppercuts require the speed-specific confirmation duration', () => {
  const poses = [
    [[0.6, 0], [0.6, -0.1]],
    [[0.6, 0], [0.6, -0.2]],
    UPPER,
  ];

  for (const [speed, duration] of [
    ['form', 140],
    ['casual', 80],
    ['intense', 45],
  ]) {
    for (const extra of [-1, 0]) {
      const history = historyFor(poses, 'left', (duration + extra) / 2);
      const result = scorePunchForSide('left', history, {}, speed);

      assert.equal(result.debug.cues.uppercutFromGuard, extra === 0);
      assert.equal(
        result.detection?.type ?? null,
        extra === 0 ? 'uppercut' : null,
      );
    }
  }
});

test('hook motion is normalized for capture interval', () => {
  for (const interval of [25, 50, 100]) {
    const delta = 0.5 * interval / 100;
    const history = historyFor([
      [[0, -0.3], [0.6 - 2 * delta, -0.3]],
      [[0, -0.3], [0.6 - delta, -0.3]],
      HOOK,
    ], 'left', interval);

    const result = scorePunchForSide('left', history, {});

    assert.equal(result.debug.cues.lateralDominant, true);
    assert.equal(result.detection.type, 'hook');
  }
});

test('minimum motion depends on speed and is strict at the casual boundary', () => {
  const history = historyFor([
    [[0, -0.3], [0.25, -0.3]],
    [[0, -0.3], [0.3, -0.3]],
    [[0, -0.3], [0.35, -0.3]],
  ]);

  assert.equal(
    scorePunchForSide('left', history, {}, 'form').detection.type,
    'hook',
  );
  assert.equal(scorePunchForSide('left', history, {}, 'casual').detection, null);
  assert.equal(scorePunchForSide('left', history, {}, 'intense').detection, null);
});

test('motion normalization is capped for very short frame intervals', () => {
  const history = historyFor([
    [[0, -0.3], [0.28, -0.3]],
    [[0, -0.3], [0.3, -0.3]],
    [[0, -0.3], [0.32, -0.3]],
  ], 'left', 1);

  assert.equal(
    scorePunchForSide('left', history, {}, 'form').detection.type,
    'hook',
  );
  assert.equal(scorePunchForSide('left', history, {}).detection, null);
});

test('previous wrist confidence .25 supplies velocity but lower confidence does not', () => {
  for (const [confidence, expected] of [[0.25, 'hook'], [0.249, null]]) {
    const history = hookHistory();
    point(history.at(-2), 'left_wrist').score = confidence;

    assert.equal(
      scorePunchForSide('left', history, {}).detection?.type ?? null,
      expected,
    );
  }
});

test('missing previous geometry suppresses straight evidence without throwing', () => {
  const history = straightHistory();
  delete history.at(-2).keypoints;

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.cues.straight2D, false);
  assert.equal(result.detection, null);
});

test('a 250 ms frame gap is allowed but larger or nonpositive gaps break motion', () => {
  for (const gap of [0, -1, 250, 251]) {
    const history = [
      frame(900),
      frame(1000),
      frame(1000 + gap, STRAIGHT),
    ];

    const result = scorePunchForSide('left', history, {});

    assert.equal(result.debug.cues.straight2D, gap === 250);
    assert.equal(result.detection?.type ?? null, gap === 250 ? 'jab' : null);
  }
});

test('earlier discontinuities prevent joining separate motions', () => {
  for (const times of [
    [1000, 1251, 1300],
    [1000, 1000, 1050],
    [1001, 1000, 1050],
  ]) {
    const history = [
      frame(times[0]),
      frame(times[1], STRAIGHT),
      frame(times[2], STRAIGHT),
    ];

    assert.equal(
      scorePunchForSide('left', history, {}, 'form').detection,
      null,
    );
  }
});

test('motion windows include their boundary and exclude stale preparation', () => {
  const atBoundary = [
    frame(1000),
    frame(1250, STRAIGHT),
    frame(1350, STRAIGHT),
  ];
  const beyond = [
    frame(1000),
    frame(1250, STRAIGHT),
    frame(1351, STRAIGHT),
  ];

  assert.equal(scorePunchForSide('left', atBoundary, {}).detection.type, 'jab');
  assert.equal(scorePunchForSide('left', beyond, {}).detection, null);
  assert.equal(
    scorePunchForSide('left', beyond, {}, 'form').detection.type,
    'jab',
  );
  assert.equal(
    scorePunchForSide('left', atBoundary, {}, 'intense').detection,
    null,
  );
});

test('unknown and omitted speed use casual behavior', () => {
  const history = hookHistory();
  const last = { left: 900 };

  assert.deepEqual(
    scorePunchForSide('left', history, last),
    scorePunchForSide('left', history, last, 'casual'),
  );
  assert.deepEqual(
    scorePunchForSide('left', history, last, 'unknown'),
    scorePunchForSide('left', history, last, 'casual'),
  );
  assert.deepEqual(
    classifyPunch(history, last, 'unknown'),
    classifyPunch(history, last, 'casual'),
  );
});

for (const [speed, cooldown] of [
  ['form', 480],
  ['casual', 300],
  ['intense', 160],
]) {
  test(`${speed} cooldown blocks detection until the exact boundary`, () => {
    const history = straightHistory();
    const now = history.at(-1).time;

    const blocked = scorePunchForSide(
      'left',
      history,
      { left: now - cooldown + 1 },
      speed,
    );

    assert.equal(blocked.debug.bestType, 'jab');
    assert.equal(blocked.debug.cooldownRemaining, 1);
    assert.equal(blocked.detection, null);

    const ready = scorePunchForSide(
      'left',
      history,
      { left: now - cooldown },
      speed,
    );

    assert.equal(ready.debug.cooldownRemaining, 0);
    assert.equal(ready.detection.type, 'jab');
  });
}

test('zero, null, and absent punch times do not start cooldowns', () => {
  const history = straightHistory();

  for (const last of [{}, { left: 0 }, { left: null }]) {
    assert.equal(scorePunchForSide('left', history, last).detection.type, 'jab');
  }

  assert.equal(
    scorePunchForSide('left', history, { right: 1099 }).detection.type,
    'jab',
  );
});

test('rounded cooldown diagnostics do not allow early detection', () => {
  const result = scorePunchForSide(
    'left',
    straightHistory(),
    { left: 800.4 },
  );

  assert.equal(result.debug.cooldownRemaining, 0);
  assert.equal(result.detection, null);
});

test('intermediate recoil permits a second punch after cooldown', () => {
  const history = [
    frame(1000, STRAIGHT),
    frame(1050),
    frame(1250),
    frame(1300, STRAIGHT),
  ];

  const result = scorePunchForSide('left', history, { left: 1000 });

  assert.equal(result.debug.recovered, true);
  assert.equal(result.detection.type, 'jab');
});

test('the current frame alone does not establish recovery', () => {
  const history = [
    frame(1000, STRAIGHT),
    frame(1150, STRAIGHT),
    frame(1300),
  ];

  const result = scorePunchForSide('left', history, { left: 1000 });

  assert.equal(result.debug.cooldownRemaining, 0);
  assert.equal(result.debug.recovered, false);
  assert.equal(result.detection, null);
});

test('the prior punch frame cannot supply new straight preparation', () => {
  const history = [
    frame(1000),
    frame(1150, STRAIGHT),
    frame(1300, STRAIGHT),
  ];

  const result = scorePunchForSide('left', history, { left: 1000 });

  assert.equal(result.debug.cues.straight2D, false);
  assert.equal(result.detection, null);
});

test('3D extension detects a straight with weak 2D evidence', () => {
  for (const side of ['left', 'right']) {
    const history = withWorld(
      historyFor([GUARD, GUARD, GUARD], side),
      [worldBent, worldBent, worldStraight],
      side,
    );

    const result = scorePunchForSide(side, history, {});

    assert.equal(result.debug.cues.straight2D, false);
    assert.equal(result.debug.cues.straight3D, true);
    assert.equal(result.debug.elbowAngle3D, 180);
    assert.equal(result.detection.type, side === 'left' ? 'jab' : 'cross');
  }
});

test('reliable 3D extension identifies a downward-directed straight', () => {
  const history = withWorld(
    historyFor([GUARD, GUARD, [[0, 0.7], [0, 1.4]]]),
    [worldBent, worldBent, worldStraight],
  );

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.cues.straight2D, false);
  assert.equal(result.debug.cues.straight3D, true);
  assert.equal(result.detection.type, 'jab');
});

test('bent 3D geometry allows strong 2D evidence at the across-body boundary', () => {
  const history = withWorld(
    historyFor([GUARD, GUARD, [[0.5, 0], [1, 0]]]),
    [worldBent, worldBent, worldBent],
  );

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.elbowAngle3D, 90);
  assert.equal(result.debug.cues.straight2D, true);
  assert.equal(result.detection.type, 'jab');
});

test('bent world geometry rejects a straight-looking arm across the torso', () => {
  const history = withWorld(
    straightHistory(),
    [worldBent, worldBent, worldBent],
  );

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.elbowAngle, 180);
  assert.equal(result.debug.cues.straight2D, false);
  assert.equal(result.detection, null);
});

test('a confirmed bent-arm sweep takes precedence over straight-looking projection', () => {
  const history = withWorld(
    historyFor([
      [[-0.6, 0], [-0.6, -0.5]],
      [[-0.6, 0], [-0.4, -0.4]],
      [[0.5, 0], [1, 0]],
    ]),
    [worldBent, worldBent, worldBent],
  );

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.cues.straight2D, true);
  assert.equal(result.debug.cues.sweepingBentArm, true);
  assert.equal(result.debug.scoreByType.jab, 0);
  assert.deepEqual(result.detection, { type: 'hook', score: 100, side: 'left' });
});

test('a rising uppercut with a sharply bent projection requires 3D confirmation', () => {
  const history = historyFor([
    [[0.6, 0.5], [0.6, 0.3]],
    [[0.6, 0.2], [0.6, -0.1]],
    [[0.6, 0.3464], [0.6, -0.5]],
  ]);

  assert.equal(scorePunchForSide('left', history, {}).detection, null);

  withWorld(history, [worldBent, worldBent, worldBent]);
  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.elbowAngle, 60);
  assert.equal(result.debug.cues.risingBentArm, true);
  assert.deepEqual(result.detection, {
    type: 'uppercut',
    score: 106,
    side: 'left',
  });
});

test('unusable current 3D geometry falls back to valid 2D evidence', () => {
  const corruptions = [
    f => { delete f.keypoints3D; },
    f => { f.keypoints3D.pop(); },
    f => { f.keypoints3D[1].score = 0.49; },
    f => { delete f.keypoints3D[1].z; },
    f => { f.keypoints3D[1].x = NaN; },
    f => { f.keypoints3D[1].y = Infinity; },
    f => { f.keypoints3D[1].z = '0'; },
    f => {
      f.keypoints3D.forEach(p => {
        p.x *= 0.01;
        p.y *= 0.01;
        p.z *= 0.01;
      });
    },
  ];

  for (const corrupt of corruptions) {
    const history = withWorld(
      straightHistory(),
      [worldBent, worldBent, worldStraight],
    );

    corrupt(history.at(-1));

    const result = scorePunchForSide('left', history, {});

    assert.equal(result.debug.elbowAngle3D, null);
    assert.equal(result.debug.cues.straight3D, false);
    assert.equal(result.detection.type, 'jab');
  }
});

test('3D straight evidence requires valid preceding geometry', () => {
  const history = withWorld(
    historyFor([GUARD, GUARD, GUARD]),
    [worldBent, worldBent, worldStraight],
  );
  delete history.at(-2).keypoints3D;

  const result = scorePunchForSide('left', history, {});

  assert.equal(result.debug.elbowAngle3D, 180);
  assert.equal(result.debug.cues.straight3D, false);
  assert.equal(result.detection, null);
});

test('a continuing 3D extension cannot count twice without recoil', () => {
  const extended = [[0, 0, 0], [0.4, 0, 0], [0.8, 0, 0]];
  const history = withWorld(
    [frame(1000), frame(1100), frame(1250), frame(1300)],
    [worldStraight, worldStraight, worldStraight, extended],
  );

  const result = scorePunchForSide('left', history, { left: 1000 });

  assert.equal(result.debug.cues.straight3D, true);
  assert.equal(result.debug.bestType, 'jab');
  assert.equal(result.debug.cooldownRemaining, 0);
  assert.equal(result.debug.recovered, false);
  assert.equal(result.detection, null);
});

test('world-space recoil alone can establish recovery', () => {
  const history = withWorld(
    [frame(1000), frame(1100), frame(1250), frame(1300)],
    [worldStraight, worldBent, worldBent, worldStraight],
  );

  const result = scorePunchForSide('left', history, { left: 1000 });

  assert.equal(result.debug.recovered, true);
  assert.equal(result.detection.type, 'jab');
});

test('classifyPunch retains valid debug entries without detections', () => {
  const result = classifyPunch(historyFor([GUARD, GUARD, GUARD]), {});

  assert.equal(result.punch, null);
  assert.deepEqual(result.debug.map(d => d.side), ['left', 'right']);
});

test('classifyPunch returns a unilateral punch and filters missing debug entries', () => {
  const history = straightHistory('right');
  history.at(-1).keypoints =
    history.at(-1).keypoints.filter(p => p.name !== 'left_wrist');

  const result = classifyPunch(history, {});

  assert.deepEqual(result.punch, { type: 'cross', score: 100, side: 'right' });
  assert.deepEqual(result.debug.map(d => d.side), ['right']);
});

test('classifyPunch resolves equal scores in favor of the left side', () => {
  const history = [
    frame(1000),
    frame(1050),
    frame(1100, STRAIGHT, STRAIGHT),
  ];

  const result = classifyPunch(history, {});

  assert.deepEqual(result.punch, { type: 'jab', score: 100, side: 'left' });
  assert.deepEqual(result.debug.map(d => d.bestScore), [100, 100]);
});

test('classifyPunch selects the highest available score across both sides', () => {
  const history = [
    frame(1000, GUARD, [[0, -0.3], [0.1, -0.3]]),
    frame(1050, GUARD, [[0, -0.3], [0.3, -0.3]]),
    frame(1100, STRAIGHT, HOOK),
  ];

  assert.deepEqual(classifyPunch(history, {}).punch, {
    type: 'hook',
    score: 156,
    side: 'right',
  });
  assert.deepEqual(classifyPunch(history, { right: 1099 }).punch, {
    type: 'jab',
    score: 100,
    side: 'left',
  });
});

test('classifyPunch forwards speed to side scoring', () => {
  const history = straightHistory();
  const last = { left: 900 };

  assert.equal(classifyPunch(history, last, 'casual').punch, null);
  assert.equal(classifyPunch(history, last, 'intense').punch.type, 'jab');
});

test('classification leaves history and cooldown state untouched', () => {
  const history = withWorld(
    straightHistory(),
    [worldBent, worldBent, worldStraight],
  );
  const last = { left: 700, right: 800 };
  const before = structuredClone({ history, last });

  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }

  freeze(history);
  freeze(last);

  scorePunchForSide('left', history, last);
  classifyPunch(history, last);

  assert.deepEqual({ history, last }, before);
});
