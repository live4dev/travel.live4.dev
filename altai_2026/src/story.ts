import type { Scene, StoryFrame } from "./types";

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

export const lerp = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount;

export const shortestAngle = (from: number, to: number): number => {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta;
};

export function sceneIndexForStep(scenes: Scene[], step: string | null): number {
  if (!step) return 0;
  const index = scenes.findIndex((scene) => scene.id === step);
  return index >= 0 ? index : 0;
}

export function storyFrameAt(
  scenes: Scene[],
  anchors: number[],
  scrollPosition: number,
): StoryFrame {
  if (scenes.length === 0) {
    return { lowerIndex: 0, upperIndex: 0, mix: 0, activeIndex: 0, routeProgress: 0 };
  }

  const firstAnchor = anchors[0] ?? 0;
  const lastAnchor = anchors.at(-1) ?? firstAnchor;
  const position = clamp(scrollPosition, firstAnchor, lastAnchor);
  let lowerIndex = 0;

  for (let index = 0; index < anchors.length - 1; index += 1) {
    if (position >= (anchors[index] ?? 0) && position <= (anchors[index + 1] ?? 0)) {
      lowerIndex = index;
      break;
    }
    if (position > (anchors[index + 1] ?? 0)) lowerIndex = index + 1;
  }

  const upperIndex = Math.min(lowerIndex + 1, scenes.length - 1);
  const lowerAnchor = anchors[lowerIndex] ?? firstAnchor;
  const upperAnchor = anchors[upperIndex] ?? lowerAnchor;
  const span = Math.max(1, upperAnchor - lowerAnchor);
  const mix = lowerIndex === upperIndex ? 0 : clamp((position - lowerAnchor) / span);
  const lowerScene = scenes[lowerIndex] ?? scenes[0]!;
  const upperScene = scenes[upperIndex] ?? lowerScene;

  return {
    lowerIndex,
    upperIndex,
    mix,
    activeIndex: mix < 0.5 ? lowerIndex : upperIndex,
    routeProgress: lerp(lowerScene.routeProgress, upperScene.routeProgress, mix),
  };
}
