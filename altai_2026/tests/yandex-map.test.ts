import assert from "node:assert/strict";
import test from "node:test";
import { bearingToRadians, degreesToRadians } from "../src/yandex-map";

test("азимут карты нормализуется в диапазон Yandex Maps", () => {
  assert.ok(Math.abs(bearingToRadians(198) - degreesToRadians(-162)) < 1e-12);
  assert.ok(Math.abs(bearingToRadians(-190) - degreesToRadians(170)) < 1e-12);
});

test("углы наклона переводятся в радианы", () => {
  assert.ok(Math.abs(degreesToRadians(45) - Math.PI / 4) < 1e-12);
});
