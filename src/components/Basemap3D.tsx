import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, PlotData } from "plotly.js";
import { withBase } from "../lib/paths";
import { makeSyntheticGreenlandSeaBathy } from "../lib/syntheticBathy";
import { paletteToColorscale, rdylbu_r_256, rgbKey, type RGB } from "../lib/colormap";
import {
  getPixelRGBA,
  loadImageData,
  makeDiscreteColorscale332,
  rgbToIndex332,
} from "../lib/imageSampling";

type BathyGrid = {
  lon: number[];
  lat: number[];
  z: number[][];
};

type LonLatBounds = {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

type LonDepthBounds = {
  lonMin: number;
  lonMax: number;
  depthMin: number;
  depthMax: number;
};

type HorizontalField = {
  enabled: boolean;
  // values are on a (lat x lon) grid. If the grid differs from the bathymetry grid,
  // provide lon/lat for resampling onto the bathy surface.
  values: number[][];
  lon?: number[];
  lat?: number[];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  mode?: "surface" | "bathy";
  // Used when mode === "surface": draws the overlay as a horizontal plane at this z (meters).
  // If omitted, defaults to 0 (sea surface).
  zPlane?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
  bounds?: LonLatBounds;
};

type TransectField = {
  enabled: boolean;
  lat: number;
  lon: number[];
  z: number[]; // negative down (meters)
  values: number[][];
  cmin: number;
  cmax: number;
  colorscale: Array<[number, string]>;
  opacity?: number;
  showScale?: boolean;
  colorbarTitle?: string;
  colorbarTicks?: number[];
};

async function tryLoadBathyJson(): Promise<BathyGrid | null> {
  try {
    const candidates = [withBase("data/bathy_RTopo.json"), withBase("data/bathy.json")];
    let json: BathyGrid | null = null;
    for (const url of candidates) {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      json = (await r.json()) as BathyGrid;
      break;
    }
    if (!json) return null;
    if (!Array.isArray(json?.lon) || !Array.isArray(json?.lat) || !Array.isArray(json?.z)) {
      return null;
    }
    // Accept either convention:
    // - negative meters below sea level (preferred)
    // - positive depth in meters (common in ocean models)
    // If the grid is entirely non-negative, flip sign so Plotly shows a basin.
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < Math.min(json.z.length, 40); j++) {
      const row = json.z[j];
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < Math.min(row.length, 40); i++) {
        const v = Number((row as any)[i]);
        if (!Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (Number.isFinite(min) && min >= 0 && max > 0) {
      json.z = json.z.map((row) => (Array.isArray(row) ? row.map((v) => -Number(v)) : row)) as any;
    }

    // Plotly surface performance: keep grid under a manageable size.
    // RTopo can be thousands x thousands; downsample deterministically.
    const nLat = json.lat.length;
    const nLon = json.lon.length;
    const maxPoints = 250_000;
    const nPoints = nLat * nLon;
    if (nPoints > maxPoints && nLat > 0 && nLon > 0) {
      const targetLat = Math.max(80, Math.floor(Math.sqrt((maxPoints * nLat) / nLon)));
      const targetLon = Math.max(80, Math.floor(maxPoints / targetLat));
      const strideLat = Math.max(1, Math.ceil(nLat / targetLat));
      const strideLon = Math.max(1, Math.ceil(nLon / targetLon));

      const latIdx: number[] = [];
      for (let j = 0; j < nLat; j += strideLat) latIdx.push(j);
      if (latIdx[latIdx.length - 1] !== nLat - 1) latIdx.push(nLat - 1);

      const lonIdx: number[] = [];
      for (let i = 0; i < nLon; i += strideLon) lonIdx.push(i);
      if (lonIdx[lonIdx.length - 1] !== nLon - 1) lonIdx.push(nLon - 1);

      json = {
        lon: lonIdx.map((i) => Number(json!.lon[i])),
        lat: latIdx.map((j) => Number(json!.lat[j])),
        z: latIdx.map((j) => lonIdx.map((i) => Number((json!.z as any)[j][i]))),
      };
    }

    return json;
  } catch {
    return null;
  }
}

const DEFAULT_SCENE_CAMERA = {
  eye: { x: 1.65, y: -1.9, z: 0.6 },
};

export default function Basemap3D(props: {
  horizontalOverlay?: {
    enabled: boolean;
    imagePath: string;
    bounds: LonLatBounds;
    opacity?: number;
    mode?: "surface" | "bathy";
    colormap?: "rdylbu_r";
    valueRange?: { min: number; max: number };
    showScale?: boolean;
    flipLon?: boolean;
    flipLat?: boolean;
  };
  horizontalField?: HorizontalField;
  transectOverlay?: {
    enabled: boolean;
    imagePath: string;
    lat: number;
    bounds: LonDepthBounds;
    opacity?: number;
  };
  transectField?: TransectField;
  onStatusChange?: (status: {
    plotly: "loading" | "ready" | "failed";
    bathy: "loading" | "file" | "synthetic";
    horizontalImage: "off" | "loading" | "ready" | "failed";
    transectImage: "off" | "loading" | "ready" | "failed";
  }) => void;
  showBathyContours?: boolean;
}) {
  const [grid, setGrid] = useState<BathyGrid | null>(null);
  const [bathyStatus, setBathyStatus] = useState<"loading" | "file" | "synthetic">(
    "loading"
  );
  const [Plot, setPlot] = useState<React.ComponentType<any> | null>(null);
  const plotlyLibRef = useRef<any | null>(null);
  const didInitCameraRef = useRef(false);
  const [plotStatus, setPlotStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  const [horizontalImg, setHorizontalImg] = useState<ImageData | null>(null);
  const [transectImg, setTransectImg] = useState<ImageData | null>(null);
  const [horizontalImgStatus, setHorizontalImgStatus] = useState<
    "off" | "loading" | "ready" | "failed"
  >("off");
  const [transectImgStatus, setTransectImgStatus] = useState<
    "off" | "loading" | "ready" | "failed"
  >("off");

  const horizontalColorCacheRef = useRef<
    Map<
      string,
      {
        surfacecolor: number[][];
        colorscale: Array<[number, string]>;
        cmin: number;
        cmax: number;
      }
    >
  >(new Map());
  const transectCurtainCacheRef = useRef<
    Map<string, { x: number[]; y: number[]; z: number[][]; surfacecolor: number[][] }>
  >(new Map());

  useEffect(() => {
    let cancelled = false;
    tryLoadBathyJson().then((g) => {
      if (cancelled) return;
      setGrid(g);
      setBathyStatus(g ? "file" : "synthetic");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const overlay = props.horizontalOverlay;
    if (!overlay?.enabled) {
      setHorizontalImg(null);
      setHorizontalImgStatus("off");
      return;
    }
    let cancelled = false;
    setHorizontalImgStatus("loading");
    loadImageData(withBase(overlay.imagePath))
      .then((img) => {
        if (cancelled) return;
        // Clear cache entries if it grows too large.
        const cache = horizontalColorCacheRef.current;
        if (cache.size > 24) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        setHorizontalImg(img);
        setHorizontalImgStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load horizontal overlay image:", overlay.imagePath, e);
        setHorizontalImg(null);
        setHorizontalImgStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [props.horizontalOverlay?.enabled, props.horizontalOverlay?.imagePath]);

  useEffect(() => {
    const overlay = props.transectOverlay;
    if (!overlay?.enabled) {
      setTransectImg(null);
      setTransectImgStatus("off");
      return;
    }
    let cancelled = false;
    setTransectImgStatus("loading");
    loadImageData(withBase(overlay.imagePath))
      .then((img) => {
        if (cancelled) return;
        const cache = transectCurtainCacheRef.current;
        if (cache.size > 16) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        setTransectImg(img);
        setTransectImgStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load transect overlay image:", overlay.imagePath, e);
        setTransectImg(null);
        setTransectImgStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [props.transectOverlay?.enabled, props.transectOverlay?.imagePath]);

  useEffect(() => {
    let cancelled = false;
    setPlotStatus("loading");
    Promise.all([
      import("react-plotly.js/factory"),
      import("plotly.js-dist-min"),
    ])
      .then(([factory, plotly]) => {
        if (cancelled) return;
        const createPlotlyComponent =
          (factory as any)?.default ?? (factory as any);
        const Plotly = (plotly as any)?.default ?? (plotly as any);
        if (typeof createPlotlyComponent !== "function" || !Plotly) {
          setPlot(null);
          setPlotStatus("failed");
          return;
        }
        plotlyLibRef.current = Plotly;
        setPlot(() => createPlotlyComponent(Plotly));
        setPlotStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPlot(null);
        setPlotStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    props.onStatusChange?.({
      plotly: plotStatus,
      bathy: bathyStatus,
      horizontalImage: horizontalImgStatus,
      transectImage: transectImgStatus,
    });
  }, [bathyStatus, horizontalImgStatus, plotStatus, props.onStatusChange, transectImgStatus]);

  const bathy = useMemo(() => grid ?? makeSyntheticGreenlandSeaBathy(), [grid]);

  const colorscale332 = useMemo(() => makeDiscreteColorscale332(), []);
  const rdylbuPalette = useMemo<RGB[]>(() => rdylbu_r_256(), []);
  const rdylbuColorscale = useMemo(() => paletteToColorscale(rdylbuPalette), [rdylbuPalette]);

  function buildSstLookup(img: ImageData, vmin: number, vmax: number) {
    // Extract unique colors and order them along a reference RdYlBu_r palette
    // so interpolation behaves nicely while preserving the original PNG colors.
    const unique = new Map<number, { r: number; g: number; b: number }>();
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a < 10) continue;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const key = rgbKey(r, g, b);
      if (!unique.has(key)) unique.set(key, { r, g, b });
    }

    const denom = Math.max(1, rdylbuPalette.length - 1);
    const keyToValue = new Map<number, number>();
    for (const [key, c] of unique.entries()) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let k = 0; k < rdylbuPalette.length; k++) {
        const p = rdylbuPalette[k];
        const dist = Math.abs(c.r - p.r) + Math.abs(c.g - p.g) + Math.abs(c.b - p.b);
        if (dist < bestD) {
          bestD = dist;
          bestIdx = k;
          if (bestD === 0) break;
        }
      }
      const t = denom ? bestIdx / denom : 0;
      keyToValue.set(key, vmin + t * (vmax - vmin));
    }

    return { keyToValue, colorscale: rdylbuColorscale, cmin: vmin, cmax: vmax };
  }

  const horizontalColor = useMemo(() => {
    const overlay = props.horizontalOverlay;
    if (!overlay?.enabled || !horizontalImg) return null;

    const modeKey = overlay.colormap ?? "rgb332";
    const flipKey = `${overlay.flipLon ? 1 : 0}${overlay.flipLat ? 1 : 0}`;
    const rangeKey =
      overlay.colormap && overlay.valueRange
        ? `${overlay.valueRange.min}:${overlay.valueRange.max}`
        : "";
    const key = `${overlay.imagePath}|${modeKey}|${flipKey}|${rangeKey}`;

    const cached = horizontalColorCacheRef.current.get(key);
    if (cached) return cached;

    const { lonMin, lonMax, latMin, latMax } = overlay.bounds;
    const lonSpan = lonMax - lonMin;
    const latSpan = latMax - latMin;
    if (lonSpan === 0 || latSpan === 0) return null;

    const vmin = overlay.valueRange?.min ?? -1;
    const vmax = overlay.valueRange?.max ?? 5;
    const sstLookup =
      overlay.colormap === "rdylbu_r" ? buildSstLookup(horizontalImg, vmin, vmax) : null;

    const out: number[][] = [];
    for (let j = 0; j < bathy.lat.length; j++) {
      const row: number[] = [];
      const lat = bathy.lat[j];
      const vRaw = (latMax - lat) / latSpan; // top is latMax
      const v = overlay.flipLat ? 1 - vRaw : vRaw;
      const py = v * (horizontalImg.height - 1);
      for (let i = 0; i < bathy.lon.length; i++) {
        const lon = bathy.lon[i];
        const uRaw = (lon - lonMin) / lonSpan;
        const u = overlay.flipLon ? 1 - uRaw : uRaw;
        const px = u * (horizontalImg.width - 1);
        const { r, g, b, a } = getPixelRGBA(horizontalImg, px, py);
        if (a < 10) {
          row.push(Number.NaN);
          continue;
        }
        if (sstLookup) {
          const val = sstLookup.keyToValue.get(rgbKey(r, g, b));
          row.push(val ?? vmin);
        } else {
          row.push(rgbToIndex332(r, g, b));
        }
      }
      out.push(row);
    }

    const result = {
      surfacecolor: out,
      colorscale: (sstLookup ? sstLookup.colorscale : colorscale332) as Array<[number, string]>,
      cmin: sstLookup ? sstLookup.cmin : 0,
      cmax: sstLookup ? sstLookup.cmax : 255,
    };
    horizontalColorCacheRef.current.set(key, result);
    return result;
  }, [bathy.lat, bathy.lon, horizontalImg, props.horizontalOverlay]);

  const transectCurtain = useMemo(() => {
    const overlay = props.transectOverlay;
    if (!overlay?.enabled || !transectImg) return null;

    const key = `${overlay.imagePath}|${overlay.lat}|${overlay.bounds.lonMin}|${overlay.bounds.lonMax}|${overlay.bounds.depthMin}|${overlay.bounds.depthMax}`;
    const cached = transectCurtainCacheRef.current.get(key);
    if (cached) return cached;

    const { lonMin, lonMax, depthMin, depthMax } = overlay.bounds;
    const lonSpan = lonMax - lonMin;
    const depthSpan = depthMax - depthMin;
    if (lonSpan === 0 || depthSpan === 0) return null;

    const lon = bathy.lon.filter((x) => x >= Math.min(lonMin, lonMax) && x <= Math.max(lonMin, lonMax));
    const depth = (() => {
      const n = Math.max(40, Math.min(220, transectImg.height));
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(depthMin + (k * depthSpan) / (n - 1));
      return out;
    })();

    const x: number[] = lon;
    const y: number[] = depth.map(() => overlay.lat);
    const z: number[][] = [];
    const surfacecolor: number[][] = [];

    for (let j = 0; j < depth.length; j++) {
      const depthM = depth[j];
      const v = (depthM - depthMin) / depthSpan; // top is depthMin (usually 0)
      const py = v * (transectImg.height - 1);
      const zRow: number[] = [];
      const cRow: number[] = [];
      for (let i = 0; i < x.length; i++) {
        const lonVal = x[i];
        const u = (lonVal - lonMin) / lonSpan;
        const px = u * (transectImg.width - 1);
        const { r, g, b, a } = getPixelRGBA(transectImg, px, py);
        zRow.push(-depthM);
        cRow.push(a < 10 ? 0 : rgbToIndex332(r, g, b));
      }
      z.push(zRow);
      surfacecolor.push(cRow);
    }

    const result = { x, y, z, surfacecolor };
    transectCurtainCacheRef.current.set(key, result);
    return result;
  }, [bathy.lon, props.transectOverlay, transectImg]);

  const data = useMemo<Partial<PlotData>[]>(() => {
    const numericH = props.horizontalField?.enabled ? props.horizontalField : null;
    const pngOverlayEnabled = Boolean(props.horizontalOverlay?.enabled && horizontalColor);
    const overlayEnabled = Boolean(numericH || pngOverlayEnabled);
    const overlayMode = numericH?.mode ?? props.horizontalOverlay?.mode ?? "surface";
    const textureOnBathy = overlayEnabled && overlayMode === "bathy";

    const overlaySurfacecolor = (() => {
      const fieldValues = numericH?.values;
      if (!fieldValues) return horizontalColor?.surfacecolor as any;
      const nRows = fieldValues.length;
      const nCols = fieldValues[0]?.length ?? 0;
      if (nRows === bathy.lat.length && nCols === bathy.lon.length) return fieldValues;
      if (!numericH?.lon || !numericH?.lat) return fieldValues;

      // Nearest-neighbor resampling from field grid onto bathy grid.
      // Precompute lon/lat index maps.
      const lonMap = bathy.lon.map((x) => {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < numericH.lon!.length; i++) {
          const d = Math.abs(numericH.lon![i] - x);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        return best;
      });
      const latMap = bathy.lat.map((y) => {
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < numericH.lat!.length; j++) {
          const d = Math.abs(numericH.lat![j] - y);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        return best;
      });

      const out: number[][] = new Array(bathy.lat.length);
      for (let j = 0; j < bathy.lat.length; j++) {
        const srcJ = latMap[j];
        const srcRow = fieldValues[srcJ] ?? [];
        const row: number[] = new Array(bathy.lon.length);
        for (let i = 0; i < bathy.lon.length; i++) {
          row[i] = Number(srcRow[lonMap[i]]);
        }
        out[j] = row;
      }
      return out;
    })();
    const overlayColorscale = (numericH?.colorscale ?? horizontalColor?.colorscale) as
      | Array<[number, string]>
      | undefined;
    const overlayCmin = numericH?.cmin ?? horizontalColor?.cmin;
    const overlayCmax = numericH?.cmax ?? horizontalColor?.cmax;
    const overlayOpacity = numericH?.opacity ?? props.horizontalOverlay?.opacity ?? 0.85;
    const showOverlayScale = Boolean(numericH?.showScale ?? props.horizontalOverlay?.showScale);
    const overlayColorbarTitle = numericH?.colorbarTitle ?? "Value";
    const overlayColorbarTicks =
      numericH?.colorbarTicks ??
      (props.horizontalOverlay?.showScale ? [-1, 0, 1, 2, 3, 4, 5] : undefined);

    const showContours = Boolean(props.showBathyContours);
    const traces: Partial<PlotData>[] = [];

    traces.push({
      type: "surface",
      name: textureOnBathy ? "Bathy (textured)" : "Bathy",
      x: bathy.lon,
      y: bathy.lat,
      z: bathy.z,
      ...(textureOnBathy
        ? {
            surfacecolor: overlaySurfacecolor as any,
            cmin: overlayCmin,
            cmax: overlayCmax,
            colorscale: overlayColorscale as any,
            lighting: {
              ambient: 0.95,
              diffuse: 0.35,
              specular: 0.05,
              roughness: 0.95,
            } as any,
            flatshading: true as any,
          }
        : {
            colorscale: [
              [0.0, "#06162a"],
              [0.2, "#0b2b4a"],
              [0.45, "#124f6a"],
              [0.7, "#2f7e74"],
              [1.0, "#a0c7a0"],
            ],
            lighting: {
              ambient: 0.8,
              diffuse: 0.35,
              specular: 0.05,
              roughness: 0.95,
            } as any,
          }),
      contours: {
        z: {
          show: showContours,
          highlight: showContours,
          usecolormap: false,
          color: "rgba(255,255,255,0.10)",
          highlightcolor: "limegreen",
          project: { z: false },
        },
      } as any,
      showscale: textureOnBathy ? showOverlayScale : false,
      ...(textureOnBathy && showOverlayScale
        ? {
            colorbar: {
              title: { text: overlayColorbarTitle },
              ...(overlayColorbarTicks
                ? { tickmode: "array", tickvals: overlayColorbarTicks }
                : null),
              ticks: "outside",
              len: 0.55,
            } as any,
          }
        : null),
      opacity: 1,
    });

    if (
      overlayEnabled &&
      overlayMode === "surface"
    ) {
      const bounds = numericH?.bounds ?? props.horizontalOverlay?.bounds;
      const zPlane = numericH?.zPlane ?? 0;
      const zSheet = bathy.z.map((row, j) =>
        row.map((_, i) => {
          const val = overlaySurfacecolor?.[j]?.[i];
          if (val === undefined || !Number.isFinite(val)) return Number.NaN;
          if (bounds) {
            const { lonMin, lonMax, latMin, latMax } = bounds;
            const lon = bathy.lon[i];
            const lat = bathy.lat[j];
            const inside =
              lon >= Math.min(lonMin, lonMax) &&
              lon <= Math.max(lonMin, lonMax) &&
              lat >= Math.min(latMin, latMax) &&
              lat <= Math.max(latMin, latMax);
            if (!inside) return Number.NaN;
          }
          return zPlane;
        })
      );
      traces.push({
        type: "surface",
        name: "Overlay (surface)",
        x: bathy.lon,
        y: bathy.lat,
        z: zSheet,
        surfacecolor: overlaySurfacecolor as any,
        cmin: overlayCmin,
        cmax: overlayCmax,
        colorscale: overlayColorscale as any,
        showscale: showOverlayScale,
        ...(showOverlayScale
          ? {
              colorbar: {
                title: { text: overlayColorbarTitle },
                ...(overlayColorbarTicks
                  ? { tickmode: "array", tickvals: overlayColorbarTicks }
                  : null),
                ticks: "outside",
                len: 0.55,
              } as any,
            }
          : null),
        opacity: overlayOpacity,
        lighting: { ambient: 1.0, diffuse: 0.15, specular: 0.0, roughness: 1.0 } as any,
        flatshading: true as any,
        hoverinfo: "skip",
      });
    }

    const numericT = props.transectField?.enabled ? props.transectField : null;
    if (numericT) {
      const zCurtain = numericT.z.map((zv) => numericT.lon.map(() => zv));
      const opacity = numericT.opacity ?? 0.9;
      traces.push({
        type: "surface",
        name: "Transect",
        x: numericT.lon,
        y: numericT.z.map(() => numericT.lat),
        z: zCurtain as any,
        surfacecolor: numericT.values as any,
        cmin: numericT.cmin,
        cmax: numericT.cmax,
        colorscale: numericT.colorscale as any,
        showscale: Boolean(numericT.showScale),
        ...(numericT.showScale
          ? {
              colorbar: {
                title: { text: numericT.colorbarTitle ?? "Value" },
                ...(numericT.colorbarTicks
                  ? { tickmode: "array", tickvals: numericT.colorbarTicks }
                  : null),
                ticks: "outside",
                len: 0.55,
              } as any,
            }
          : null),
        opacity,
        hoverinfo: "skip",
      });
    } else if (props.transectOverlay?.enabled && transectCurtain) {
      const opacity = props.transectOverlay.opacity ?? 0.9;
      traces.push({
        type: "surface",
        x: transectCurtain.x,
        y: transectCurtain.y,
        z: transectCurtain.z as any,
        surfacecolor: transectCurtain.surfacecolor as any,
        cmin: 0,
        cmax: 255,
        colorscale: colorscale332 as any,
        showscale: false,
        opacity,
        hoverinfo: "skip",
      });
    }

    return traces;
  }, [
    bathy,
    horizontalColor,
    props.horizontalField,
    props.horizontalOverlay?.enabled,
    props.horizontalOverlay?.showScale,
    props.horizontalOverlay?.mode,
    props.horizontalOverlay?.opacity,
    props.transectField,
    props.transectOverlay?.enabled,
    props.transectOverlay?.opacity,
    props.showBathyContours,
    transectCurtain,
  ]);

  const layout = useMemo<Partial<Layout>>(
    () => ({
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: "rgba(0,0,0,0)",
      // Preserve user camera/zoom across updates (e.g., SST animation frames).
      uirevision: "keep",
      scene: {
        // Preserve 3D camera across updates while animating.
        uirevision: "keep",
        xaxis: { title: "Longitude", showgrid: false, zeroline: false },
        yaxis: { title: "Latitude", showgrid: false, zeroline: false },
        zaxis: { title: "Depth (m)", showgrid: false, zeroline: false },
        dragmode: "orbit",
        aspectmode: "manual",
        aspectratio: { x: 1.1, y: 1.0, z: 0.35 },
      }
    }),
    []
  );

  const plotConfig = useMemo(
    () => ({
      displayModeBar: false,
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
    }),
    []
  );

  const handleInitialized = useCallback((_: any, graphDiv: any) => {
    if (didInitCameraRef.current) return;
    didInitCameraRef.current = true;
    const Plotly = plotlyLibRef.current;
    if (!Plotly || !graphDiv) return;
    // Set a good initial view once; after that, user interactions are preserved via uirevision.
    try {
      void Plotly.relayout(graphDiv, { "scene.camera": DEFAULT_SCENE_CAMERA });
    } catch {
      // ignore
    }
  }, []);

  if (!Plot) {
    return (
      <div
        className="basemap"
        style={{
          background:
            "radial-gradient(1000px 800px at 55% 20%, rgba(103,232,249,0.18) 0%, rgba(167,139,250,0.10) 25%, rgba(0,0,0,0) 55%)",
        }}
      >
        {plotStatus === "loading" ? (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.25)",
              color: "rgba(255,255,255,0.72)",
              fontSize: 12,
            }}
          >
            Loading 3D bathymetry…
          </div>
        ) : null}
        {plotStatus === "failed" ? (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 12,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              color: "rgba(255,255,255,0.78)",
              fontSize: 12,
              maxWidth: 520,
            }}
          >
            Plotly failed to load. Open DevTools Console to see the error.
            {typeof location !== "undefined" && location.protocol === "file:" ? (
              <div style={{ marginTop: 6 }}>
                Tip: use <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" }}>npm start</span> or{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" }}>npm run preview</span> (fetch is blocked on file://).
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="basemap">
      <Plot
        data={data as PlotData[]}
        layout={layout as Layout}
        config={plotConfig}
        onInitialized={handleInitialized}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
    </div>
  );
}
