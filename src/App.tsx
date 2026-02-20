import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Basemap3D from "./components/Basemap3D";
import { ice_256, paletteToColorscale, rdylbu_r_256 } from "./lib/colormap";
import {
  loadGsZarrMeta,
  loadHorizontalSlice,
  loadSeaIce2D,
  loadTransectSlice,
  nearestIndex,
  type GsZarrMeta,
} from "./lib/gsZarr";

type ViewMode = "horizontal" | "transect";
type VarId = "T" | "S";
type ColorscaleMode = "continuous" | "discrete";

type VarColorSettings = {
  cmin: number;
  cmax: number;
  tickCount: number; // 0 => auto
  mode: ColorscaleMode;
  levels: number; // used when mode === "discrete"
};

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function defaultRange(varId: VarId) {
  if (varId === "T") return { min: -1, max: 5, ticks: [-1, 0, 1, 2, 3, 4, 5], title: "Temperature (°C)" };
  return { min: 32, max: 36, ticks: [32, 33, 34, 35, 36], title: "Salinity (g/kg)" };
}

const RDYLBU_PALETTE = rdylbu_r_256();
const RDYLBU_CONTINUOUS = paletteToColorscale(RDYLBU_PALETTE);

const DEFAULT_COLOR_SETTINGS: Record<VarId, VarColorSettings> = {
  T: { cmin: -1, cmax: 5, tickCount: 7, mode: "continuous", levels: 12 },
  S: { cmin: 32, cmax: 36, tickCount: 5, mode: "continuous", levels: 12 },
};

function makeTicks(min: number, max: number, tickCount: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (tickCount <= 1 || min === max) return undefined;
  const out: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    out.push(min + (i * (max - min)) / (tickCount - 1));
  }
  return out;
}

