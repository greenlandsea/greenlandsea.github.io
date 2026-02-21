import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Basemap3D from "./components/Basemap3D";
import {
  balance_256,
  blues_r_256,
  deep_256,
  haline_256,
  ice_256,
  paletteToColorscale,
  plasma_256,
  rdylbu_r_256,
  thermal_256,
  topo_256,
  viridis_256,
  type RGB,
} from "./lib/colormap";
import {
  loadGsZarrMeta,
  load3DFieldAtTime,
  loadHorizontalSlice,
  loadSeaIce2D,
  loadWindStress2D,
  loadTransectSlice,
  nearestIndex,
  type GsZarrMeta,
} from "./lib/gsZarr";

type ViewMode = "horizontal" | "transect" | "class";
type VarId = "T" | "S";
type ColorscaleMode = "continuous" | "discrete";
type FieldColormapId = "thermal" | "haline" | "balance" | "rdylbu_r" | "viridis" | "plasma";
type BathyColormapId = "deep" | "topo" | "blues_r" | "viridis" | "haline";

type VarColorSettings = {
  cmin: number;
  cmax: number;
  tickCount: number; // 0 => auto
  mode: ColorscaleMode;
  levels: number; // used when mode === "discrete"
};

type ClassSettings = {
  min: number;
  max: number;
  interval: number;
  halfWidth: number;
};

type ClassInputSettings = {
  min: string;
  max: string;
};

type HorizontalGrid = {
  values: number[][];
  lon: number[];
  lat: number[];
};

type TransectGrid = {
  values: number[][];
  lon: number[];
  z: number[];
};

type VectorGrid = {
  u: number[][];
  v: number[][];
  lon: number[];
  lat: number[];
};

type ClassTrace = {
  label: string;
  value: number;
  x: number[];
  y: number[];
  z: number[];
};

const PLAYBACK_SURFACE_MAX = 180;
const PLAYBACK_TRANSECT_LON_MAX = 220;
const PLAYBACK_TRANSECT_DEPTH_MAX = 110;
const PLAYBACK_SEA_ICE_MAX = 150;
const PLAYBACK_WIND_MAX = 110;
const CLASS_MAX_XY_PLAYING = 70;
const CLASS_MAX_XY_PAUSED = 110;
const CLASS_MAX_Z_PLAYING = 24;
const CLASS_MAX_Z_PAUSED = 36;
const CLASS_POINTS_PER_CLASS_PLAYING = 700;
const CLASS_POINTS_PER_CLASS_PAUSED = 1400;

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function defaultRange(varId: VarId) {
  if (varId === "T") return { min: -1, max: 8, ticks: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8], title: "Temperature (°C)" };
  return {
    min: 34,
    max: 35.6,
    ticks: [34, 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9, 35, 35.1, 35.2, 35.3, 35.4, 35.5, 35.6],
    title: "Salinity (g/kg)",
  };
}

const FIELD_COLORMAP_OPTIONS: Array<{ id: FieldColormapId; label: string }> = [
  { id: "thermal", label: "cmocean thermal" },
  { id: "haline", label: "cmocean haline" },
  { id: "balance", label: "cmocean balance" },
  { id: "rdylbu_r", label: "RdYlBu_r" },
  { id: "viridis", label: "Viridis" },
  { id: "plasma", label: "Plasma" },
];

const BATHY_COLORMAP_OPTIONS: Array<{ id: BathyColormapId; label: string }> = [
  { id: "deep", label: "cmocean deep" },
  { id: "topo", label: "cmocean topo" },
  { id: "blues_r", label: "Blues_r" },
  { id: "viridis", label: "Viridis" },
  { id: "haline", label: "cmocean haline" },
];

const DEFAULT_FIELD_COLORMAP: Record<VarId, FieldColormapId> = {
  T: "rdylbu_r",
  S: "rdylbu_r",
};

const DEFAULT_BATHY_COLORMAP: BathyColormapId = "deep";

function paletteForColormapId(id: FieldColormapId | BathyColormapId): RGB[] {
  switch (id) {
    case "thermal":
      return thermal_256();
    case "haline":
      return haline_256();
    case "balance":
      return balance_256();
    case "rdylbu_r":
      return rdylbu_r_256();
    case "viridis":
      return viridis_256();
    case "plasma":
      return plasma_256();
    case "deep":
      return deep_256();
    case "topo":
      return topo_256();
    case "blues_r":
      return blues_r_256();
    default:
      return thermal_256();
  }
}

const FALLBACK_FIELD_PALETTE = thermal_256();
const FALLBACK_FIELD_CONTINUOUS = paletteToColorscale(FALLBACK_FIELD_PALETTE);

const DEFAULT_COLOR_SETTINGS: Record<VarId, VarColorSettings> = {
  T: { cmin: -1, cmax: 8, tickCount: 10, mode: "continuous", levels: 12 },
  S: { cmin: 34, cmax: 35.6, tickCount: 17, mode: "continuous", levels: 12 },
};

const TICK_OPTIONS_BY_VAR: Record<VarId, number[]> = {
  T: [5, 7, 9, 10, 11, 13],
  S: [5, 7, 9, 11, 13, 15, 17, 21, 25],
};

const DEFAULT_CLASS_SETTINGS: Record<VarId, ClassSettings> = {
  T: { min: -1, max: 8, interval: 1, halfWidth: 0.3 },
  S: { min: 34, max: 35.6, interval: 0.2, halfWidth: 0.1 },
};

const CLASS_INTERVAL_OPTIONS: Record<VarId, number[]> = {
  T: [0.5, 1, 2],
  S: [0.1, 0.2, 0.5],
};

const CLASS_HALF_WIDTH_OPTIONS: Record<VarId, number[]> = {
  T: [0.2, 0.3, 0.5],
  S: [0.05, 0.1, 0.2],
};

const SEA_ICE_THRESHOLD = 0.3;
const SEA_ICE_HEIGHT_M = 5;
const SEA_ICE_OPACITY = 0.55;

function makeTicks(min: number, max: number, tickCount: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (tickCount <= 1 || min === max) return undefined;
  const out: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    out.push(min + (i * (max - min)) / (tickCount - 1));
  }
  return out;
}

