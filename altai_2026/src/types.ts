export type ContentSide = "left" | "right";
export type SceneLayout = "hero" | "text-only" | "single" | "stack" | "sequence";

export interface Trip {
  title: string;
  subtitle: string;
  dates: string;
  intro: string;
  finish: string;
  heroPhotoId: string;
  photoAutoAssignThresholdKm: number;
}

export interface CameraState {
  zoom: number;
  bearing: number;
  pitch: number;
  contentSide: ContentSide;
}

export interface Scene {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  routeProgress: number;
  coordinates: [number, number];
  layout: SceneLayout;
  photos: string[];
  camera: CameraState;
  effects: string[];
  audio?: string;
  scrollWeight: number;
}

export interface PhotoVariant {
  width: number;
  src: string;
}

export interface PhotoManifestItem {
  id: string;
  source: string;
  sceneId: string | null;
  order: number;
  featured: boolean;
  alt: string;
  capturedAt: string | null;
  coordinates: [number, number] | null;
  distanceFromRouteKm: number | null;
  routeProgress: number | null;
  width: number;
  height: number;
  src: string;
  variants: {
    avif: PhotoVariant[];
    webp: PhotoVariant[];
  };
}

export interface PhotoManifest {
  generatedAt: string;
  photos: PhotoManifestItem[];
}

export interface StoryFrame {
  lowerIndex: number;
  upperIndex: number;
  mix: number;
  activeIndex: number;
  routeProgress: number;
}
