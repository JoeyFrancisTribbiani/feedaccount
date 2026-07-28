import test from "node:test";
import assert from "node:assert/strict";

import {
  NATURAL_INPUT_BOUNDS,
  planApproachDistance,
  planClickMotion,
  planGestureSpeed,
  planScrollPause,
  planWheelBurst,
} from "../src/natural-input.js";

const minimum = (min) => min;
const maximum = (_min, max) => max;

test("a long scroll approaches the target without changing direction", () => {
  assert.equal(planApproachDistance(561, minimum), 292);
  assert.equal(planApproachDistance(561, maximum), 516);
  assert.equal(planApproachDistance(561, (_min, _max) => 25), 561);
  assert.equal(planApproachDistance(561, (_min, _max) => 50), 381);
  assert.equal(planApproachDistance(-561, minimum), -292);
  assert.equal(planApproachDistance(320, minimum), 320);
  assert.equal(planApproachDistance(1, minimum), 1);
});

test("gesture speed and the short pre-scroll pause stay inside declared bounds", () => {
  for (const sampler of [minimum, maximum]) {
    for (const distance of [-2_000, -75, 75, 2_000]) {
      const speed = planGestureSpeed(distance, sampler, "correction");
      assert.ok(speed >= NATURAL_INPUT_BOUNDS.gestureSpeedMin);
      assert.ok(speed <= NATURAL_INPUT_BOUNDS.gestureSpeedMax);
    }
    const pause = planScrollPause(sampler, "approach");
    assert.ok(pause >= NATURAL_INPUT_BOUNDS.scrollPauseMinMs);
    assert.ok(pause <= NATURAL_INPUT_BOUNDS.scrollPauseMaxMs);
  }
});

test("wheel fallback uses finite same-direction pulses whose sum is exact", () => {
  for (const sampler of [minimum, maximum]) {
    for (const distance of [-561, -17, 17, 561]) {
      const plan = planWheelBurst(distance, sampler);
      assert.ok(plan.pulses.length >= 2);
      assert.ok(plan.pulses.length <= 4);
      assert.equal(plan.pulses.reduce((sum, pulse) => sum + pulse, 0), distance);
      assert.ok(plan.pulses.every((pulse) => Number.isFinite(pulse) && pulse !== 0));
      assert.ok(plan.pulses.every((pulse) => Math.sign(pulse) === Math.sign(distance)));
      assert.equal(plan.gapsMs.length, plan.pulses.length - 1);
      assert.ok(plan.gapsMs.every(
        (gap) =>
          gap >= NATURAL_INPUT_BOUNDS.wheelGapMinMs &&
          gap <= NATURAL_INPUT_BOUNDS.wheelGapMaxMs,
      ));
    }
  }
  assert.deepEqual(planWheelBurst(1, minimum), { pulses: [], gapsMs: [] });
});

test("click motion stays in the target center area and ends at the verified point", () => {
  const rect = { x: 400, y: 340, width: 40, height: 40 };
  for (const sampler of [minimum, maximum]) {
    const plan = planClickMotion({
      x: 420,
      y: 360,
      rect,
      randomIntegerFn: sampler,
    });
    assert.ok(plan.points.length >= NATURAL_INPUT_BOUNDS.clickMoveMin);
    assert.ok(plan.points.length <= NATURAL_INPUT_BOUNDS.clickMoveMax);
    assert.deepEqual(plan.points.at(-1), {
      x: 420,
      y: 360,
      delayMs: plan.points.at(-1).delayMs,
    });
    assert.ok(plan.points.every(
      (point) =>
        point.x > rect.x && point.x < rect.x + rect.width &&
        point.y > rect.y && point.y < rect.y + rect.height,
    ));
    assert.ok(plan.points.every(
      (point) =>
        point.delayMs >= NATURAL_INPUT_BOUNDS.clickMoveGapMinMs &&
        point.delayMs <= NATURAL_INPUT_BOUNDS.clickMoveGapMaxMs,
    ));
    assert.ok(plan.hoverMs >= NATURAL_INPUT_BOUNDS.clickHoverMinMs);
    assert.ok(plan.hoverMs <= NATURAL_INPUT_BOUNDS.clickHoverMaxMs);
    assert.ok(plan.holdMs >= NATURAL_INPUT_BOUNDS.clickHoldMinMs);
    assert.ok(plan.holdMs <= NATURAL_INPUT_BOUNDS.clickHoldMaxMs);
    assert.ok(plan.releaseMs >= NATURAL_INPUT_BOUNDS.clickReleaseMinMs);
    assert.ok(plan.releaseMs <= NATURAL_INPUT_BOUNDS.clickReleaseMaxMs);
  }
});

test("a seeded sampler reproduces a plan while another seed varies safely", () => {
  const seeded = (seed) => {
    let state = seed >>> 0;
    return (min, max) => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return min + (state % (max - min + 1));
    };
  };
  const makePlan = (seed) => ({
    approach: planApproachDistance(720, seeded(seed)),
    click: planClickMotion({
      x: 300,
      y: 200,
      rect: { x: 280, y: 180, width: 40, height: 40 },
      randomIntegerFn: seeded(seed + 1),
    }),
  });
  assert.deepEqual(makePlan(7), makePlan(7));
  assert.notDeepEqual(makePlan(7), makePlan(19));
});

