import assert from "node:assert/strict";
import test from "node:test";
import {
  bearingToRadians,
  degreesToRadians,
  routeBearingToMarkerRotation,
} from "../src/yandex-map";

test("азимут карты нормализуется в диапазон Yandex Maps", () => {
  assert.ok(Math.abs(bearingToRadians(198) - degreesToRadians(-162)) < 1e-12);
  assert.ok(Math.abs(bearingToRadians(-190) - degreesToRadians(170)) < 1e-12);
});

test("углы наклона переводятся в радианы", () => {
  assert.ok(Math.abs(degreesToRadians(45) - Math.PI / 4) < 1e-12);
});

test("автодом ориентируется только по направлению маршрута", () => {
  assert.equal(routeBearingToMarkerRotation(90), 0);
  assert.equal(routeBearingToMarkerRotation(0), -90);
  assert.equal(routeBearingToMarkerRotation(-90), -180);
});
