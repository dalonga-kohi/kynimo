/** A spring interpolation: `damping` is the damping ratio (1 = critical), `response` the period in seconds. */
export interface SpringParams {
  damping: number;
  response: number;
}

/** Frame rate as an exact ratio. */
export interface FrameRate {
  num: number;
  den: number;
}

/** A spring is "settled" once it stays within this fraction of the full travel. */
export const SPRING_SETTLE_THRESHOLD = 0.001;

/** The x where (1 + x) * e^(-x) falls to the settle threshold, found by bisection (monotone for x > 0). */
const LINEAR_BOUND_X = (() => {
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if ((1 + mid) * Math.exp(-mid) > SPRING_SETTLE_THRESHOLD) lo = mid;
    else hi = mid;
  }
  return hi;
})();

/**
 * Remaining fraction of the travel (1 at release, 0 on the target) of a spring released from rest,
 * `seconds` after release: the closed-form damped harmonic oscillator. Negative while it overshoots.
 * The single model shared by {@link springSettleFrames} and the engine.
 */
export function springDeviation(spring: SpringParams, seconds: number): number {
  const omega = (2 * Math.PI) / spring.response;
  const zeta = spring.damping;
  const t = seconds;
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return (
      Math.exp(-zeta * omega * t) *
      (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t))
    );
  }
  if (zeta === 1) return (1 + omega * t) * Math.exp(-omega * t);
  const root = Math.sqrt(zeta * zeta - 1);
  const slow = omega * (zeta - root);
  const fast = omega * (zeta + root);
  return (fast * Math.exp(-slow * t) - slow * Math.exp(-fast * t)) / (fast - slow);
}

/**
 * Number of frames a spring segment lasts: the first frame at which the motion's decay
 * envelope is within {@link SPRING_SETTLE_THRESHOLD} of the target and stays there.
 *
 * This is the single definition shared by schema validation and the engine, so a
 * document that validates also renders its last spring frame on the target. It is
 * the envelope bound, so it never ends a segment before the real motion has settled.
 */
export function springSettleFrames(spring: SpringParams, fps: FrameRate): number {
  const omega = (2 * Math.PI) / spring.response;
  const zeta = spring.damping;
  const eps = SPRING_SETTLE_THRESHOLD;

  let seconds: number;
  if (zeta < 1) {
    // Underdamped. Two valid upper bounds on the deviation; settle at the earlier of the times
    // where either drops below eps (the true motion is below both, so this is never too early):
    //   envelope:  e^(-zeta*omega*t) / sqrt(1 - zeta^2)   (blows up as zeta -> 1)
    //   linear:    (1 + zeta*omega*t) * e^(-zeta*omega*t) (from |sin x| <= x; equals the critical case)
    // Taking the smaller keeps settle time continuous and non-increasing as damping approaches 1.
    const envelope = Math.log(1 / (eps * Math.sqrt(1 - zeta * zeta))) / (zeta * omega);
    seconds = Math.min(envelope, LINEAR_BOUND_X / (zeta * omega));
  } else {
    // Critically and over-damped: the deviation decays monotonically; find where it crosses eps.
    const deviation = (t: number) => springDeviation(spring, t);
    let hi = 1;
    while (deviation(hi) > eps) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (deviation(mid) > eps) lo = mid;
      else hi = mid;
    }
    seconds = hi;
  }
  return Math.max(1, Math.ceil((seconds * fps.num) / fps.den));
}
