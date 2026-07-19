export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * Frame-rate-independent critically damped spring.
 * Velocity is preserved when the target changes, which removes the visible
 * start/stop jerk produced by per-frame linear interpolation.
 */
export const stepCriticalSpring = (
  state: SpringState,
  target: number,
  deltaSeconds: number,
  responseSeconds: number,
): SpringState => {
  const deltaTime = Math.min(0.05, Math.max(0, deltaSeconds));
  if (deltaTime === 0) return state;
  const omega = 2 / Math.max(0.001, responseSeconds);
  const displacement = state.value - target;
  const velocityTerm = state.velocity + omega * displacement;
  const decay = Math.exp(-omega * deltaTime);

  return {
    value: target + (displacement + velocityTerm * deltaTime) * decay,
    velocity: (state.velocity - omega * velocityTerm * deltaTime) * decay,
  };
};

export const springIsSettled = (
  state: SpringState,
  target: number,
  valueEpsilon: number,
  velocityEpsilon: number,
): boolean =>
  Math.abs(state.value - target) <= valueEpsilon && Math.abs(state.velocity) <= velocityEpsilon;
