import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import exifr from "exifr";
import sharp from "sharp";
import { length, lineSliceAlong, lineString, nearestPointOnLine, point } from "@turf/turf";
import type { Feature, LineString } from "geojson";
import type { PhotoManifest, PhotoManifestItem, Scene, Trip } from "../src/types";

interface PhotoOverride {
  sceneId?: string;
  order?: number;
  hidden?: boolean;
  featured?: boolean;
  alt?: string;
  caption?: string;
  coordinates?: [number, number];
}

interface ExifResult {
  latitude?: number;
  longitude?: number;
  DateTimeOriginal?: Date | string;
  CreateDate?: Date | string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(projectRoot, "assets", "photos");
const outputDirectory = path.join(projectRoot, "public", "photos");
const manifestPath = path.join(projectRoot, "public", "data", "photo-manifest.json");
const reportPath = path.join(projectRoot, "content", "photo-report.json");
const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const targetWidths = [480, 960, 1600];
const routeOccurrenceSlackKm = 0.25;

const readJson = async <T>(relativePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(projectRoot, relativePath), "utf8")) as T;

const asIsoString = (value: Date | string | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const chooseNearestScene = (scenes: Scene[], progress: number): string | null => {
  let best: Scene | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const scene of scenes) {
    const nextDistance = Math.abs(scene.routeProgress - progress);
    if (nextDistance < distance) {
      best = scene;
      distance = nextDistance;
    }
  }
  return best?.id ?? null;
};

