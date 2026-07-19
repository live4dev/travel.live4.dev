import type * as YMaps3 from "@yandex/ymaps3-types";

export type YandexMapsApi = typeof YMaps3;

type WindowWithYandexMaps = Window & {
  ymaps3?: YandexMapsApi;
};

let loadingPromise: Promise<YandexMapsApi> | null = null;

const currentApi = (): YandexMapsApi | undefined =>
  (window as WindowWithYandexMaps).ymaps3;

export const loadYandexMaps = (apiKey: string): Promise<YandexMapsApi> => {
  const loadedApi = currentApi();
  if (loadedApi) return loadedApi.ready.then(() => loadedApi);
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise<YandexMapsApi>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("Yandex Maps API loading timed out"));
    }, 15_000);

    script.dataset.yandexMaps = "true";
    script.async = true;
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    script.addEventListener("load", async () => {
      const api = currentApi();
      if (!api) {
        window.clearTimeout(timeout);
        reject(new Error("Yandex Maps API is missing after script load"));
        return;
      }
      try {
        await api.ready;
        window.clearTimeout(timeout);
        resolve(api);
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
      }
    }, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Yandex Maps API failed to load"));
    }, { once: true });
    document.head.append(script);
  }).catch((error) => {
    loadingPromise = null;
    throw error;
  });

  return loadingPromise;
};

export const degreesToRadians = (degrees: number): number => degrees * Math.PI / 180;

export const bearingToRadians = (degrees: number): number => {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return degreesToRadians(normalized);
};

// The camper asset points east at 0deg. Keep its rotation in route/map
// coordinates: YMapMarker already belongs to the map, so the camera azimuth
// must not be applied to the marker a second time.
export const routeBearingToMarkerRotation = (bearing: number): number => bearing - 90;
