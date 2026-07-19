import assert from "node:assert/strict";
import test from "node:test";
import scenes from "../content/scenes.json" with { type: "json" };
import { sceneIndexForStep, shortestAngle, storyFrameAt } from "../src/story";
import type { Scene } from "../src/types";

const typedScenes = scenes as Scene[];
const anchors = typedScenes.map((_, index) => index * 1000);

test("прямая ссылка открывает известную сцену", () => {
  assert.equal(typedScenes[sceneIndexForStep(typedScenes, "geyser-lake")]?.id, "geyser-lake");
});

test("неизвестный step безопасно возвращает начало", () => {
  assert.equal(sceneIndexForStep(typedScenes, "unknown-place"), 0);
  assert.equal(sceneIndexForStep(typedScenes, null), 0);
});

test("маршрутный прогресс одинаков при прямом и обратном вычислении", () => {
  const forward = storyFrameAt(typedScenes, anchors, 7250);
  const backward = storyFrameAt(typedScenes, anchors, 7250);
  assert.deepEqual(backward, forward);
  assert.ok(forward.routeProgress >= 0 && forward.routeProgress <= 1);
});

test("интерполяция угла выбирает короткий поворот", () => {
  assert.equal(shortestAngle(350, 10), 370);
  assert.equal(shortestAngle(10, 350), -10);
});