async function main(): Promise<void> {
  const trip = await readJson<Trip>("content/trip.json");
  const scenes = await readJson<Scene[]>("content/scenes.json");
  const overrides = await readJson<Record<string, PhotoOverride>>("content/photo-overrides.json");
  const routeCollection = await readJson<{ features: Array<Feature<LineString>> }>("public/data/route.geojson");
  const route = routeCollection.features[0];
  if (!route || route.geometry.type !== "LineString") throw new Error("route.geojson должен содержать LineString");
  const routeLine = lineString(route.geometry.coordinates);
  const routeLengthKm = length(routeLine, { units: "kilometers" });
  const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
  const routeLegs = scenes.slice(0, -1).map((scene, index) => {
    const startKm = routeLengthKm * scene.routeProgress;
    const endKm = routeLengthKm * scenes[index + 1]!.routeProgress;
    return {
      startKm,
      line: lineSliceAlong(routeLine, startKm, endKm, { units: "kilometers" }),
    };
  });

  const entries = (await fs.readdir(sourceDirectory))
    .filter((entry) => supportedExtensions.has(path.extname(entry).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });

  const photos: PhotoManifestItem[] = [];
  const missingGps: string[] = [];
  const tooFarFromRoute: Array<{ id: string; distanceKm: number }> = [];
  const unassigned: string[] = [];

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry);
    const id = path.basename(entry, path.extname(entry)).toLowerCase();
    const override = overrides[id] ?? {};
    if (override.hidden) continue;

    let exif: ExifResult = {};
    try {
      exif = (await exifr.parse(sourcePath, { gps: true, exif: true, tiff: true })) as ExifResult ?? {};
    } catch (error) {
      console.warn(`EXIF не прочитан для ${entry}:`, error instanceof Error ? error.message : error);
    }

    const coordinates = override.coordinates ?? (
      Number.isFinite(exif.longitude) && Number.isFinite(exif.latitude)
        ? [exif.longitude!, exif.latitude!] as [number, number]
        : null
    );

    let distanceFromRouteKm: number | null = null;
    let routeProgress: number | null = null;
    if (coordinates) {
      const preferredProgress = override.sceneId ? scenesById.get(override.sceneId)?.routeProgress : undefined;
      const candidates = routeLegs.map((leg) => {
        const nearest = nearestPointOnLine(leg.line, point(coordinates), { units: "kilometers" });
        const distanceKm = Number(nearest.properties.dist ?? 0);
        const locationKm = leg.startKm + Number(nearest.properties.location ?? 0);
        return {
          distanceKm,
          progress: Math.min(1, Math.max(0, locationKm / routeLengthKm)),
        };
      });
      const minimumDistanceKm = candidates.reduce((minimum, candidate) => Math.min(minimum, candidate.distanceKm), Infinity);
      const nearbyCandidates = candidates.filter((candidate) => candidate.distanceKm <= minimumDistanceKm + routeOccurrenceSlackKm);
      const nearest = nearbyCandidates.reduce((best, candidate) => {
        if (preferredProgress === undefined) return candidate.distanceKm < best.distanceKm ? candidate : best;
        const bestDifference = Math.abs(best.progress - preferredProgress);
        const candidateDifference = Math.abs(candidate.progress - preferredProgress);
        return candidateDifference < bestDifference ? candidate : best;
      });
      distanceFromRouteKm = nearest.distanceKm;
      routeProgress = nearest.progress;
    } else {
      missingGps.push(id);
    }

    if (distanceFromRouteKm !== null && distanceFromRouteKm > trip.photoAutoAssignThresholdKm) {
      tooFarFromRoute.push({ id, distanceKm: Number(distanceFromRouteKm.toFixed(2)) });
    }

    const canAutoAssign = routeProgress !== null && (distanceFromRouteKm ?? Infinity) <= trip.photoAutoAssignThresholdKm;
    const sceneId = override.sceneId ?? (canAutoAssign ? chooseNearestScene(scenes, routeProgress!) : null);
    if (!sceneId) unassigned.push(id);

    const baseImage = sharp(sourcePath, { failOn: "none" }).rotate();
    const metadata = await baseImage.metadata();
    const sourceWidth = metadata.width ?? 1600;
    const sourceHeight = metadata.height ?? 1200;
    const widths = [...new Set(targetWidths.map((width) => Math.min(width, sourceWidth)))].sort((a, b) => a - b);
    const variants = { avif: [] as Array<{ width: number; src: string }>, webp: [] as Array<{ width: number; src: string }> };

    for (const width of widths) {
      const avifName = `${id}-${width}.avif`;
      const webpName = `${id}-${width}.webp`;
      await baseImage.clone().resize({ width, withoutEnlargement: true }).avif({ quality: 57, effort: 5 }).toFile(path.join(outputDirectory, avifName));
      await baseImage.clone().resize({ width, withoutEnlargement: true }).webp({ quality: 80, effort: 5 }).toFile(path.join(outputDirectory, webpName));
      variants.avif.push({ width, src: `./photos/${avifName}` });
      variants.webp.push({ width, src: `./photos/${webpName}` });
    }

    const largestWebp = variants.webp.at(-1)!;
    photos.push({
      id,
      source: entry,
      sceneId,
      order: override.order ?? 999,
      featured: override.featured ?? false,
      alt: override.alt?.trim() ?? "",
      capturedAt: asIsoString(exif.DateTimeOriginal ?? exif.CreateDate),
      coordinates,
      distanceFromRouteKm,
      routeProgress,
      width: sourceWidth,
      height: sourceHeight,
      src: largestWebp.src,
      variants,
    });
  }

  photos.sort((left, right) => {
    if (left.sceneId === right.sceneId && left.order !== right.order) return left.order - right.order;
    return (left.capturedAt ?? "").localeCompare(right.capturedAt ?? "");
  });

  const manifest: PhotoManifest = { generatedAt: new Date().toISOString(), photos };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(reportPath, `${JSON.stringify({ generatedAt: manifest.generatedAt, missingGps, tooFarFromRoute, unassigned }, null, 2)}\n`);
  console.log(`Подготовлено фотографий: ${photos.length}; вариантов: ${photos.length * targetWidths.length * 2}`);
  console.log(`Отчёт: ${path.relative(projectRoot, reportPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
