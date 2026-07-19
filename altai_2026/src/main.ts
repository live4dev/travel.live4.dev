import "./styles.css";

import { along, bearing, length, lineSliceAlong, lineString } from "@turf/turf";
import type { LngLat, Margin, YMap, YMapFeature, YMapMarker } from "@yandex/ymaps3-types";
import type { Feature, FeatureCollection, LineString } from "geojson";
import scenesData from "../content/scenes.json";
import tripData from "../content/trip.json";
import { clamp, lerp, sceneIndexForStep, shortestAngle, storyFrameAt } from "./story";
import type { PhotoManifest, PhotoManifestItem, Scene, StoryFrame, Trip } from "./types";
import { bearingToRadians, degreesToRadians, loadYandexMaps } from "./yandex-map";

const trip = tripData as Trip;
const scenes = scenesData as Scene[];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const app = document.querySelector<HTMLDivElement>("#app")!;
const loadingScreen = document.querySelector<HTMLDivElement>("#loading-screen");

if (!app) throw new Error("Контейнер приложения не найден");

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[character]!);

const srcset = (variants: Array<{ width: number; src: string }>): string =>
  variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ");

const photoMarkup = (photo: PhotoManifestItem, index: number): string => `
  <picture class="scene-photo" data-photo-index="${index}">
    <source type="image/avif" srcset="${srcset(photo.variants.avif)}" sizes="(max-width: 720px) 88vw, 42vw" />
    <source type="image/webp" srcset="${srcset(photo.variants.webp)}" sizes="(max-width: 720px) 88vw, 42vw" />
    <img src="${photo.src}" width="${photo.width}" height="${photo.height}" alt="${escapeHtml(photo.alt)}" loading="lazy" decoding="async" />
  </picture>`;

const sceneMarkup = (scene: Scene, index: number, photosById: Map<string, PhotoManifestItem>): string => {
  const photos = scene.photos.map((id) => photosById.get(id)).filter((photo): photo is PhotoManifestItem => Boolean(photo));
  const photosHtml = photos.length
    ? `<div class="photo-composition photo-composition--${scene.layout}" aria-label="Фотографии: ${escapeHtml(scene.title)}">
        ${photos.map(photoMarkup).join("")}
      </div>`
    : "";
  const startControls = scene.id === "start"
    ? `<div class="start-cue" aria-hidden="true"><span></span>Листайте вниз</div>`
    : "";
  const finishControls = scene.id === "finish"
    ? `<div class="finish-actions">
        <button class="action-button" type="button" data-action="restart">Вернуться в начало</button>
        <button class="action-button action-button--quiet" type="button" data-action="copy">Скопировать ссылку</button>
      </div>`
    : "";
  const sceneHeight = Math.round(150 * scene.scrollWeight);

  return `
    <section class="story-scene story-scene--${scene.layout}" id="scene-${escapeHtml(scene.id)}" data-step="${escapeHtml(scene.id)}" style="--scene-height: ${sceneHeight}dvh">
      <article class="scene-card scene-card--${scene.camera.contentSide}" aria-labelledby="title-${escapeHtml(scene.id)}">
        <div class="scene-copy">
          <p class="scene-eyebrow"><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(scene.eyebrow)}</p>
          <h2 id="title-${escapeHtml(scene.id)}">${escapeHtml(scene.title)}</h2>
          <p class="scene-description">${escapeHtml(scene.description)}</p>
          ${scene.id !== "start" ? `<button class="scene-link" type="button" data-action="copy" aria-label="Скопировать ссылку на сцену ${escapeHtml(scene.title)}">Ссылка на это место</button>` : ""}
          ${finishControls}
        </div>
        ${photosHtml}
        ${startControls}
      </article>
    </section>`;
};

