import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distance, length, lineString, simplify } from "@turf/turf";
import type { FeatureCollection, LineString, Position } from "geojson";
import type { Scene } from "../src/types";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenesPath = path.join(projectRoot, "content/scenes.json");
const routePath = path.join(projectRoot, "public/data/route.geojson");
const simplificationTolerance = 0.0001;
const candidateSlackKm = 0.25;

interface RouteSource {
  coordinates: Position[];
  generatedAt: string;
  routingDistanceKm: number | null;
  routingDurationHours: number | null;
  type: "gpx" | "osrm-api";
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: LineString;
  }>;
}

interface AnchorCandidate {
  distanceKm: number;
  index: number;
  progress: number;
}

const round = (value: number, decimals: number): number =>
  Number(value.toFixed(decimals));

const sameCoordinate = (left: Position, right: Position): boolean =>
  left[0] === right[0] && left[1] === right[1];

const dedupeConsecutiveCoordinates = (coordinates: Position[]): Position[] =>
  coordinates.filter((coordinate, index) => index === 0 || !sameCoordinate(coordinate, coordinates[index - 1]!));

const cumulativeDistances = (coordinates: Position[]): number[] => {
  const result = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    result.push(result[index - 1]! + distance(coordinates[index - 1]!, coordinates[index]!, { units: "kilometers" }));
  }
  return result;
};

export const parseGpxTrack = (xml: string): Position[] => {
  const coordinates = [...xml.matchAll(/<trkpt\s+[^>]*lat="([^"]+)"\s+lon="([^"]+)"[^>]*>/g)]
    .map((match) => [Number(match[2]), Number(match[1])] satisfies Position)
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));

  if (coordinates.length < 2) throw new Error("GPX не содержит трек с координатами trkpt");
  return coordinates;
};

const readGpxSource = async (gpxPath: string): Promise<RouteSource> => {
  const xml = await fs.readFile(gpxPath, "utf8");
  const generatedAt = xml.match(/<time>([^<]+)<\/time>/)?.[1] ?? new Date().toISOString();
  return {
    coordinates: parseGpxTrack(xml),
    generatedAt,
    routingDistanceKm: null,
    routingDurationHours: null,
    type: "gpx",
  };
};

