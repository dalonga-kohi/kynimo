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
    // Underdamped: deviation <= e^(-zeta*omega*t) / sqrt(1 - zeta^2).
    seconds = Math.log(1 / (eps * Math.sqrt(1 - zeta * zeta))) / (zeta * omega);
  } else {
    // Critically and over-damped: the deviation decays monotonically; find where it crosses eps.
    const deviation =
      zeta === 1
        ? (t: number) => (1 + omega * t) * Math.exp(-omega * t)
        : (() => {
            const root = Math.sqrt(zeta * zeta - 1);
            const slow = omega * (zeta - root);
            const fast = omega * (zeta + root);
            return (t: number) =>
              (fast * Math.exp(-slow * t) - slow * Math.exp(-fast * t)) / (fast - slow);
          })();
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