function computeMinMax(values: number[][], opts?: { ignoreExactZero?: boolean }) {
  const ignoreExactZero = Boolean(opts?.ignoreExactZero);
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (!Number.isFinite(v)) continue;
      if (ignoreExactZero && v === 0) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function parseFiniteNumberInput(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleIndices(length: number, targetCount: number) {
  if (!Number.isFinite(length) || length <= 0) return [];
  if (!Number.isFinite(targetCount) || targetCount <= 0 || targetCount >= length) {
    return Array.from({ length }, (_, i) => i);
  }
  const n = Math.max(2, Math.min(length, Math.round(targetCount)));
  if (n >= length) return Array.from({ length }, (_, i) => i);

  const out: number[] = [];
  const step = (length - 1) / (n - 1);
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const idx = Math.round(k * step);
    if (idx !== prev) {
      out.push(idx);
      prev = idx;
    }
  }
  if (out[0] !== 0) out.unshift(0);
  if (out[out.length - 1] !== length - 1) out.push(length - 1);
  return out;
}

function downsampleRowsCols(values: number[][], rowIndices: number[], colIndices: number[]) {
  return rowIndices.map((j) => {
    const src = values[j] ?? [];
    return colIndices.map((i) => Number(src[i]));
  });
}

function downsampleHorizontalGrid(
  values: number[][],
  lon: number[],
  lat: number[],
  maxLon: number,
  maxLat: number
): HorizontalGrid {
  if (!values.length || !values[0]?.length || !lon.length || !lat.length) return { values, lon, lat };
  if (lon.length <= maxLon && lat.length <= maxLat) return { values, lon, lat };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const latIdx = sampleIndices(lat.length, maxLat);
  return {
    lon: lonIdx.map((i) => lon[i]),
    lat: latIdx.map((j) => lat[j]),
    values: downsampleRowsCols(values, latIdx, lonIdx),
  };
}

function downsampleTransectGrid(
  values: number[][],
  lon: number[],
  z: number[],
  maxLon: number,
  maxDepth: number
): TransectGrid {
  if (!values.length || !values[0]?.length || !lon.length || !z.length) return { values, lon, z };
  if (lon.length <= maxLon && z.length <= maxDepth) return { values, lon, z };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const zIdx = sampleIndices(z.length, maxDepth);
  return {
    lon: lonIdx.map((i) => lon[i]),
    z: zIdx.map((j) => z[j]),
    values: downsampleRowsCols(values, zIdx, lonIdx),
  };
}

function downsampleVectorGrid(
  u: number[][],
  v: number[][],
  lon: number[],
  lat: number[],
  maxLon: number,
  maxLat: number
): VectorGrid {
  if (!u.length || !u[0]?.length || !v.length || !v[0]?.length || !lon.length || !lat.length) {
    return { u, v, lon, lat };
  }
  if (lon.length <= maxLon && lat.length <= maxLat) return { u, v, lon, lat };
  const lonIdx = sampleIndices(lon.length, maxLon);
  const latIdx = sampleIndices(lat.length, maxLat);
  return {
    lon: lonIdx.map((i) => lon[i]),
    lat: latIdx.map((j) => lat[j]),
    u: latIdx.map((j) => {
      const row = u[j] ?? [];
      return lonIdx.map((i) => Number(row[i]));
    }),
    v: latIdx.map((j) => {
      const row = v[j] ?? [];
      return lonIdx.map((i) => Number(row[i]));
    }),
  };
}

function classCenters(cmin: number, cmax: number, step: number) {
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || !Number.isFinite(step) || step <= 0) return [];
  const min = Math.min(cmin, cmax);
  const max = Math.max(cmin, cmax);
  const out: number[] = [];
  for (let value = min; value <= max + step * 1e-6; value += step) {
    out.push(Number(value.toFixed(6)));
    if (out.length >= 240) break;
  }
  if (out.length === 0) return [];
  const last = out[out.length - 1];
  if (last < max - step * 0.25 && out.length < 240) out.push(Number(max.toFixed(6)));
  return out;
}

function formatClassLabel(varId: VarId, value: number, interval: number, withUnit = true) {
  const digits = varId === "T" ? (interval >= 1 ? 0 : 1) : interval >= 0.2 ? 1 : 2;
  const text = value.toFixed(digits);
  if (!withUnit) return text;
  return varId === "T" ? `${text}°C` : `${text} g/kg`;
}

function classColorAt(value: number, cmin: number, cmax: number, palette: RGB[]) {
  if (!Number.isFinite(value) || !Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) {
    const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
    const mid = safePalette[Math.floor(safePalette.length / 2)];
    return `rgb(${mid.r},${mid.g},${mid.b})`;
  }
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const t = clamp((value - cmin) / (cmax - cmin), 0, 1);
  const idx = Math.max(0, Math.min(safePalette.length - 1, Math.round(t * (safePalette.length - 1))));
  const c = safePalette[idx];
  return `rgb(${c.r},${c.g},${c.b})`;
}

function makeClassDiscreteColorscale(
  classValues: number[],
  cmin: number,
  cmax: number,
  palette: RGB[]
): Array<[number, string]> {
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const fallbackScale = safePalette.length
    ? paletteToColorscale(safePalette)
    : FALLBACK_FIELD_CONTINUOUS;
  if (!Number.isFinite(cmin) || !Number.isFinite(cmax) || cmax <= cmin) return fallbackScale;
  const values = Array.from(
    new Set(classValues.filter((v) => Number.isFinite(v)).map((v) => Number(v.toFixed(6))))
  ).sort((a, b) => a - b);
  if (!values.length) return fallbackScale;
  if (values.length === 1) {
    const color = classColorAt(values[0], cmin, cmax, safePalette);
    return [
      [0, color],
      [1, color],
    ];
  }
  const boundaries: number[] = [cmin];
  for (let i = 0; i < values.length - 1; i++) {
    boundaries.push((values[i] + values[i + 1]) / 2);
  }
  boundaries.push(cmax);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < values.length; i++) {
    const color = classColorAt(values[i], cmin, cmax, safePalette);
    const t0 = clamp((boundaries[i] - cmin) / (cmax - cmin), 0, 1);
    const t1 = clamp((boundaries[i + 1] - cmin) / (cmax - cmin), 0, 1);
    out.push([t0, color], [t1, color]);
  }
  out[0][0] = 0;
  out[out.length - 1][0] = 1;
  return out;
}

function pickClassTicks(values: number[], maxTicks: number) {
  if (values.length <= maxTicks) return values;
  const idx = sampleIndices(values.length, maxTicks);
  return idx.map((i) => values[i]);
}

function makeDiscreteColorscale(levels: number, palette: RGB[]) {
  const safePalette = palette.length ? palette : FALLBACK_FIELD_PALETTE;
  const n = Math.max(2, Math.min(levels, safePalette.length));
  const toCss = (c: { r: number; g: number; b: number }) => `rgb(${c.r},${c.g},${c.b})`;
  const sampled = Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const idx = Math.round(t * (safePalette.length - 1));
    return safePalette[idx];
  });
  const out: Array<[number, string]> = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const color = toCss(sampled[i]);
    out.push([t0, color], [t1, color]);
  }
  out[out.length - 1][0] = 1;
  return out;
}

function ToggleSwitch(props: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const { checked, onCheckedChange, disabled, title } = props;
  return (
    <button
      type="button"
      className={`toggle ${checked ? "toggleOn" : ""}`}
      onClick={() => {
        if (disabled) return;
        onCheckedChange(!checked);
      }}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      title={title}
    >
      <span className="toggleKnob" />
    </button>
  );
}