function computeMinMax(values: number[][]) {
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function makeDiscreteColorscale(levels: number) {
  const n = Math.max(2, Math.min(levels, RDYLBU_PALETTE.length));
  const toCss = (c: { r: number; g: number; b: number }) => `rgb(${c.r},${c.g},${c.b})`;
  const sampled = Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const idx = Math.round(t * (RDYLBU_PALETTE.length - 1));
    return RDYLBU_PALETTE[idx];
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
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      const v = window.localStorage.getItem("gs_panel_open");
      if (v != null) return v === "1";
    } catch {
      // ignore
    }
    return false;
  });
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem("gs_panel_open", panelOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [panelOpen]);

  const [viewMode, setViewMode] = useState<ViewMode>("horizontal");
  const [varId, setVarId] = useState<VarId>("T");
  const projectOn3d = true;
  const [overlayOpacity, setOverlayOpacity] = useState(0.9);
  const [showColorbar, setShowColorbar] = useState(true);
  const [showFieldContours, setShowFieldContours] = useState(false);
  const [showBathyContours, setShowBathyContours] = useState(false);
  const [depthRatio, setDepthRatio] = useState(0.35);
  const [depthWarpMode, setDepthWarpMode] = useState<"linear" | "upper">("upper");
  const [depthFocusM, setDepthFocusM] = useState(2500);
  const [deepRatio, setDeepRatio] = useState(0.25);
  const [showBathyInTransect, setShowBathyInTransect] = useState(true);
  const [colorSettings, setColorSettings] = useState<Record<VarId, VarColorSettings>>(
    DEFAULT_COLOR_SETTINGS
  );
  const [showSeaIce, setShowSeaIce] = useState(true);
  const [seaIceOpacity, setSeaIceOpacity] = useState(0.55);
  const [showSeaIceColorbar, setShowSeaIceColorbar] = useState(true);
  const [seaIceMin, setSeaIceMin] = useState(0.3);
  const [seaIceHeightM, setSeaIceHeightM] = useState(5);
  const [bathySource, setBathySource] = useState<"auto" | "bathy" | "rtopo_ds" | "rtopo">("bathy");

  const [timeIdx, setTimeIdx] = useState(0);
  const [depthIdx, setDepthIdx] = useState(0);
  const [latTarget, setLatTarget] = useState(75);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(1);

  const [metaStatus, setMetaStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [meta, setMeta] = useState<GsZarrMeta | null>(null);

  const [sliceStatus, setSliceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [sliceError, setSliceError] = useState<string | null>(null);

  const [seaIceStatus, setSeaIceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [seaIceError, setSeaIceError] = useState<string | null>(null);

  const [horizontalValues, setHorizontalValues] = useState<number[][] | null>(null);
  const [transectValues, setTransectValues] = useState<number[][] | null>(null);
  const [transectLatActual, setTransectLatActual] = useState<number | null>(null);
  const [seaIceValues, setSeaIceValues] = useState<number[][] | null>(null);

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
  const colorscale = useMemo(() => {
    return settings.mode === "discrete" ? makeDiscreteColorscale(settings.levels) : RDYLBU_CONTINUOUS;
  }, [settings.levels, settings.mode]);
  const colorbarTicks = useMemo(
    () => (settings.tickCount > 0 ? makeTicks(settings.cmin, settings.cmax, settings.tickCount) : undefined),
    [settings.cmax, settings.cmin, settings.tickCount]
  );
  const hasSeaIceColorbar = projectOn3d && showSeaIce && showSeaIceColorbar;
  const mainColorbarLayout = useMemo(
    () =>
      hasSeaIceColorbar
        ? { x: 1.03, y: 0.78, len: 0.42 }
        : { x: 1.03, y: 0.52, len: 0.72 },
    [hasSeaIceColorbar]
  );
  const seaIceColorbarLayout = useMemo(
    () =>
      hasSeaIceColorbar
        ? { x: 1.03, y: 0.20, len: 0.26 }
        : { x: 1.03, y: 0.52, len: 0.72 },
    [hasSeaIceColorbar]
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
      if (showSeaIce && seaIceStatus === "loading") return;
      setTimeIdx((i) => (i + 1) % timeList.length);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [fps, metaStatus, playing, seaIceStatus, showSeaIce, sliceStatus, timeList.length]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready") return;
    if (!projectOn3d) {
      setSliceStatus("off");
      setSliceError(null);
      setHorizontalValues(null);
      setTransectValues(null);
      setTransectLatActual(null);
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
          setSliceStatus("ready");
        } else {
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
          setSliceStatus("ready");
        }
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setSliceStatus("failed");
        setSliceError(e instanceof Error ? e.message : String(e));
        setHorizontalValues(null);
        setTransectValues(null);
        setTransectLatActual(null);
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
    varId,
    viewMode,
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
    if (!meta || metaStatus !== "ready" || !projectOn3d || !playing) return;
    if (!timeList.length) return;
    const ahead = 3;
    const yIndex = viewMode === "transect" ? nearestIndex(meta.lat, latTarget) : -1;
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
      } else {
        void loadTransectSlice({
          storeUrl: meta.storeUrl,
          varId,
          tIndex,
          yIndex,
        }).catch(() => undefined);
      }
      if (showSeaIce) {
        void loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex }).catch(() => undefined);
      }
    }
  }, [
    latTarget,
    meta,
    metaStatus,
    playing,
    projectOn3d,
    safeDepthIdx,
    safeTimeIdx,
    showSeaIce,
    timeList.length,
    varId,
    viewMode,
  ]);

  const horizontalField = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "horizontal" || !horizontalValues) return undefined;
    return {
      enabled: true,
      values: horizontalValues,
      lon: meta.lon,
      lat: meta.lat,
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
    horizontalValues,
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
    if (!meta || !projectOn3d || viewMode !== "transect" || !transectValues) return undefined;
    return {
      enabled: true,
      lat: transectLatActual ?? latTarget,
      lon: meta.lon,
      z: meta.z,
      values: transectValues,
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
    transectValues,
    viewMode,
    mainColorbarLayout.len,
    mainColorbarLayout.x,
    mainColorbarLayout.y,
  ]);

  const seaIcePlane = useMemo(() => {
    if (!meta || !projectOn3d || !showSeaIce || !seaIceValues) return null;
    const masked = seaIceValues.map((row) =>
      row.map((v) => {
        const x = Number(v);
        if (!Number.isFinite(x)) return Number.NaN;
        if (x <= seaIceMin) return Number.NaN;
        return Math.max(0, Math.min(1, x));
      })
    );
    const cmin = Math.max(0, Math.min(0.99, seaIceMin));
    return {
      enabled: true,
      values: masked,
      lon: meta.lon,
      lat: meta.lat,
      cmin,
      cmax: 1,
      colorscale: paletteToColorscale(ice_256()),
      opacity: seaIceOpacity,
      mode: "surface" as const,
      zPlane: seaIceHeightM,
      showScale: showSeaIceColorbar,
      colorbarTitle: `Sea ice (${cmin.toFixed(2)}–1)`,
      colorbarTicks: [cmin, 0.5, 0.75, 1].filter((v, i, arr) => arr.indexOf(v) === i),
      colorbarLen: seaIceColorbarLayout.len,
      colorbarX: seaIceColorbarLayout.x,
      colorbarY: seaIceColorbarLayout.y,
    };
  }, [
    meta,
    projectOn3d,
    seaIceHeightM,
    seaIceMin,
    seaIceOpacity,
    seaIceValues,
    seaIceColorbarLayout.len,
    seaIceColorbarLayout.x,
    seaIceColorbarLayout.y,
    showSeaIce,
    showSeaIceColorbar,
  ]);

  const horizontalPlanes = useMemo(() => {
    if (!meta || !projectOn3d) return undefined;
    return seaIcePlane ? [seaIcePlane] : undefined;
  }, [
    meta,
    projectOn3d,
    seaIcePlane,
  ]);

  const resetColorScale = useCallback(() => {
    setColorSettings((prev) => ({ ...prev, [varId]: DEFAULT_COLOR_SETTINGS[varId] }));
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
    const mm = computeMinMax(values);
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
        bathySource={bathySource}
        cameraResetNonce={cameraResetNonce}
        depthRatio={depthRatio}
        depthWarp={{ mode: depthWarpMode, focusDepthM: depthFocusM, deepRatio }}
        showBathy={viewMode === "transect" ? showBathyInTransect : true}
        onStatusChange={handleStatusChange}
        showBathyContours={showBathyContours}
        showFieldContours={showFieldContours}
        horizontalField={horizontalField}
        horizontalPlanes={horizontalPlanes}
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
                <div className="sub">T/S + sea ice over 3D bathymetry</div>
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
                  ) : (
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
                          value={latTarget}
                          min={latMin}
                          max={latMax}
                          step={0.05}
                          onChange={(e) => setLatTarget(Number(e.target.value))}
                          disabled={metaStatus !== "ready"}
                        />
                      </div>
                      {transectLatActual != null ? (
                        <div className="hint">Nearest model latitude: {transectLatActual.toFixed(3)}°N</div>
                      ) : null}
                    </label>
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

                  {viewMode === "transect" ? (
                    <button
                      type="button"
                      className={`tab ${showBathyInTransect ? "tabActive" : ""}`}
                      onClick={() => setShowBathyInTransect((v) => !v)}
                      style={{ width: "100%" }}
                    >
                      Transect bathymetry {showBathyInTransect ? "On" : "Off"}
                    </button>
                  ) : null}
                </div>
              </details>

              <details className="section" open>
                <summary>Time</summary>
                <div className="sectionBody">
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

                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                    <label style={{ flex: 1 }}>
                      Animation
                      <button
                        type="button"
                        className="tab tabActive"
                        onClick={() => setPlaying((p) => !p)}
                        style={{ width: "100%" }}
                        disabled={metaStatus !== "ready" || !timeList.length}
                      >
                        {playing ? "Pause" : "Play"}
                      </button>
                    </label>

                    <label style={{ width: 120 }}>
                      FPS
                      <select value={String(fps)} onChange={(e) => setFps(Number(e.target.value))}>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4</option>
                      </select>
                    </label>
                  </div>
                </div>
              </details>

              <details className="section">
                <summary>Color scale</summary>
                <div className="sectionBody">
                  <div style={{ display: "flex", gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Min
                      <input
                        type="number"
                        value={settings.cmin}
                        step={0.1}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: {
                              ...prev[varId],
                              cmin: e.target.value === "" ? prev[varId].cmin : Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                    <label style={{ flex: 1 }}>
                      Max
                      <input
                        type="number"
                        value={settings.cmax}
                        step={0.1}
                        onChange={(e) =>
                          setColorSettings((prev) => ({
                            ...prev,
                            [varId]: {
                              ...prev[varId],
                              cmax: e.target.value === "" ? prev[varId].cmax : Number(e.target.value),
                            },
                          }))
                        }
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
                        <option value="5">5</option>
                        <option value="7">7</option>
                        <option value="9">9</option>
                        <option value="11">11</option>
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
                <summary>Overlays</summary>
                <div className="sectionBody">
                  <button
                    type="button"
                    className={`tab ${showSeaIce ? "tabActive" : ""}`}
                    onClick={() => setShowSeaIce((v) => !v)}
                    title="Sea ice concentration (SIarea)"
                    style={{ width: "100%" }}
                  >
                    Sea ice {showSeaIce ? "On" : "Off"}
                  </button>

                  {showSeaIce ? (
                    <label>
                      Sea ice opacity
                      <select
                        value={String(seaIceOpacity)}
                        onChange={(e) => setSeaIceOpacity(Number(e.target.value))}
                        disabled={!projectOn3d}
                      >
                        <option value="0.25">0.25</option>
                        <option value="0.35">0.35</option>
                        <option value="0.45">0.45</option>
                        <option value="0.55">0.55</option>
                        <option value="0.65">0.65</option>
                        <option value="0.75">0.75</option>
                      </select>
                      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                        <label style={{ flex: 1 }}>
                          Sea ice threshold
                          <select value={String(seaIceMin)} onChange={(e) => setSeaIceMin(Number(e.target.value))}>
                            <option value="0">0.00</option>
                            <option value="0.02">0.02</option>
                            <option value="0.05">0.05</option>
                            <option value="0.1">0.10</option>
                            <option value="0.15">0.15</option>
                            <option value="0.2">0.20</option>
                            <option value="0.25">0.25</option>
                            <option value="0.3">0.30</option>
                            <option value="0.35">0.35</option>
                          </select>
                          <div className="hint">Colorbar range matches threshold.</div>
                        </label>
                        <label style={{ flex: 1 }}>
                          Height (m)
                          <select value={String(seaIceHeightM)} onChange={(e) => setSeaIceHeightM(Number(e.target.value))}>
                            <option value="0">0</option>
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="5">5</option>
                            <option value="10">10</option>
                            <option value="20">20</option>
                          </select>
                        </label>
                        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ fontSize: 12, opacity: 0.75 }}>Colorbar</div>
                          <button
                            type="button"
                            className={`tab ${showSeaIceColorbar ? "tabActive" : ""}`}
                            onClick={() => setShowSeaIceColorbar((v) => !v)}
                            disabled={!projectOn3d}
                          >
                            {showSeaIceColorbar ? "On" : "Off"}
                          </button>
                        </div>
                      </div>
                      <div className="hint">Status: {seaIceStatus}{seaIceError ? ` — ${seaIceError}` : ""}</div>
                    </label>
                  ) : (
                    <div className="hint">Sea ice is a 2D overlay at z=0 (surface).</div>
                  )}
                </div>
              </details>

              <details className="section">
                <summary>Bathymetry</summary>
                <div className="sectionBody">
                  <div className="toggleRow">
                    <div>Bathy contours</div>
                    <ToggleSwitch checked={showBathyContours} onCheckedChange={setShowBathyContours} />
                  </div>
                  <label>
                    Bathymetry source
                    <select value={bathySource} onChange={(e) => setBathySource(e.target.value as any)}>
                      <option value="auto">Auto (prefer RTopo downsampled)</option>
                      <option value="bathy">bathy.json</option>
                      <option value="rtopo_ds">bathy_RTopo_ds.json</option>
                      <option value="rtopo">bathy_RTopo.json (slow)</option>
                    </select>
                  </label>
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