class AmbientSound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private tone: OscillatorNode | null = null;
  enabled = false;

  async toggle(): Promise<boolean> {
    if (!this.context) this.create();
    if (!this.context || !this.gain) return false;
    await this.context.resume();
    this.enabled = !this.enabled;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setTargetAtTime(this.enabled ? 0.085 : 0.0001, this.context.currentTime, 0.45);
    localStorage.setItem("altai-sound", this.enabled ? "on" : "off");
    return this.enabled;
  }

  setScene(sound: string | undefined): void {
    if (!this.context || !this.noiseFilter || !this.tone) return;
    const settings: Record<string, [number, number]> = {
      river: [1250, 82],
      wind: [680, 116],
      road: [360, 66],
      forest: [920, 98],
    };
    const [filterFrequency, toneFrequency] = settings[sound ?? "wind"] ?? settings.wind!;
    this.noiseFilter.frequency.setTargetAtTime(filterFrequency, this.context.currentTime, 1.5);
    this.tone.frequency.setTargetAtTime(toneFrequency, this.context.currentTime, 1.5);
  }

  private create(): void {
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    const context = this.context;
    this.gain = context.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(context.destination);

    const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    this.noiseFilter = context.createBiquadFilter();
    this.noiseFilter.type = "lowpass";
    this.noiseFilter.frequency.value = 680;
    noise.connect(this.noiseFilter).connect(this.gain);
    noise.start();

    this.tone = context.createOscillator();
    const toneGain = context.createGain();
    this.tone.type = "sine";
    this.tone.frequency.value = 110;
    toneGain.gain.value = 0.035;
    this.tone.connect(toneGain).connect(this.gain);
    this.tone.start();
  }
}

