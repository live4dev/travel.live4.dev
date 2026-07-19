import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, LineString } from "geojson";
import type { PhotoManifest, Scene, Trip } from "../src/types";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors: string[] = [];
const requiredScenes = [
  "start", "chemal", "patmos", "kamlak", "seminsky-pass", "chike-taman",
  "chuya-katun", "aktash", "geyser-lake", "kurai-steppe", "finish",
];

const readJson = async <T>(relativePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(projectRoot, relativePath), "utf8")) as T;

async function main(): Promise<void> {
  const trip = await readJson<Trip>("content/trip.json");
  const scenes = await readJson<Scene[]>("content/scenes.json");
  const manifest = await readJson<PhotoManifest>("public/data/photo-manifest.json");
  const route = await readJson<FeatureCollection<LineString>>("public/data/route.geojson");
  const sceneIds = new Set<string>();
  const manifestById = new Map(manifest.photos.map((photo) => [photo.id, photo]));

  if (!trip.title || !trip.subtitle || !trip.dates) errors.push("В trip.json не заполнены основные поля");
  if (!Array.isArray(scenes) || scenes.length < requiredScenes.length) errors.push("Недостаточно сцен");

  scenes.forEach((scene, index) => {
    if (!scene.id || sceneIds.has(scene.id)) errors.push(`Неуникальный id сцены: ${scene.id}`);
    sceneIds.add(scene.id);
    if (scene.routeProgress < 0 || scene.routeProgress > 1) errors.push(`${scene.id}: routeProgress вне диапазона 0…1`);
    if (index > 0 && scene.routeProgress < (scenes[index - 1]?.routeProgress ?? 0)) errors.push(`${scene.id}: routeProgress нарушает порядок`);
    if (!scene.title || !scene.description) errors.push(`${scene.id}: отсутствует текст`);
    if (!Array.isArray(scene.coordinates) || scene.coordinates.length !== 2) errors.push(`${scene.id}: некорректные координаты`);
    for (const photoId of scene.photos) {
      const photo = manifestById.get(photoId);
      if (!photo) errors.push(`${scene.id}: фотография ${photoId} отсутствует в манифесте`);
      if (photo && !photo.alt.trim()) errors.push(`${scene.id}: у ${photoId} отсутствует alt`);
      if (photo && photo.sceneId !== scene.id) errors.push(`${scene.id}: ${photoId} привязана к сцене ${photo.sceneId}`);
    }
  });

  for (const id of requiredScenes) {
    if (!sceneIds.has(id)) errors.push(`Отсутствует обязательная сцена: ${id}`);
  }

  const feature = route.features[0];
  if (route.type !== "FeatureCollection" || route.features.length !== 1 || feature?.geometry.type !== "LineString") {
    errors.push("route.geojson должен содержать ровно один LineString");
  } else if (feature.geometry.coordinates.length < 20) {
    errors.push("route.geojson содержит слишком мало точек");
  }

  const publishedText = JSON.stringify({ trip, scenes });
  if (/\+7\s*\d{3}|\b\d{4}\s*\d{6}\b/.test(publishedText)) errors.push("В публичном контенте обнаружены возможные персональные данные");

  for (const photo of manifest.photos) {
    if (!photo.alt.trim()) errors.push(`${photo.id}: опубликованная фотография без alt`);
    for (const variant of [...photo.variants.avif, ...photo.variants.webp]) {
      const absolutePath = path.join(projectRoot, "public", variant.src.replace(/^\.\//, ""));
      try {
        await fs.access(absolutePath);
      } catch {
        errors.push(`${photo.id}: отсутствует файл ${variant.src}`);
      }
    }
  }

  if (errors.length) {
    console.error(errors.map((error) => `• ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Контент валиден: ${scenes.length} сцен, ${manifest.photos.length} фотографий, ${feature?.geometry.coordinates.length ?? 0} точек маршрута.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