export default function App() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [cameraResetNonce, setCameraResetNonce] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const [themeMode, setThemeMode] = useState<"night" | "day">(() => {
    try {
      const saved = window.localStorage.getItem("gs_theme_mode");
      if (saved === "day" || saved === "night") return saved;
    } catch {
      // ignore
    }
    return "night";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem("gs_panel_open", panelOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [panelOpen]);

  useEffect(() => {
    try {
      document.body.setAttribute("data-theme", themeMode);
      window.localStorage.setItem("gs_theme_mode", themeMode);
    } catch {
      // ignore
    }
  }, [themeMode]);

  const [viewMode, setViewMode] = useState<ViewMode>("horizontal");
  const [varId, setVarId] = useState<VarId>("T");
  const projectOn3d = true;
  const [overlayOpacity, setOverlayOpacity] = useState(0.9);
  const [showColorbar, setShowColorbar] = useState(true);
  const [showFieldContours, setShowFieldContours] = useState(false);
  const [showBathy, setShowBathy] = useState(true);
  const [showBathyContours, setShowBathyContours] = useState(false);
  const [depthRatio, setDepthRatio] = useState(0.35);
  const [depthWarpMode, setDepthWarpMode] = useState<"linear" | "upper">("upper");
  const [depthFocusM, setDepthFocusM] = useState(2500);
  const [deepRatio, setDeepRatio] = useState(0.25);
  const [colorSettings, setColorSettings] = useState<Record<VarId, VarColorSettings>>(
    DEFAULT_COLOR_SETTINGS
  );
  const [fieldColormapByVar, setFieldColormapByVar] = useState<Record<VarId, FieldColormapId>>(
    DEFAULT_FIELD_COLORMAP
  );
  const [bathyColormap, setBathyColormap] = useState<BathyColormapId>(DEFAULT_BATHY_COLORMAP);
  const [colorInputByVar, setColorInputByVar] = useState<Record<VarId, ClassInputSettings>>({
    T: {
      min: String(DEFAULT_COLOR_SETTINGS.T.cmin),
      max: String(DEFAULT_COLOR_SETTINGS.T.cmax),
    },
    S: {
      min: String(DEFAULT_COLOR_SETTINGS.S.cmin),
      max: String(DEFAULT_COLOR_SETTINGS.S.cmax),
    },
  });
  const [classSettingsByVar, setClassSettingsByVar] = useState<Record<VarId, ClassSettings>>(
    DEFAULT_CLASS_SETTINGS
  );
  const [classInputByVar, setClassInputByVar] = useState<Record<VarId, ClassInputSettings>>({
    T: {
      min: String(DEFAULT_CLASS_SETTINGS.T.min),
      max: String(DEFAULT_CLASS_SETTINGS.T.max),
    },
    S: {
      min: String(DEFAULT_CLASS_SETTINGS.S.min),
      max: String(DEFAULT_CLASS_SETTINGS.S.max),
    },
  });
  const [showSeaIce, setShowSeaIce] = useState(true);
  const [showWind, setShowWind] = useState(false);

  const [timeIdx, setTimeIdx] = useState(0);
  const [depthIdx, setDepthIdx] = useState(0);
  const [latTarget, setLatTarget] = useState(75);
  const [latTargetInput, setLatTargetInput] = useState("75");
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(1);

  const [metaStatus, setMetaStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [meta, setMeta] = useState<GsZarrMeta | null>(null);

  const [sliceStatus, setSliceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [classStatus, setClassStatus] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [classError, setClassError] = useState<string | null>(null);

  const [seaIceStatus, setSeaIceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [seaIceError, setSeaIceError] = useState<string | null>(null);
  const [windStatus, setWindStatus] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [windError, setWindError] = useState<string | null>(null);

  const [horizontalValues, setHorizontalValues] = useState<number[][] | null>(null);
  const [transectValues, setTransectValues] = useState<number[][] | null>(null);
  const [transectLatActual, setTransectLatActual] = useState<number | null>(null);
  const [classTraces, setClassTraces] = useState<ClassTrace[] | null>(null);
  const [seaIceValues, setSeaIceValues] = useState<number[][] | null>(null);
  const [windStress, setWindStress] = useState<{ u: number[][]; v: number[][] } | null>(null);

  const [bathyInfo, setBathyInfo] = useState<{
    plotly: "loading" | "ready" | "failed";
    bathy: "loading" | "file" | "synthetic";
  }>({ plotly: "loading", bathy: "loading" });

  const handleStatusChange = useCallback(
    (s: { plotly: "loading" | "ready" | "failed"; bathy: "loading" | "file" | "synthetic" }) =>
      setBathyInfo({ plotly: s.plotly, bathy: s.bathy }),
    []
  );

  const range = useMemo(() => defaultRange(varId), [varId]);
  const settings = colorSettings[varId];
  const classSettings = classSettingsByVar[varId];
  const classInputs = classInputByVar[varId];
  const colorInputs = colorInputByVar[varId];
  const classMin = Math.min(classSettings.min, classSettings.max);
  const classMax = Math.max(classSettings.min, classSettings.max);
  const classInterval = classSettings.interval;
  const classHalfWidth = classSettings.halfWidth;
  const fieldPalette = useMemo(() => paletteForColormapId(fieldColormapByVar[varId]), [fieldColormapByVar, varId]);
  const fieldContinuousColorscale = useMemo(() => paletteToColorscale(fieldPalette), [fieldPalette]);
  const bathyPalette = useMemo(() => paletteForColormapId(bathyColormap), [bathyColormap]);
  const colorscale = useMemo(() => {
    return settings.mode === "discrete"
      ? makeDiscreteColorscale(settings.levels, fieldPalette)
      : fieldContinuousColorscale;
  }, [fieldContinuousColorscale, fieldPalette, settings.levels, settings.mode]);
  const colorbarTicks = useMemo(
    () => (settings.tickCount > 0 ? makeTicks(settings.cmin, settings.cmax, settings.tickCount) : undefined),
    [settings.cmax, settings.cmin, settings.tickCount]
  );
  const hasSeaIceColorbar = projectOn3d && showSeaIce;
  const mainColorbarLayout = useMemo(
    () =>
      hasSeaIceColorbar && showColorbar
        ? { x: 1.03, y: 0.69, len: 0.60 }
        : { x: 1.03, y: 0.50, len: 0.84 },
    [hasSeaIceColorbar, showColorbar]
  );
  const seaIceColorbarLayout = useMemo(
    () =>
      showColorbar
        ? { x: 1.03, y: 0.17, len: 0.26 }
        : { x: 1.03, y: 0.50, len: 0.84 },
    [showColorbar]
  );

  const timeList = meta?.timeIso ?? [];
  const zList = meta?.z ?? [];
  const latMin = meta?.lat?.length ? Math.min(...meta.lat) : 71;
  const latMax = meta?.lat?.length ? Math.max(...meta.lat) : 81.5;
  const safeTimeIdx = Math.max(0, Math.min(timeIdx, Math.max(0, timeList.length - 1)));
  const safeDepthIdx = Math.max(0, Math.min(depthIdx, Math.max(0, zList.length - 1)));
  const activeTimeLabel = timeList[safeTimeIdx] ?? "n/a";
  const activeDepthLabel = zList.length ? `${Math.round(zList[safeDepthIdx])} m` : "n/a";

  const availableVars = useMemo(() => {
    const vars = meta?.variables?.filter((v) => v.available).map((v) => v.id) ?? [];
    return vars.length ? (vars as VarId[]) : (["T"] as VarId[]);
  }, [meta]);

  useEffect(() => {
    const nextMin = String(classSettings.min);
    const nextMax = String(classSettings.max);
    setClassInputByVar((prev) => {
      const curr = prev[varId];
      if (curr?.min === nextMin && curr?.max === nextMax) return prev;
      return {
        ...prev,
        [varId]: { min: nextMin, max: nextMax },
      };
    });
  }, [classSettings.max, classSettings.min, varId]);

  useEffect(() => {
    const nextMin = String(settings.cmin);
    const nextMax = String(settings.cmax);
    setColorInputByVar((prev) => {
      const curr = prev[varId];
      if (curr?.min === nextMin && curr?.max === nextMax) return prev;
      return {
        ...prev,
        [varId]: { min: nextMin, max: nextMax },
      };
    });
  }, [settings.cmax, settings.cmin, varId]);

  useEffect(() => {
    setLatTargetInput(String(Number(latTarget.toFixed(3))));
  }, [latTarget]);

  const commitClassInput = useCallback(
    (bound: "min" | "max") => {
      const raw = (classInputByVar[varId]?.[bound] ?? "").trim();
      const parsed = parseFiniteNumberInput(raw);
      const fallback = bound === "min" ? classSettings.min : classSettings.max;
      if (parsed != null) {
        setClassSettingsByVar((prev) => ({
          ...prev,
          [varId]: { ...prev[varId], [bound]: parsed },
        }));
        setClassInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(parsed),
          },
        }));
      } else {
        setClassInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(fallback),
          },
        }));
      }
    },
    [classInputByVar, classSettings.max, classSettings.min, varId]
  );

  const updateClassInputLive = useCallback(
    (bound: "min" | "max", rawValue: string) => {
      setClassInputByVar((prev) => ({
        ...prev,
        [varId]: { ...(prev[varId] ?? { min: "", max: "" }), [bound]: rawValue },
      }));
      const parsed = parseFiniteNumberInput(rawValue);
      if (parsed == null) return;
      setClassSettingsByVar((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          [bound]: parsed,
        },
      }));
    },
    [varId]
  );

  const commitColorInput = useCallback(
    (bound: "min" | "max") => {
      const raw = (colorInputByVar[varId]?.[bound] ?? "").trim();
      const parsed = parseFiniteNumberInput(raw);
      const fallback = bound === "min" ? settings.cmin : settings.cmax;
      const colorKey = bound === "min" ? "cmin" : "cmax";
      if (parsed != null) {
        setColorSettings((prev) => ({
          ...prev,
          [varId]: {
            ...prev[varId],
            [colorKey]: parsed,
          },
        }));
        setColorInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(parsed),
          },
        }));
      } else {
        setColorInputByVar((prev) => ({
          ...prev,
          [varId]: {
            ...(prev[varId] ?? { min: "", max: "" }),
            [bound]: String(fallback),
          },
        }));
      }
    },
    [colorInputByVar, settings.cmax, settings.cmin, varId]
  );

  const updateColorInputLive = useCallback(
    (bound: "min" | "max", rawValue: string) => {
      setColorInputByVar((prev) => ({
        ...prev,
        [varId]: { ...(prev[varId] ?? { min: "", max: "" }), [bound]: rawValue },
      }));
      const parsed = parseFiniteNumberInput(rawValue);
      if (parsed == null) return;
      const colorKey = bound === "min" ? "cmin" : "cmax";
      setColorSettings((prev) => ({
        ...prev,
        [varId]: {
          ...prev[varId],
          [colorKey]: parsed,
        },
      }));
    },
    [varId]
  );

  const commitLatTargetInput = useCallback(() => {
    const raw = latTargetInput.trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed, latMin, latMax);
      setLatTarget(clamped);
      setLatTargetInput(String(Number(clamped.toFixed(3))));
    } else {
      setLatTargetInput(String(Number(latTarget.toFixed(3))));
    }
  }, [latMax, latMin, latTarget, latTargetInput]);

  const horizontalRender = useMemo<HorizontalGrid | null>(() => {
    if (!meta || !horizontalValues) return null;
    if (!playing) return { values: horizontalValues, lon: meta.lon, lat: meta.lat };
    return downsampleHorizontalGrid(
      horizontalValues,
      meta.lon,
      meta.lat,
      PLAYBACK_SURFACE_MAX,
      PLAYBACK_SURFACE_MAX
    );
  }, [horizontalValues, meta, playing]);

  const transectRender = useMemo<TransectGrid | null>(() => {
    if (!meta || !transectValues) return null;
    if (!playing) return { values: transectValues, lon: meta.lon, z: meta.z };
    return downsampleTransectGrid(
      transectValues,
      meta.lon,
      meta.z,
      PLAYBACK_TRANSECT_LON_MAX,
      PLAYBACK_TRANSECT_DEPTH_MAX
    );
  }, [meta, playing, transectValues]);

  const seaIceRender = useMemo<HorizontalGrid | null>(() => {
    if (!meta || !seaIceValues) return null;
    if (!playing) return { values: seaIceValues, lon: meta.lon, lat: meta.lat };
    return downsampleHorizontalGrid(
      seaIceValues,
      meta.lon,
      meta.lat,
      PLAYBACK_SEA_ICE_MAX,
      PLAYBACK_SEA_ICE_MAX
    );
  }, [meta, playing, seaIceValues]);

  const windRender = useMemo<VectorGrid | null>(() => {
    if (!meta || !windStress) return null;
    if (!playing) return { ...windStress, lon: meta.lon, lat: meta.lat };
    return downsampleVectorGrid(
      windStress.u,
      windStress.v,
      meta.lon,
      meta.lat,
      PLAYBACK_WIND_MAX,
      PLAYBACK_WIND_MAX
    );
  }, [meta, playing, windStress]);

  useEffect(() => {
    let cancelled = false;
    setMetaStatus("loading");
    setMetaError(null);
    loadGsZarrMeta()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        setMetaStatus("ready");
        setTimeIdx(0);
        setDepthIdx(0);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setMeta(null);
        setMetaStatus("failed");
        setMetaError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!availableVars.includes(varId)) setVarId(availableVars[0]);
  }, [availableVars, varId]);

  useEffect(() => {
    if (!playing) return;
    if (metaStatus !== "ready" || !timeList.length) return;
    const intervalMs = Math.max(250, Math.round(1000 / Math.max(0.5, fps)));
    const t = window.setInterval(() => {
      // Avoid stepping time while the current frame is still loading.
      if (sliceStatus === "loading") return;
      setTimeIdx((i) => (i + 1) % timeList.length);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [fps, metaStatus, playing, sliceStatus, timeList.length]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready") return;
    if (!projectOn3d) {
      setSliceStatus("off");
      setSliceError(null);
      setClassStatus("off");
      setClassError(null);
      setHorizontalValues(null);
      setTransectValues(null);
      setTransectLatActual(null);
      setClassTraces(null);
      return;
    }

    let cancelled = false;
    setSliceStatus("loading");
    setSliceError(null);

    (async () => {
      try {
        if (viewMode === "horizontal") {
          const values = await loadHorizontalSlice({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
            zIndex: safeDepthIdx,
            nLat: meta.lat.length,
            nLon: meta.lon.length,
          });
          if (cancelled) return;
          setHorizontalValues(values);
          setTransectValues(null);
          setTransectLatActual(null);
          setClassTraces(null);
          setClassStatus("off");
          setClassError(null);
          setSliceStatus("ready");
        } else if (viewMode === "transect") {
          const yIndex = nearestIndex(meta.lat, latTarget);
          const { values } = await loadTransectSlice({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
            yIndex,
          });
          if (cancelled) return;
          setTransectValues(values);
          setHorizontalValues(null);
          setTransectLatActual(meta.lat[yIndex] ?? latTarget);
          setClassTraces(null);
          setClassStatus("off");
          setClassError(null);
          setSliceStatus("ready");
        } else {
          setClassStatus("loading");
          setClassError(null);

          const full = await load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex: safeTimeIdx,
          });
          if (cancelled) return;

          const nxLimit = playing ? CLASS_MAX_XY_PLAYING : CLASS_MAX_XY_PAUSED;
          const nyLimit = playing ? CLASS_MAX_XY_PLAYING : CLASS_MAX_XY_PAUSED;
          const nzLimit = playing ? CLASS_MAX_Z_PLAYING : CLASS_MAX_Z_PAUSED;
          const xIdx = sampleIndices(full.nx, nxLimit);
          const yIdx = sampleIndices(full.ny, nyLimit);
          const zIdx = sampleIndices(full.nz, nzLimit);

          const centers = classCenters(classMin, classMax, classInterval);
          const perClassCap = Math.max(
            80,
            playing ? CLASS_POINTS_PER_CLASS_PLAYING : CLASS_POINTS_PER_CLASS_PAUSED
          );

          if (!centers.length) {
            setClassTraces([]);
            setHorizontalValues(null);
            setTransectValues(null);
            setTransectLatActual(null);
            setClassStatus("ready");
            setSliceStatus("ready");
            return;
          }

          const traces = centers.map((center, index) => ({
            value: center,
            label: formatClassLabel(varId, center, classInterval, true),
            x: [] as number[],
            y: [] as number[],
            z: [] as number[],
            seen: 0,
            rand: ((safeTimeIdx + 1) * 2654435761 + (index + 1) * 2246822519) >>> 0,
          }));

          const step = classInterval;
          const half = Math.max(0.05, classHalfWidth);
          const minCenter = classMin;
          const maxCenter = classMax;

          for (let zk = 0; zk < zIdx.length; zk++) {
            const zIndex = zIdx[zk];
            const depth = Number(meta.z[zIndex]);
            if (!Number.isFinite(depth)) continue;
            for (let yk = 0; yk < yIdx.length; yk++) {
              const yIndex = yIdx[yk];
              const lat = Number(meta.lat[yIndex]);
              if (!Number.isFinite(lat)) continue;
              for (let xk = 0; xk < xIdx.length; xk++) {
                const xIndex = xIdx[xk];
                const lon = Number(meta.lon[xIndex]);
                if (!Number.isFinite(lon)) continue;
                const offset = zIndex * full.ny * full.nx + yIndex * full.nx + xIndex;
                const value = Number(full.data[offset]);
                if (!Number.isFinite(value)) continue;
                if (value < minCenter - half || value > maxCenter + half) continue;

                const bucket = Math.round((value - minCenter) / step);
                if (bucket < 0 || bucket >= traces.length) continue;
                const center = traces[bucket].value;
                if (Math.abs(value - center) > half) continue;

                const bucketTrace = traces[bucket];
                bucketTrace.seen += 1;
                if (bucketTrace.x.length < perClassCap) {
                  bucketTrace.x.push(lon);
                  bucketTrace.y.push(lat);
                  bucketTrace.z.push(depth);
                } else {
                  bucketTrace.rand = (1664525 * bucketTrace.rand + 1013904223) >>> 0;
                  const replace = bucketTrace.rand % bucketTrace.seen;
                  if (replace < perClassCap) {
                    bucketTrace.x[replace] = lon;
                    bucketTrace.y[replace] = lat;
                    bucketTrace.z[replace] = depth;
                  }
                }
              }
            }
          }

          const filtered: ClassTrace[] = traces
            .filter((trace) => trace.x.length > 0)
            .map((trace) => ({
              label: trace.label,
              value: trace.value,
              x: trace.x,
              y: trace.y,
              z: trace.z,
            }));

          if (cancelled) return;
          setClassTraces(filtered);
          setHorizontalValues(null);
          setTransectValues(null);
          setTransectLatActual(null);
          setClassStatus("ready");
          setSliceStatus("ready");
        }
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setSliceStatus("failed");
        setSliceError(e instanceof Error ? e.message : String(e));
        if (viewMode === "class") {
          setClassStatus("failed");
          setClassError(e instanceof Error ? e.message : String(e));
        } else {
          setClassStatus("off");
          setClassError(null);
        }
        setHorizontalValues(null);
        setTransectValues(null);
        setTransectLatActual(null);
        setClassTraces(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    latTarget,
    meta,
    metaStatus,
    projectOn3d,
    safeDepthIdx,
    safeTimeIdx,
    classMax,
    classMin,
    classHalfWidth,
    classInterval,
    varId,
    viewMode,
    playing,
  ]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !showSeaIce) {
      setSeaIceStatus("off");
      setSeaIceError(null);
      setSeaIceValues(null);
      return;
    }

    let cancelled = false;
    setSeaIceStatus("loading");
    setSeaIceError(null);
    loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex: safeTimeIdx })
      .then((values) => {
        if (cancelled) return;
        setSeaIceValues(values);
        setSeaIceStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setSeaIceValues(null);
        setSeaIceStatus("failed");
        setSeaIceError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [meta, metaStatus, projectOn3d, safeTimeIdx, showSeaIce]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !showWind) {
      setWindStatus("off");
      setWindError(null);
      setWindStress(null);
      return;
    }

    let cancelled = false;
    setWindStatus("loading");
    setWindError(null);
    loadWindStress2D({ storeUrl: meta.storeUrl, tIndex: safeTimeIdx })
      .then((values) => {
        if (cancelled) return;
        setWindStress(values);
        setWindStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(e);
        setWindStress(null);
        setWindStatus("failed");
        setWindError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [meta, metaStatus, projectOn3d, safeTimeIdx, showWind]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready" || !projectOn3d || !playing) return;
    if (!timeList.length) return;
    const ahead = 10;
    const yIndex = viewMode === "transect" ? nearestIndex(meta.lat, latTarget) : -1;
    const seaIcePrefetch = new Set<number>();
    const windPrefetch = new Set<number>();
    for (let step = 1; step <= ahead; step++) {
      const tIndex = (safeTimeIdx + step) % timeList.length;
      if (viewMode === "horizontal") {
        void loadHorizontalSlice({
          storeUrl: meta.storeUrl,
          varId,
          tIndex,
          zIndex: safeDepthIdx,
          nLat: meta.lat.length,
          nLon: meta.lon.length,
        }).catch(() => undefined);
      } else if (viewMode === "transect") {
        void loadTransectSlice({
          storeUrl: meta.storeUrl,
          varId,
          tIndex,
          yIndex,
        }).catch(() => undefined);
      } else {
        if (step <= 3) {
          void load3DFieldAtTime({
            storeUrl: meta.storeUrl,
            varId,
            tIndex,
          }).catch(() => undefined);
        }
      }
      if (showSeaIce) {
        seaIcePrefetch.add(tIndex);
      }
      if (showWind) {
        windPrefetch.add(tIndex);
      }
    }
    seaIcePrefetch.forEach((tIndex) => {
      void loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex }).catch(() => undefined);
    });
    windPrefetch.forEach((tIndex) => {
      void loadWindStress2D({ storeUrl: meta.storeUrl, tIndex }).catch(() => undefined);
    });
  }, [
    latTarget,
    meta,
    metaStatus,
    playing,
    projectOn3d,
    safeDepthIdx,
    safeTimeIdx,
    showSeaIce,
    showWind,
    timeList.length,
    varId,
    viewMode,
  ]);

  const horizontalField = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "horizontal" || !horizontalRender) return undefined;
    return {
      enabled: true,
      values: horizontalRender.values,
      lon: horizontalRender.lon,
      lat: horizontalRender.lat,
      cmin: settings.cmin,
      cmax: settings.cmax,
      colorscale,
      opacity: overlayOpacity,
      mode: "surface" as const,
      zPlane: meta.z?.[safeDepthIdx] ?? 0,
      showScale: showColorbar,
      colorbarTitle: range.title,
      colorbarTicks,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
      zeroAsMissing: varId === "S",
      maskDryByBathy: true,
    };
  }, [
    colorscale,
    horizontalRender,
    meta,
    overlayOpacity,
    projectOn3d,
    safeDepthIdx,
    showColorbar,
    colorbarTicks,
    range.title,
    settings.cmax,
    settings.cmin,
    viewMode,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
    varId,
  ]);

  const transectField = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "transect" || !transectRender) return undefined;
    return {
      enabled: true,
      lat: transectLatActual ?? latTarget,
      lon: transectRender.lon,
      z: transectRender.z,
      values: transectRender.values,
      cmin: settings.cmin,
      cmax: settings.cmax,
      colorscale,
      opacity: overlayOpacity,
      showScale: showColorbar,
      colorbarTitle: range.title,
      colorbarTicks,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
    };
  }, [
    colorscale,
    latTarget,
    meta,
    overlayOpacity,
    projectOn3d,
    showColorbar,
    colorbarTicks,
    range.title,
    settings.cmax,
    settings.cmin,
    transectLatActual,
    transectRender,
    viewMode,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
  ]);

  const seaIcePlane = useMemo(() => {
    if (!meta || !projectOn3d || !showSeaIce || !seaIceRender) return null;
    const masked = seaIceRender.values.map((row) =>
      row.map((v) => {
        const x = Number(v);
        if (!Number.isFinite(x)) return Number.NaN;
        if (x <= SEA_ICE_THRESHOLD) return Number.NaN;
        return Math.max(0, Math.min(1, x));
      })
    );
    const cmin = Math.max(0, Math.min(0.99, SEA_ICE_THRESHOLD));
    return {
      enabled: true,
      values: masked,
      lon: seaIceRender.lon,
      lat: seaIceRender.lat,
      cmin,
      cmax: 1,
      colorscale: paletteToColorscale(ice_256()),
      opacity: SEA_ICE_OPACITY,
      mode: "surface" as const,
      zPlane: SEA_ICE_HEIGHT_M,
      showScale: true,
      colorbarTitle: `Sea ice (${cmin.toFixed(2)}–1)`,
      colorbarTicks: [cmin, 0.5, 0.75, 1].filter((v, i, arr) => arr.indexOf(v) === i),
      colorbarLen: seaIceColorbarLayout.len,
      colorbarX: seaIceColorbarLayout.x,
      colorbarY: seaIceColorbarLayout.y,
    };
  }, [
    meta,
    projectOn3d,
    seaIceRender,
    seaIceColorbarLayout.len,
    seaIceColorbarLayout.x,
    seaIceColorbarLayout.y,
    showSeaIce,
  ]);

  const horizontalPlanes = useMemo(() => {
    if (!meta || !projectOn3d) return undefined;
    return seaIcePlane ? [seaIcePlane] : undefined;
  }, [
    meta,
    projectOn3d,
    seaIcePlane,
  ]);

  const windLayer = useMemo(() => {
    if (!meta || !projectOn3d || !showWind || !windRender) return undefined;
    return {
      enabled: true,
      lon: windRender.lon,
      lat: windRender.lat,
      u: windRender.u,
      v: windRender.v,
      zPlane: SEA_ICE_HEIGHT_M + 1,
      particleCount: playing ? 280 : 520,
      speed: 1,
      color: "rgba(255,255,255,0.90)",
      size: playing ? 1.1 : 1.35,
    };
  }, [meta, projectOn3d, showWind, windRender, playing]);

  const classLayer = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "class" || !classTraces?.length) return undefined;
    const classValues = classTraces.map((t) => t.value).sort((a, b) => a - b);
    const ticks = pickClassTicks(classValues, 12);
    const tickText = ticks.map((v) => formatClassLabel(varId, v, classInterval, false));
    return {
      enabled: true,
      varLabel: range.title,
      points: classTraces,
      markerSize: playing ? 2.2 : 2.8,
      opacity: 0.7,
      showLegend: true,
      cmin: classMin,
      cmax: classMax,
      colorscale: makeClassDiscreteColorscale(classValues, classMin, classMax, fieldPalette),
      showScale: showColorbar,
      colorbarTitle: `${range.title} class`,
      colorbarTicks: ticks,
      colorbarTickText: tickText,
      colorbarLen: mainColorbarLayout.len,
      colorbarX: mainColorbarLayout.x,
      colorbarY: mainColorbarLayout.y,
    };
  }, [
    classInterval,
    classMax,
    classMin,
    classTraces,
    fieldPalette,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
    meta,
    playing,
    projectOn3d,
    range.title,
    showColorbar,
    varId,
    viewMode,
  ]);

  const resetColorScale = useCallback(() => {
    setColorSettings((prev) => ({ ...prev, [varId]: DEFAULT_COLOR_SETTINGS[varId] }));
    setFieldColormapByVar((prev) => ({ ...prev, [varId]: DEFAULT_FIELD_COLORMAP[varId] }));
  }, [varId]);

  const resetCamera = useCallback(() => {
    try {
      window.localStorage.removeItem("gs_scene_camera_v1");
    } catch {
      // ignore
    }
    setCameraResetNonce((n) => n + 1);
  }, []);

  const autoColorScaleFromFrame = useCallback(() => {
    const values = viewMode === "horizontal" ? horizontalValues : transectValues;
    if (!values) return;
    const mm = computeMinMax(values, { ignoreExactZero: varId === "S" });
    if (!mm) return;
    setColorSettings((prev) => ({
      ...prev,
      [varId]: {
        ...prev[varId],
        cmin: Number(mm.min.toFixed(3)),
        cmax: Number(mm.max.toFixed(3)),
      },
    }));
  }, [horizontalValues, transectValues, varId, viewMode]);

  return (
    <div className="app">
      <Basemap3D
        bathySource="bathy"
        bathyPalette={bathyPalette}
        cameraResetNonce={cameraResetNonce}
        depthRatio={depthRatio}
        depthWarp={{ mode: depthWarpMode, focusDepthM: depthFocusM, deepRatio }}
        showBathy={showBathy}
        onStatusChange={handleStatusChange}
        showBathyContours={showBathyContours}
        showFieldContours={showFieldContours}
        horizontalField={horizontalField}
        horizontalPlanes={horizontalPlanes}
        windLayer={windLayer}
        classLayer={classLayer}
        transectField={transectField}
      />

      <div className="overlay">
        {!panelOpen ? (
          <button
            type="button"
            className="panelOpenButton"
            title="Open control panel"
            onClick={() => setPanelOpen(true)}
          >
            ☰
          </button>
        ) : (
          <div
            ref={panelRef}
            className="panel controlPanel"
            style={{
              left: panelPos?.left ?? 16,
              ...(panelPos ? { top: panelPos.top } : { bottom: 16 }),
            }}
          >
            <div
              className="panelHeader"
              title="Drag to move (double-click to reset)"
              onDoubleClick={() => setPanelPos(null)}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement | null)?.closest?.("button")) return;
                const el = panelRef.current;
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const startOffsetX = e.clientX - rect.left;
                const startOffsetY = e.clientY - rect.top;

                const onMove = (ev: PointerEvent) => {
                  const el2 = panelRef.current;
                  if (!el2) return;
                  const rect2 = el2.getBoundingClientRect();
                  const nextLeft = ev.clientX - startOffsetX;
                  const nextTop = ev.clientY - startOffsetY;
                  const maxLeft = Math.max(12, window.innerWidth - rect2.width - 12);
                  const maxTop = Math.max(12, window.innerHeight - rect2.height - 12);
                  setPanelPos({
                    left: clamp(nextLeft, 12, maxLeft),
                    top: clamp(nextTop, 12, maxTop),
                  });
                };

                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.removeEventListener("pointercancel", onUp);
                };

                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Control Panel</div>
                <button
                  type="button"
                  className="panelIconButton"
                  title="Reset 3D view"
                  onClick={resetCamera}
                >
                  ⟲
                </button>
                <button
                  type="button"
                  className="panelIconButton"
                  title={themeMode === "night" ? "Switch to day mode" : "Switch to night mode"}
                  onClick={() => setThemeMode((m) => (m === "night" ? "day" : "night"))}
                >
                  {themeMode === "night" ? "☀" : "☾"}
                </button>
              </div>
              <div className="panelHeaderRight">
                <div className="badge">Local</div>
                <button
                  type="button"
                  className="panelIconButton"
                  title="Close"
                  onClick={() => setPanelOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="title" style={{ marginBottom: 0 }}>
              <div>
                <h1>Greenland Sea</h1>
                {/* <div className="sub">T/S + sea ice over 3D bathymetry</div> */}
              </div>
            </div>

            <div className="controls">
              <details className="section" open>
                <summary>View</summary>
                <div className="sectionBody">
                  <div className="tabs">
                    <button
                      className={`tab ${viewMode === "horizontal" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("horizontal")}
                    >
                      Horizontal
                    </button>
                    <button
                      className={`tab ${viewMode === "transect" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("transect")}
                    >
                      Transect
                    </button>
                    <button
                      className={`tab ${viewMode === "class" ? "tabActive" : ""}`}
                      onClick={() => setViewMode("class")}
                    >
                      Class
                    </button>
                  </div>

                  <label>
                    Variable
                    <select value={varId} onChange={(e) => setVarId(e.target.value as VarId)}>
                      {meta?.variables?.map((v) => (
                        <option key={v.id} value={v.id} disabled={!v.available}>
                          {v.label}
                          {!v.available ? " (missing in GS.zarr)" : ""}
                        </option>
                      )) ?? (
                        <>
                          <option value="T">Temperature (T)</option>
                          <option value="S">Salinity (S)</option>
                        </>
                      )}
                    </select>
                  </label>

                  <label>
                    Overlay opacity
                    <select
                      value={String(overlayOpacity)}
                      onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                      disabled={!projectOn3d}
                    >
                      <option value="0.65">0.65</option>
                      <option value="0.75">0.75</option>
                      <option value="0.85">0.85</option>
                      <option value="0.9">0.90</option>
                      <option value="0.95">0.95</option>
                      <option value="1">1.00</option>
                    </select>
                  </label>

                  <div className="toggleRow">
                    <div>Colorbar</div>
                    <ToggleSwitch checked={showColorbar} onCheckedChange={setShowColorbar} />
                  </div>
                  <div className="toggleRow">
                    <div>Field contours</div>
                    <ToggleSwitch checked={showFieldContours} onCheckedChange={setShowFieldContours} />
                  </div>
                  <div className="toggleRow">
                    <div>Bathy</div>
                    <ToggleSwitch checked={showBathy} onCheckedChange={setShowBathy} />
                  </div>
                  <div className="toggleRow">
                    <div>Bathy contours</div>
                    <ToggleSwitch checked={showBathyContours} onCheckedChange={setShowBathyContours} />
                  </div>
                  <div className="toggleRow">
                    <div>Sea ice</div>
                    <ToggleSwitch checked={showSeaIce} onCheckedChange={setShowSeaIce} />
                  </div>
                  <div className="toggleRow">
                    <div>Wind stress on ocean</div>
                    <ToggleSwitch checked={showWind} onCheckedChange={setShowWind} />
                  </div>
                  <div className="toggleRow">
                    <div>Movie</div>
                    <ToggleSwitch
                      checked={playing}
                      onCheckedChange={setPlaying}
                      disabled={metaStatus !== "ready" || !timeList.length}
                    />
                  </div>

                  <label>
                    Time ({activeTimeLabel})
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, timeList.length - 1)}
                      value={safeTimeIdx}
                      onChange={(e) => setTimeIdx(Number(e.target.value))}
                      style={{ width: "100%" }}
                      disabled={metaStatus !== "ready" || !timeList.length}
                    />
                    {timeList.length ? (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          color: "rgba(255,255,255,0.62)",
                          marginTop: 4,
                        }}
                      >
                        <span>{timeList[0]}</span>
                        <span>{timeList[timeList.length - 1]}</span>
                      </div>
                    ) : null}
                  </label>

                  <label>
                    FPS
                    <select value={String(fps)} onChange={(e) => setFps(Number(e.target.value))}>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                    </select>
                  </label>
                </div>
              </details>

              <details className="section" open>
                <summary>Slice</summary>
                <div className="sectionBody">
                  {viewMode === "horizontal" ? (
                    <label>
                      Depth ({activeDepthLabel})
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, zList.length - 1)}
                        value={safeDepthIdx}
                        onChange={(e) => setDepthIdx(Number(e.target.value))}
                        style={{ width: "100%" }}
                        disabled={metaStatus !== "ready" || !zList.length}
                      />
                      {zList.length ? (
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 11,
                            color: "rgba(255,255,255,0.62)",
                            marginTop: 4,
                          }}
                        >
                          <span>{Math.round(zList[0])} m</span>
                          <span>{Math.round(zList[zList.length - 1])} m</span>
                        </div>
                      ) : null}
                    </label>
                  ) : viewMode === "transect" ? (
                    <label>
                      Latitude target (°N) ({latTarget.toFixed(2)}°N)
                      <input
                        type="range"
                        min={latMin}
                        max={latMax}
                        step={0.01}
                        value={latTarget}
                        onChange={(e) => setLatTarget(Number(e.target.value))}
                        style={{ width: "100%" }}
                        disabled={metaStatus !== "ready"}
                      />
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          color: "rgba(255,255,255,0.62)",
                          marginTop: 4,
                        }}
                      >
                        <span>{latMin.toFixed(1)}°N</span>
                        <span>{latMax.toFixed(1)}°N</span>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <input
                          type="number"
                          value={latTargetInput}
                          min={latMin}
                          max={latMax}
                          step={0.05}
                          onChange={(e) => setLatTargetInput(e.target.value)}
                          onBlur={commitLatTargetInput}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitLatTargetInput();
                          }}
                          disabled={metaStatus !== "ready"}
                        />
                      </div>
                      {transectLatActual != null ? (
                        <div className="hint">Nearest model latitude: {transectLatActual.toFixed(3)}°N</div>
                      ) : null}
                    </label>
                  ) : (
                    <>
                      <label>
                        Class min
                        <input
                          type="text"
                          inputMode="decimal"
                          value={classInputs?.min ?? String(classSettings.min)}
                          onInput={(e) => updateClassInputLive("min", (e.target as HTMLInputElement).value)}
                          onBlur={() => commitClassInput("min")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitClassInput("min");
                          }}
                        />
                      </label>
                      <label>
                        Class max
                        <input
                          type="text"
                          inputMode="decimal"
                          value={classInputs?.max ?? String(classSettings.max)}
                          onInput={(e) => updateClassInputLive("max", (e.target as HTMLInputElement).value)}
                          onBlur={() => commitClassInput("max")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitClassInput("max");
                          }}
                        />
                      </label>
                      <label>
                        Class interval
                        <select
                          value={String(classInterval)}
                          onChange={(e) =>
                            setClassSettingsByVar((prev) => ({
                              ...prev,
                              [varId]: { ...prev[varId], interval: Number(e.target.value) },
                            }))
                          }
                        >
                          {CLASS_INTERVAL_OPTIONS[varId].map((opt) => (
                            <option key={opt} value={String(opt)}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Class half-width
                        <select
                          value={String(classHalfWidth)}
                          onChange={(e) =>
                            setClassSettingsByVar((prev) => ({
                              ...prev,
                              [varId]: { ...prev[varId], halfWidth: Number(e.target.value) },
                            }))
                          }
                        >
                          {CLASS_HALF_WIDTH_OPTIONS[varId].map((opt) => (
                            <option key={opt} value={String(opt)}>
                              {opt}
                            </option>
                          ))}
                        </select>
                        <div className="hint">
                          Showing {range.title} classes in [{classMin}, {classMax}].
                        </div>
                      </label>
                      <button
                        type="button"
                        className="tab"
                        onClick={() => {
                          setClassSettingsByVar((prev) => ({
                            ...prev,
                            [varId]: DEFAULT_CLASS_SETTINGS[varId],
                          }));
                          setClassInputByVar((prev) => ({
                            ...prev,
                            [varId]: {
                              min: String(DEFAULT_CLASS_SETTINGS[varId].min),
                              max: String(DEFAULT_CLASS_SETTINGS[varId].max),
                            },
                          }));
                        }}
                      >
                        Reset class defaults
                      </button>
                    </>
                  )}

                  <label>
                    Depth ratio (z) ({depthRatio.toFixed(2)})
                    <input
                      type="range"
                      min={0.15}
                      max={1.5}
                      step={0.05}
                      value={depthRatio}
                      onChange={(e) => setDepthRatio(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                    <div className="hint">Vertical exaggeration.</div>
                  </label>

                  <label>
                    Depth scaling
                    <select value={depthWarpMode} onChange={(e) => setDepthWarpMode(e.target.value as any)}>
                      <option value="upper">Upper-focus (e.g., top 2500 m)</option>
                      <option value="linear">Linear</option>
                    </select>
                  </label>

                  {depthWarpMode === "upper" ? (
                    <>
                      <label>
                        Focus depth (m) ({Math.round(depthFocusM)} m)
                        <input
                          type="range"
                          min={500}
                          max={6000}
                          step={100}
                          value={depthFocusM}
                          onChange={(e) => setDepthFocusM(Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Upper layer stays linear; deeper layers are compressed.</div>
                      </label>
                      <label>
                        Deep ratio ({deepRatio.toFixed(2)})
                        <input
                          type="range"
                          min={0.05}
                          max={1}
                          step={0.05}
                          value={deepRatio}
                          onChange={(e) => setDeepRatio(Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                        <div className="hint">Lower compresses deep ocean (below focus depth).</div>
                      </label>
                    </>
                  ) : null}

                </div>
              </details>

              <details className="section">
                <summary>Color scale</summary>
                <div className="sectionBody">
                  <label>
                    {varId === "T" ? "Temperature colormap" : "Salinity colormap"}
                    <select
                      value={fieldColormapByVar[varId]}
                      onChange={(e) =>
                        setFieldColormapByVar((prev) => ({
                          ...prev,
                          [varId]: e.target.value as FieldColormapId,
                        }))
                      }
                    >
                      {FIELD_COLORMAP_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Bathymetry colormap
                    <select
                      value={bathyColormap}
                      onChange={(e) => setBathyColormap(e.target.value as BathyColormapId)}
                    >
                      {BATHY_COLORMAP_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div style={{ display: "flex", gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Min
                      <input
                        type="text"
                        inputMode="decimal"
                        value={colorInputs?.min ?? String(settings.cmin)}
                        onInput={(e) => updateColorInputLive("min", (e.target as HTMLInputElement).value)}
                        onBlur={() => commitColorInput("min")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitColorInput("min");
                        }}
                      />
                    </label>
                    <label style={{ flex: 1 }}>
                      Max
                      <input
                        type="text"
                        inputMode="decimal"
                        value={colorInputs?.max ?? String(settings.cmax)}
                        onInput={(e) => updateColorInputLive("max", (e.target as HTMLInputElement).value)}
                        onBlur={() => commitColorInput("max")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitColorInput("max");
                        }}
                      />
                    </label>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" className="tab" onClick={resetColorScale} style={{ flex: 1 }}>
                      Reset default
                    </button>
                    <button
                      type="button"
                      className="tab"
                      onClick={autoColorScaleFromFrame}
                      style={{ flex: 1 }}
                      disabled={sliceStatus !== "ready"}
                      title={sliceStatus !== "ready" ? "Load a slice first" : "Auto range from current frame"}
                    >
                      Auto (frame)
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Ticks
                      <select
                        value={String(settings.tickCount)}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], tickCount: Number(e.target.value) },
                          }))
                        }
                      >
                        <option value="0">Auto</option>
                        {TICK_OPTIONS_BY_VAR[varId].map((count) => (
                          <option key={count} value={String(count)}>
                            {count}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ flex: 1 }}>
                      Mode
                      <select
                        value={settings.mode}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], mode: e.target.value as ColorscaleMode },
                          }))
                        }
                      >
                        <option value="continuous">Continuous</option>
                        <option value="discrete">Discrete</option>
                      </select>
                    </label>
                  </div>

                  {settings.mode === "discrete" ? (
                    <label>
                      Levels
                      <select
                        value={String(settings.levels)}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: { ...prev[varId], levels: Number(e.target.value) },
                          }))
                        }
                      >
                        <option value="8">8</option>
                        <option value="12">12</option>
                        <option value="16">16</option>
                        <option value="24">24</option>
                        <option value="32">32</option>
                      </select>
                    </label>
                  ) : null}

                  <div className="hint">
                    Default: <b>[{DEFAULT_COLOR_SETTINGS[varId].cmin}, {DEFAULT_COLOR_SETTINGS[varId].cmax}]</b>
                  </div>
                </div>
              </details>

              <details className="section">
                <summary>Status</summary>
                <div className="sectionBody">
                  <div className="hint">
                    Dataset: <b>{meta?.storeUrl ? meta.storeUrl.split("/").slice(-1)[0] : "public/data/GS_web.zarr"}</b> — meta{" "}
                    <b>{metaStatus}</b>
                    {metaStatus === "failed" && metaError ? <div style={{ marginTop: 6 }}>Error: {metaError}</div> : null}
                  </div>

                  <div className="hint">
                    Slice: <b>{sliceStatus}</b>
                    {sliceStatus === "failed" && sliceError ? <div style={{ marginTop: 6 }}>Error: {sliceError}</div> : null}
                  </div>
                  <div className="hint">
                    Class: <b>{viewMode === "class" ? classStatus : "off"}</b>
                    {classStatus === "failed" && classError ? <div style={{ marginTop: 6 }}>Error: {classError}</div> : null}
                  </div>

                  <div className="hint">
                    Sea ice: <b>{showSeaIce ? seaIceStatus : "off"}</b>
                    {seaIceStatus === "failed" && seaIceError ? <div style={{ marginTop: 6 }}>Error: {seaIceError}</div> : null}
                  </div>

                  <div className="hint">
                    Wind stress on ocean: <b>{showWind ? windStatus : "off"}</b>
                    {windStatus === "failed" && windError ? <div style={{ marginTop: 6 }}>Error: {windError}</div> : null}
                  </div>

                  <div className="hint">
                    3D: Plotly <b>{bathyInfo.plotly}</b>, bathymetry <b>{bathyInfo.bathy}</b>.
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