async function start(): Promise<void> {
  const [manifestResponse, routeResponse] = await Promise.all([
    fetch("./data/photo-manifest.json"),
    fetch("./data/route.geojson"),
  ]);
  if (!manifestResponse.ok || !routeResponse.ok) throw new Error("Не удалось загрузить локальные данные путешествия");

  const manifest = await manifestResponse.json() as PhotoManifest;
  const routeCollection = await routeResponse.json() as FeatureCollection<LineString>;
  const routeFeature = routeCollection.features[0];
  if (!routeFeature) throw new Error("Маршрут отсутствует");
  const routeLine = lineString(routeFeature.geometry.coordinates);
  const routeLengthKm = length(routeLine, { units: "kilometers" });
  const photosById = new Map(manifest.photos.map((photo) => [photo.id, photo]));
  const heroPhoto = photosById.get(trip.heroPhotoId);

  app.innerHTML = `
    <div class="map-shell" aria-label="Карта маршрута">
      <div id="map"></div>
      <div id="map-fallback" class="map-fallback">
        <svg id="fallback-route" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
          <path id="fallback-route-base"></path>
          <path id="fallback-route-progress"></path>
        </svg>
        <img id="fallback-camper" class="fallback-camper" src="./assets/camper-marker.webp" alt="" />
      </div>
      ${heroPhoto ? `<picture class="hero-backdrop" id="hero-backdrop">
        <source type="image/avif" srcset="${srcset(heroPhoto.variants.avif)}" sizes="100vw" />
        <img src="${heroPhoto.src}" alt="" decoding="async" />
      </picture>` : ""}
      <div class="map-vignette"></div>
      <div class="atmosphere" id="atmosphere"></div>
      <div class="map-message" id="map-message" role="status" hidden>Топографическая карта недоступна — маршрут и история продолжают работать.</div>
    </div>

    <header class="topbar">
      <a class="wordmark" href="?step=start" data-step-link="start" aria-label="В начало">
        <span class="wordmark-mark" aria-hidden="true"></span>
        <span><b>Алтай</b><small>на автодоме</small></span>
      </a>
      <div class="topbar-progress" aria-label="Прогресс путешествия">
        <span id="current-count">01</span>
        <div><i id="progress-fill"></i></div>
        <span>${String(scenes.length).padStart(2, "0")}</span>
      </div>
      <div class="topbar-actions">
        <button class="round-button" id="copy-button" type="button" aria-label="Скопировать ссылку на текущую сцену" title="Скопировать ссылку">↗</button>
        <button class="sound-button" id="sound-button" type="button" aria-pressed="false">
          <span class="sound-waves" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="sound-label">Звук</span>
        </button>
      </div>
    </header>

    <nav class="scene-rail" aria-label="Остановки маршрута">
      ${scenes.map((scene, index) => `<button type="button" data-step-link="${escapeHtml(scene.id)}" aria-label="${escapeHtml(scene.title)}" title="${escapeHtml(scene.title)}"><i></i><span>${String(index + 1).padStart(2, "0")}</span></button>`).join("")}
    </nav>

    <main class="story" id="story">
      ${scenes.map((scene, index) => sceneMarkup(scene, index, photosById)).join("")}
    </main>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;

  const sections = [...document.querySelectorAll<HTMLElement>(".story-scene")];
  const railButtons = [...document.querySelectorAll<HTMLButtonElement>(".scene-rail button")];
  const progressFill = document.querySelector<HTMLElement>("#progress-fill")!;
  const currentCount = document.querySelector<HTMLElement>("#current-count")!;
  const heroBackdrop = document.querySelector<HTMLElement>("#hero-backdrop");
  const atmosphere = document.querySelector<HTMLElement>("#atmosphere")!;
  const mapMessage = document.querySelector<HTMLElement>("#map-message")!;
  const mapFallback = document.querySelector<HTMLElement>("#map-fallback")!;
  const fallbackCamper = document.querySelector<HTMLImageElement>("#fallback-camper")!;
  const fallbackBase = document.querySelector<SVGPathElement>("#fallback-route-base")!;
  const fallbackProgress = document.querySelector<SVGPathElement>("#fallback-route-progress")!;
  const toast = document.querySelector<HTMLElement>("#toast")!;
  const soundButton = document.querySelector<HTMLButtonElement>("#sound-button")!;
  const soundLabel = soundButton.querySelector<HTMLElement>(".sound-label")!;
  const ambientSound = new AmbientSound();

  let map: YMap | null = null;
  let routeProgressFeature: YMapFeature | null = null;
  let camperMarker: YMapMarker | null = null;
  let camperMarkerElement: HTMLElement | null = null;
  const stopMarkerElements = new Map<string, HTMLElement>();
  let mapReady = false;
  let usingFallback = false;
  let lastProgressDrawn = -1;
  let activeIndex = -1;
  let anchors: number[] = [];
  let targetScrollPosition = window.scrollY + window.innerHeight * 0.5;
  let renderScrollPosition = targetScrollPosition;
  let animationFrame = 0;

  const bounds = routeFeature.geometry.coordinates.reduce(
    (result, coordinate) => ({
      minX: Math.min(result.minX, coordinate[0]!), maxX: Math.max(result.maxX, coordinate[0]!),
      minY: Math.min(result.minY, coordinate[1]!), maxY: Math.max(result.maxY, coordinate[1]!),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  const projectFallback = (coordinate: number[]): [number, number] => [
    110 + ((coordinate[0]! - bounds.minX) / (bounds.maxX - bounds.minX)) * 780,
    860 - ((coordinate[1]! - bounds.minY) / (bounds.maxY - bounds.minY)) * 720,
  ];
  const pathFromCoordinates = (coordinates: number[][]): string => coordinates
    .map((coordinate, index) => `${index === 0 ? "M" : "L"}${projectFallback(coordinate).join(" ")}`)
    .join(" ");
  fallbackBase.setAttribute("d", pathFromCoordinates(routeFeature.geometry.coordinates));

  const showFallback = (message = "Интерактивная карта недоступна — показываем локальную схему маршрута."): void => {
    usingFallback = true;
    mapFallback.classList.add("is-visible");
    mapMessage.textContent = message;
    mapMessage.hidden = false;
  };

  const completedFeature = (progress: number): Feature<LineString> => {
    const safeProgress = clamp(progress);
    if (safeProgress <= 0.00001) {
      const first = routeFeature.geometry.coordinates[0]!;
      return lineString([first, first]);
    }
    return lineSliceAlong(routeLine, 0, routeLengthKm * safeProgress, { units: "kilometers" });
  };

  const toLngLat = (coordinate: number[]): LngLat => [coordinate[0]!, coordinate[1]!];
  const toLineCoordinates = (coordinates: number[][]): LngLat[] => coordinates.map(toLngLat);
  const routeCoordinates = toLineCoordinates(routeFeature.geometry.coordinates);

  const cameraMargin = (side: Scene["camera"]["contentSide"]): Margin => window.innerWidth < 760
    ? [70, 18, Math.round(window.innerHeight * 0.35), 18]
    : [70, side === "right" ? Math.round(window.innerWidth * 0.38) : 30, 40, side === "left" ? Math.round(window.innerWidth * 0.38) : 30];

  const initializeYandexMap = async (): Promise<void> => {
    const apiKey = (import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined)?.trim();
    if (!apiKey) {
      showFallback("Карта Яндекса пока не подключена — показываем локальную схему маршрута.");
      return;
    }

    try {
      const api = await loadYandexMaps(apiKey);
      const mapElement = document.querySelector<HTMLElement>("#map");
      const initialScene = scenes[0]!;
      if (!mapElement) throw new Error("Контейнер карты не найден");

      map = new api.YMap(mapElement, {
        location: { center: initialScene.coordinates, zoom: initialScene.camera.zoom },
        camera: {
          azimuth: bearingToRadians(initialScene.camera.bearing),
          tilt: degreesToRadians(Math.min(50, initialScene.camera.pitch)),
        },
        margin: cameraMargin(initialScene.camera.contentSide),
        behaviors: [],
        mode: "auto",
        theme: "light",
        copyrightsPosition: "bottom right",
        distributionPosition: "bottom left",
      });
      map.addChild(new api.YMapDefaultSchemeLayer({}));
      map.addChild(new api.YMapDefaultFeaturesLayer({ zIndex: 1800 }));
      map.addChild(new api.YMapFeature({
        id: "route-shadow",
        geometry: { type: "LineString", coordinates: routeCoordinates },
        style: { zIndex: 100, stroke: [{ width: 10, color: "rgba(33,45,36,.28)" }] },
      }));
      map.addChild(new api.YMapFeature({
        id: "route-base",
        geometry: { type: "LineString", coordinates: routeCoordinates },
        style: { zIndex: 101, stroke: [{ width: 5, color: "rgba(255,252,243,.82)" }] },
      }));
      routeProgressFeature = new api.YMapFeature({
        id: "route-progress",
        geometry: { type: "LineString", coordinates: toLineCoordinates(completedFeature(0).geometry.coordinates) },
        style: { zIndex: 102, stroke: [{ width: 6, color: "#d76238" }] },
      });
      map.addChild(routeProgressFeature);

      scenes.slice(1, -1).forEach((scene) => {
        const element = document.createElement("span");
        element.className = "route-stop-marker";
        element.classList.toggle("is-active", scene.id === scenes[Math.max(activeIndex, 0)]?.id);
        element.setAttribute("aria-hidden", "true");
        stopMarkerElements.set(scene.id, element);
        map?.addChild(new api.YMapMarker({ coordinates: scene.coordinates, zIndex: 1200 }, element));
      });

      camperMarkerElement = document.createElement("div");
      camperMarkerElement.className = "camper-marker";
      camperMarkerElement.innerHTML = `<img src="./assets/camper-marker.webp" alt="" />`;
      camperMarker = new api.YMapMarker({ coordinates: routeCoordinates[0]!, zIndex: 1500 }, camperMarkerElement);
      map.addChild(camperMarker);

      mapReady = true;
      usingFallback = false;
      mapFallback.classList.remove("is-visible");
      mapMessage.hidden = true;
      requestRender();
    } catch (error) {
      console.warn("Yandex Maps API is unavailable", error);
      showFallback("Карта Яндекса недоступна — показываем локальную схему маршрута.");
    }
  };

  const measure = (): void => {
    anchors = sections.map((section) => section.offsetTop + Math.min(window.innerHeight * 0.55, section.offsetHeight * 0.25));
    targetScrollPosition = window.scrollY + window.innerHeight * 0.5;
  };

  const showToast = (message: string): void => {
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.setTimeout(() => toast.classList.remove("is-visible"), 1900);
  };

  const copyCurrentLink = async (): Promise<void> => {
    const scene = scenes[Math.max(0, activeIndex)] ?? scenes[0]!;
    const url = new URL(window.location.href);
    url.searchParams.set("step", scene.id);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Ссылка скопирована");
    } catch {
      window.prompt("Скопируйте ссылку", url.toString());
    }
  };

  const scrollToScene = (index: number, behavior: ScrollBehavior = reducedMotion.matches ? "auto" : "smooth"): void => {
    const section = sections[index] ?? sections[0];
    if (!section) return;
    window.scrollTo({ top: section.offsetTop, behavior });
  };

  const updateActiveScene = (nextIndex: number): void => {
    if (activeIndex === nextIndex) return;
    activeIndex = nextIndex;
    const scene = scenes[nextIndex] ?? scenes[0]!;
    sections.forEach((section, index) => section.classList.toggle("is-active", index === nextIndex));
    railButtons.forEach((button, index) => {
      const active = index === nextIndex;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
    });
    currentCount.textContent = String(nextIndex + 1).padStart(2, "0");
    atmosphere.dataset.effects = scene.effects.join(" ");
    ambientSound.setScene(scene.audio);
    document.title = `${scene.title} — ${trip.title}`;
    const url = new URL(window.location.href);
    url.searchParams.set("step", scene.id);
    history.replaceState({ step: scene.id }, "", url);
    stopMarkerElements.forEach((element, id) => element.classList.toggle("is-active", id === scene.id));
  };

  const updatePhotoSequence = (frame: StoryFrame): void => {
    const section = sections[frame.activeIndex];
    if (!section) return;
    const pictures = [...section.querySelectorAll<HTMLElement>(".scene-photo")];
    if (pictures.length === 0) return;
    const anchor = anchors[frame.activeIndex] ?? 0;
    const previousAnchor = anchors[frame.activeIndex - 1] ?? anchor - window.innerHeight;
    const nextAnchor = anchors[frame.activeIndex + 1] ?? anchor + window.innerHeight;
    const localStart = (previousAnchor + anchor) * 0.5;
    const localEnd = (anchor + nextAnchor) * 0.5;
    const local = clamp((renderScrollPosition - localStart) / Math.max(1, localEnd - localStart));
    const currentPhoto = Math.min(pictures.length - 1, Math.floor(local * pictures.length));
    pictures.forEach((picture, index) => picture.classList.toggle("is-current", index === currentPhoto));
  };

  const renderMap = (frame: StoryFrame): void => {
    const traveledKm = routeLengthKm * frame.routeProgress;
    const routePoint = along(routeLine, traveledKm, { units: "kilometers" });
    const headingPoint = along(routeLine, Math.min(routeLengthKm, traveledKm + 0.35), { units: "kilometers" });
    const tailPoint = along(routeLine, Math.max(0, traveledKm - 0.35), { units: "kilometers" });
    const heading = bearing(tailPoint, headingPoint);
    const coordinates = routePoint.geometry.coordinates as [number, number];
    const lowerScene = scenes[frame.lowerIndex] ?? scenes[0]!;
    const upperScene = scenes[frame.upperIndex] ?? lowerScene;
    const camera = {
      zoom: lerp(lowerScene.camera.zoom, upperScene.camera.zoom, frame.mix),
      bearing: lerp(lowerScene.camera.bearing, shortestAngle(lowerScene.camera.bearing, upperScene.camera.bearing), frame.mix),
      pitch: reducedMotion.matches ? 0 : lerp(lowerScene.camera.pitch, upperScene.camera.pitch, frame.mix),
    };

    if (mapReady && map && camperMarker && camperMarkerElement) {
      const side = frame.mix < 0.5 ? lowerScene.camera.contentSide : upperScene.camera.contentSide;
      camperMarker.update({ coordinates });
      camperMarkerElement.style.setProperty("--camper-heading", `${heading - camera.bearing - 90}deg`);
      map.update({
        location: { center: coordinates, zoom: camera.zoom },
        camera: {
          azimuth: bearingToRadians(camera.bearing),
          tilt: degreesToRadians(Math.min(50, Math.max(0, camera.pitch))),
        },
        margin: cameraMargin(side),
      });
      if (routeProgressFeature && Math.abs(frame.routeProgress - lastProgressDrawn) > 0.0006) {
        routeProgressFeature.update({
          geometry: {
            type: "LineString",
            coordinates: toLineCoordinates(completedFeature(frame.routeProgress).geometry.coordinates),
          },
        });
        lastProgressDrawn = frame.routeProgress;
      }
    }

    if (usingFallback || !mapReady) {
      const complete = completedFeature(frame.routeProgress);
      fallbackProgress.setAttribute("d", pathFromCoordinates(complete.geometry.coordinates));
      const [x, y] = projectFallback(coordinates);
      fallbackCamper.style.left = `${x / 10}%`;
      fallbackCamper.style.top = `${y / 10}%`;
      fallbackCamper.style.transform = `translate(-50%, -50%) rotate(${heading - 90}deg)`;
    }
  };

  const render = (): void => {
    const frame = storyFrameAt(scenes, anchors, renderScrollPosition);
    updateActiveScene(frame.activeIndex);
    updatePhotoSequence(frame);
    renderMap(frame);
    const start = anchors[0] ?? 0;
    const end = anchors.at(-1) ?? start + 1;
    const pageProgress = clamp((renderScrollPosition - start) / Math.max(1, end - start));
    progressFill.style.transform = `scaleX(${pageProgress})`;
    if (heroBackdrop) heroBackdrop.style.opacity = String(clamp(1 - (frame.lowerIndex + frame.mix) * 0.92));
  };

  const tick = (): void => {
    animationFrame = 0;
    const motion = reducedMotion.matches ? 1 : 0.13;
    renderScrollPosition += (targetScrollPosition - renderScrollPosition) * motion;
    render();
    if (Math.abs(targetScrollPosition - renderScrollPosition) > 0.35) animationFrame = requestAnimationFrame(tick);
  };

  const requestRender = (): void => {
    targetScrollPosition = window.scrollY + window.innerHeight * 0.5;
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  };

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const stepLink = target.closest<HTMLElement>("[data-step-link]");
    const action = target.closest<HTMLElement>("[data-action]");
    if (stepLink) {
      event.preventDefault();
      const index = sceneIndexForStep(scenes, stepLink.dataset.stepLink ?? null);
      const url = new URL(window.location.href);
      url.searchParams.set("step", scenes[index]!.id);
      history.pushState({ step: scenes[index]!.id }, "", url);
      scrollToScene(index);
    }
    if (action?.dataset.action === "copy") void copyCurrentLink();
    if (action?.dataset.action === "restart") {
      const url = new URL(window.location.href);
      url.searchParams.set("step", "start");
      history.pushState({ step: "start" }, "", url);
      scrollToScene(0);
    }
  });

  document.querySelector<HTMLButtonElement>("#copy-button")?.addEventListener("click", () => void copyCurrentLink());
  soundButton.addEventListener("click", async () => {
    const enabled = await ambientSound.toggle();
    soundButton.setAttribute("aria-pressed", String(enabled));
    soundButton.classList.toggle("is-on", enabled);
    soundLabel.textContent = enabled ? "Вкл" : "Звук";
    showToast(enabled ? "Атмосферный звук включён" : "Звук выключен");
  });

  window.addEventListener("scroll", requestRender, { passive: true });
  window.addEventListener("resize", () => { measure(); requestRender(); }, { passive: true });
  window.addEventListener("popstate", () => {
    const index = sceneIndexForStep(scenes, new URLSearchParams(window.location.search).get("step"));
    scrollToScene(index);
  });
  reducedMotion.addEventListener("change", requestRender);

  void initializeYandexMap();
  measure();
  const initialIndex = sceneIndexForStep(scenes, new URLSearchParams(window.location.search).get("step"));
  scrollToScene(initialIndex, "auto");
  window.setTimeout(() => {
    measure();
    targetScrollPosition = window.scrollY + window.innerHeight * 0.5;
    renderScrollPosition = targetScrollPosition;
    render();
    loadingScreen?.classList.add("is-hidden");
  }, 80);
}

start().catch((error) => {
  console.error(error);
  if (loadingScreen) loadingScreen.innerHTML = `<p>Не удалось открыть историю. Обновите страницу или проверьте файлы проекта.</p>`;
});
