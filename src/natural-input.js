export const NATURAL_INPUT_BOUNDS = Object.freeze({
  approachThresholdPx: 320,
  approachRatioMinPercent: 68,
  approachRatioMaxPercent: 92,
  approachDirectProbabilityPercent: 30,
  approachConservativeProbabilityPercent: 20,
  approachConservativeRatioMinPercent: 52,
  approachConservativeRatioMaxPercent: 72,
  gestureSpeedMin: 360,
  gestureSpeedMax: 900,
  wheelPulseMin: 2,
  wheelPulseMax: 4,
  wheelGapMinMs: 18,
  wheelGapMaxMs: 55,
  scrollPauseMinMs: 18,
  scrollPauseMaxMs: 65,
  clickMoveMin: 2,
  clickMoveMax: 4,
  clickMoveGapMinMs: 12,
  clickMoveGapMaxMs: 35,
  clickHoverMinMs: 35,
  clickHoverMaxMs: 90,
  clickHoldMinMs: 45,
  clickHoldMaxMs: 110,
  clickReleaseMinMs: 10,
  clickReleaseMaxMs: 35,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sampleInteger(randomIntegerFn, min, max, purpose) {
  const lower = Math.ceil(Math.min(min, max));
  const upper = Math.floor(Math.max(min, max));
  if (lower === upper) return lower;
  const sampled = Number(randomIntegerFn(lower, upper, purpose));
  if (!Number.isFinite(sampled)) return lower;
  return clamp(Math.round(sampled), lower, upper);
}

export function planApproachDistance(distance, randomIntegerFn) {
  const rounded = Math.round(Number(distance));
  const magnitude = Math.abs(rounded);
  if (!Number.isFinite(rounded) || magnitude <= NATURAL_INPUT_BOUNDS.approachThresholdPx) {
    return rounded;
  }
  const modeRoll = sampleInteger(randomIntegerFn, 0, 99, "scroll-approach-mode");
  let ratioMin;
  let ratioMax;
  if (modeRoll < NATURAL_INPUT_BOUNDS.approachConservativeProbabilityPercent) {
    ratioMin = NATURAL_INPUT_BOUNDS.approachConservativeRatioMinPercent;
    ratioMax = NATURAL_INPUT_BOUNDS.approachConservativeRatioMaxPercent;
  } else if (
    modeRoll <
    NATURAL_INPUT_BOUNDS.approachConservativeProbabilityPercent +
      NATURAL_INPUT_BOUNDS.approachDirectProbabilityPercent
  ) {
    ratioMin = 100;
    ratioMax = 100;
  } else {
    ratioMin = NATURAL_INPUT_BOUNDS.approachRatioMinPercent;
    ratioMax = NATURAL_INPUT_BOUNDS.approachRatioMaxPercent;
  }
  if (ratioMin >= 100 && ratioMax >= 100) return rounded;
  const ratio = sampleInteger(
    randomIntegerFn,
    ratioMin,
    ratioMax,
    "scroll-approach-ratio",
  );
  const approach = clamp(Math.round((magnitude * ratio) / 100), 2, magnitude - 2);
  return Math.sign(rounded) * approach;
}

export function planGestureSpeed(distance, randomIntegerFn, phase = "normal") {
  const magnitude = Math.max(2, Math.abs(Math.round(Number(distance) || 0)));
  const base = magnitude < 120
    ? 330
    : clamp(Math.round(340 + Math.sqrt(magnitude) * 19), 420, 810);
  const variability = sampleInteger(randomIntegerFn, 88, 112, `scroll-speed-${phase}`);
  return clamp(
    Math.round((base * variability) / 100),
    NATURAL_INPUT_BOUNDS.gestureSpeedMin,
    NATURAL_INPUT_BOUNDS.gestureSpeedMax,
  );
}

export function planWheelBurst(distance, randomIntegerFn) {
  const rounded = Math.round(Number(distance));
  const magnitude = Math.abs(rounded);
  if (!Number.isFinite(rounded) || magnitude <= 1) {
    return { pulses: [], gapsMs: [] };
  }
  const maximumCount = Math.min(NATURAL_INPUT_BOUNDS.wheelPulseMax, magnitude);
  const minimumCount = Math.min(NATURAL_INPUT_BOUNDS.wheelPulseMin, maximumCount);
  const preferredCount = magnitude < 80 ? minimumCount : maximumCount;
  const count = sampleInteger(
    randomIntegerFn,
    minimumCount,
    preferredCount,
    "wheel-pulse-count",
  );
  const sign = Math.sign(rounded);
  let remaining = magnitude;
  const pulses = [];
  for (let index = 0; index < count; index += 1) {
    const slotsLeft = count - index;
    if (slotsLeft === 1) {
      pulses.push(sign * remaining);
      break;
    }
    const minimumRemainder = slotsLeft - 1;
    const average = remaining / slotsLeft;
    const factor = sampleInteger(randomIntegerFn, 82, 118, "wheel-pulse-shape");
    const next = clamp(
      Math.round((average * factor) / 100),
      1,
      remaining - minimumRemainder,
    );
    pulses.push(sign * next);
    remaining -= next;
  }
  const gapsMs = pulses.slice(1).map(() => sampleInteger(
    randomIntegerFn,
    NATURAL_INPUT_BOUNDS.wheelGapMinMs,
    NATURAL_INPUT_BOUNDS.wheelGapMaxMs,
    "wheel-pulse-gap",
  ));
  return { pulses, gapsMs };
}

export function planScrollPause(randomIntegerFn, phase = "normal") {
  return sampleInteger(
    randomIntegerFn,
    NATURAL_INPUT_BOUNDS.scrollPauseMinMs,
    NATURAL_INPUT_BOUNDS.scrollPauseMaxMs,
    `scroll-pause-${phase}`,
  );
}

export function planClickMotion({ x, y, rect = null, randomIntegerFn }) {
  const target = { x: Math.round(Number(x)), y: Math.round(Number(y)) };
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error("点击坐标无效");
  }

  const width = Math.max(1, Math.round(Number(rect?.width) || 1));
  const height = Math.max(1, Math.round(Number(rect?.height) || 1));
  const horizontalRoom = Math.max(1, Math.min(8, Math.floor(width * 0.18)));
  const verticalRoom = Math.max(1, Math.min(6, Math.floor(height * 0.18)));
  let offsetX = sampleInteger(
    randomIntegerFn,
    -horizontalRoom,
    horizontalRoom,
    "click-approach-x",
  );
  let offsetY = sampleInteger(
    randomIntegerFn,
    -verticalRoom,
    verticalRoom,
    "click-approach-y",
  );
  if (offsetX === 0 && offsetY === 0) offsetX = horizontalRoom;

  const stepCount = sampleInteger(
    randomIntegerFn,
    NATURAL_INPUT_BOUNDS.clickMoveMin,
    NATURAL_INPUT_BOUNDS.clickMoveMax,
    "click-move-count",
  );
  const points = [];
  for (let index = 0; index < stepCount; index += 1) {
    const progress = stepCount === 1 ? 1 : index / (stepCount - 1);
    const eased = 1 - (1 - progress) ** 2;
    points.push({
      x: index === stepCount - 1 ? target.x : Math.round(target.x + offsetX * (1 - eased)),
      y: index === stepCount - 1 ? target.y : Math.round(target.y + offsetY * (1 - eased)),
      delayMs: sampleInteger(
        randomIntegerFn,
        NATURAL_INPUT_BOUNDS.clickMoveGapMinMs,
        NATURAL_INPUT_BOUNDS.clickMoveGapMaxMs,
        "click-move-gap",
      ),
    });
  }

  return {
    target,
    points,
    hoverMs: sampleInteger(
      randomIntegerFn,
      NATURAL_INPUT_BOUNDS.clickHoverMinMs,
      NATURAL_INPUT_BOUNDS.clickHoverMaxMs,
      "click-hover",
    ),
    holdMs: sampleInteger(
      randomIntegerFn,
      NATURAL_INPUT_BOUNDS.clickHoldMinMs,
      NATURAL_INPUT_BOUNDS.clickHoldMaxMs,
      "click-hold",
    ),
    releaseMs: sampleInteger(
      randomIntegerFn,
      NATURAL_INPUT_BOUNDS.clickReleaseMinMs,
      NATURAL_INPUT_BOUNDS.clickReleaseMaxMs,
      "click-release",
    ),
  };
}