const fetchOsrmSource = async (scenes: Scene[]): Promise<RouteSource> => {
  const baseUrl = (process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");
  const coordinatePath = scenes.map((scene) => scene.coordinates.join(",")).join(";");
  const url = new URL(`${baseUrl}/route/v1/driving/${coordinatePath}`);
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "false");

  console.log(`Запрашиваем автомобильный маршрут для ${scenes.length} точек у ${url.origin}…`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OSRM ответил HTTP ${response.status}`);
  const payload = await response.json() as OsrmResponse;
  const route = payload.routes?.[0];
  if (payload.code !== "Ok" || !route || route.geometry.type !== "LineString") {
    throw new Error(payload.message ?? `OSRM не построил маршрут: ${payload.code}`);
  }

  return {
    coordinates: route.geometry.coordinates,
    generatedAt: new Date().toISOString(),
    routingDistanceKm: route.distance / 1000,
    routingDurationHours: route.duration / 3600,
    type: "osrm-api",
  };
};

const candidatesForScene = (
  scene: Scene,
  coordinates: Position[],
  cumulative: number[],
  totalDistanceKm: number,
): AnchorCandidate[] => {
  const distances = coordinates.map((coordinate) =>
    distance(scene.coordinates, coordinate, { units: "kilometers" }));
  const minimumDistance = distances.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const threshold = minimumDistance + candidateSlackKm;
  const candidates: AnchorCandidate[] = [];
  let clusterBest: AnchorCandidate | null = null;

  distances.forEach((distanceKm, index) => {
    if (distanceKm <= threshold) {
      if (!clusterBest || distanceKm < clusterBest.distanceKm) {
        clusterBest = { distanceKm, index, progress: cumulative[index]! / totalDistanceKm };
      }
      return;
    }
    if (clusterBest) candidates.push(clusterBest);
    clusterBest = null;
  });
  if (clusterBest) candidates.push(clusterBest);

  return candidates;
};

const chooseSceneAnchors = (
  scenes: Scene[],
  coordinates: Position[],
  cumulative: number[],
): AnchorCandidate[] => {
  const totalDistanceKm = cumulative.at(-1)!;
  const candidateSets = scenes.map((scene, sceneIndex) => {
    if (sceneIndex === 0) return [{ distanceKm: distance(scene.coordinates, coordinates[0]!, { units: "kilometers" }), index: 0, progress: 0 }];
    if (sceneIndex === scenes.length - 1) {
      const index = coordinates.length - 1;
      return [{ distanceKm: distance(scene.coordinates, coordinates[index]!, { units: "kilometers" }), index, progress: 1 }];
    }
    return candidatesForScene(scene, coordinates, cumulative, totalDistanceKm);
  });

  const costs: number[][] = candidateSets.map((set) => set.map(() => Infinity));
  const previousCandidates: number[][] = candidateSets.map((set) => set.map(() => -1));
  costs[0]![0] = 0;

  for (let sceneIndex = 1; sceneIndex < scenes.length; sceneIndex += 1) {
    const scene = scenes[sceneIndex]!;
    candidateSets[sceneIndex]!.forEach((candidate, candidateIndex) => {
      const candidateCost = candidate.distanceKm + Math.abs(candidate.progress - scene.routeProgress) * 2;
      candidateSets[sceneIndex - 1]!.forEach((previous, previousIndex) => {
        if (previous.index >= candidate.index) return;
        const totalCost = costs[sceneIndex - 1]![previousIndex]! + candidateCost;
        if (totalCost < costs[sceneIndex]![candidateIndex]!) {
          costs[sceneIndex]![candidateIndex] = totalCost;
          previousCandidates[sceneIndex]![candidateIndex] = previousIndex;
        }
      });
    });
  }

  let candidateIndex = costs.at(-1)!.reduce(
    (best, cost, index, all) => cost < all[best]! ? index : best,
    0,
  );
  if (!Number.isFinite(costs.at(-1)![candidateIndex]!)) {
    throw new Error("Не удалось сопоставить остановки с маршрутом в правильном порядке");
  }

  const anchors = new Array<AnchorCandidate>(scenes.length);
  for (let sceneIndex = scenes.length - 1; sceneIndex >= 0; sceneIndex -= 1) {
    anchors[sceneIndex] = candidateSets[sceneIndex]![candidateIndex]!;
    candidateIndex = previousCandidates[sceneIndex]![candidateIndex]!;
  }
  return anchors;
};

const simplifyBetweenAnchors = (
  coordinates: Position[],
  anchors: AnchorCandidate[],
): { coordinates: Position[]; legDistancesKm: number[] } => {
  const output: Position[] = [];
  const legDistancesKm: number[] = [];

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const start = anchors[index]!.index;
    const end = anchors[index + 1]!.index;
    const segment = coordinates.slice(start, end + 1);
    if (segment.length < 2) throw new Error(`Пустой участок маршрута между остановками ${index + 1} и ${index + 2}`);
    const simplified = simplify(lineString(segment), {
      highQuality: true,
      tolerance: simplificationTolerance,
    }).geometry.coordinates;
    legDistancesKm.push(length(lineString(simplified), { units: "kilometers" }));
    output.push(...(index === 0 ? simplified : simplified.slice(1)));
  }

  return { coordinates: output, legDistancesKm };
};

const replaceSceneProgress = (source: string, progressValues: number[]): string => {
  let index = 0;
  const updated = source.replace(/"routeProgress":\s*-?\d+(?:\.\d+)?/g, () =>
    `"routeProgress": ${progressValues[index++]}`);
  if (index !== progressValues.length) {
    throw new Error(`Ожидалось ${progressValues.length} значений routeProgress, найдено ${index}`);
  }
  return updated;
};

const formatRouteGeoJson = (route: FeatureCollection<LineString>): string =>
  JSON.stringify(route, null, 2).replace(
    /\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]/g,
    "[$1, $2]",
  );

const buildRoute = async (source: RouteSource, scenes: Scene[], scenesSource: string): Promise<void> => {
  const sourceCoordinates = dedupeConsecutiveCoordinates(source.coordinates);
  const cumulative = cumulativeDistances(sourceCoordinates);
  const sourceDistanceKm = cumulative.at(-1)!;
  const anchors = chooseSceneAnchors(scenes, sourceCoordinates, cumulative);
  const simplified = simplifyBetweenAnchors(sourceCoordinates, anchors);
  const totalDistanceKm = simplified.legDistancesKm.reduce((sum, value) => sum + value, 0);
  let completedDistanceKm = 0;
  const progressValues = scenes.map((_, index) => {
    if (index === 0) return 0;
    completedDistanceKm += simplified.legDistancesKm[index - 1]!;
    return index === scenes.length - 1 ? 1 : round(completedDistanceKm / totalDistanceKm, 6);
  });

  const route: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        name: "Автомобильный маршрут по Алтаю, 12–16 июля 2026",
        direction: "ordered-road-route",
        routingProfile: "driving",
        routingEngine: "OSRM",
        dataSource: "OpenStreetMap contributors",
        dataLicense: "ODbL 1.0",
        generatedAt: source.generatedAt,
        sourceType: source.type,
        sourceDistanceKm: round(sourceDistanceKm, 1),
        routingDistanceKm: source.routingDistanceKm === null ? null : round(source.routingDistanceKm, 1),
        routingDurationHours: source.routingDurationHours === null ? null : round(source.routingDurationHours, 1),
        displayedDistanceKm: round(totalDistanceKm, 1),
        originalPointCount: source.coordinates.length,
        simplificationTolerance,
        waypointSceneIds: scenes.map((scene) => scene.id),
        note: "Возвратные участки сохранены в фактическом порядке; геометрия рассчитана один раз и загружается локально.",
      },
      geometry: {
        type: "LineString",
        coordinates: simplified.coordinates,
      },
    }],
  };

  await Promise.all([
    fs.writeFile(routePath, `${formatRouteGeoJson(route)}\n`, "utf8"),
    fs.writeFile(scenesPath, replaceSceneProgress(scenesSource, progressValues), "utf8"),
  ]);

  console.log(`Маршрут готов: ${round(totalDistanceKm, 1)} км, ${simplified.coordinates.length} точек (из ${source.coordinates.length}).`);
  scenes.forEach((scene, index) => {
    console.log(`${String(index + 1).padStart(2, "0")} ${scene.id.padEnd(16)} progress=${progressValues[index]!.toFixed(6)} snap=${Math.round(anchors[index]!.distanceKm * 1000)} м`);
  });
};

async function main(): Promise<void> {
  const scenesSource = await fs.readFile(scenesPath, "utf8");
  const scenes = JSON.parse(scenesSource) as Scene[];
  const gpxArgumentIndex = process.argv.indexOf("--gpx");
  const gpxArgument = gpxArgumentIndex >= 0 ? process.argv[gpxArgumentIndex + 1] : undefined;
  if (gpxArgumentIndex >= 0 && !gpxArgument) throw new Error("После --gpx нужно указать путь к файлу");
  const source = gpxArgument
    ? await readGpxSource(path.resolve(process.cwd(), gpxArgument))
    : await fetchOsrmSource(scenes);
  await buildRoute(source, scenes, scenesSource);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
