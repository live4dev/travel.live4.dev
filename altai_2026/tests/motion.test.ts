import assert from "node:assert/strict";
import test from "node:test";
import { springIsSettled, stepCriticalSpring, type SpringState } from "../src/motion";

test("пружина плавно сходится к цели без перелёта", () => {
  let state: SpringState = { value: 0, velocity: 0 };
  for (let index = 0; index < 120; index += 1) {
    state = stepCriticalSpring(state, 1, 1 / 60, 0.18);
    assert.ok(state.value >= 0 && state.value <= 1);
  }
  assert.ok(springIsSettled(state, 1, 0.001, 0.01));
});

test("смена цели сохраняет непрерывную скорость", () => {
  let state: SpringState = { value: 0, velocity: 0 };
  state = stepCriticalSpring(state, 1, 1 / 60, 0.18);
  const forwardVelocity = state.velocity;
  state = stepCriticalSpring(state, -1, 1 / 1000, 0.18);
  assert.ok(forwardVelocity > 0);
  assert.ok(state.velocity > 0, "скорость не должна мгновенно менять знак");
});
