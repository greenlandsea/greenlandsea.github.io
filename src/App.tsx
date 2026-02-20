import React, { useCallback, useEffect, useMemo, useState } from "react";
import Basemap3D from "./components/Basemap3D";
import { blues_r_256, paletteToColorscale, rdylbu_r_256 } from "./lib/colormap";
import {
  loadGsZarrMeta,
  loadHorizontalSlice,
  load3DFieldAtTime,
  loadSeaIce2D,
  loadTransectSlice,
  nearestIndex,
  slice3DTo2D,
  type GsZarrMeta,
} from "./lib/gsZarr";

type ViewMode = "water3d" | "horizontal" | "transect";
type VarId = "T" | "S";
type ProjectionMode = "surface" | "bathy";
type ColorscaleMode = "continuous" | "discrete";

type VarColorSettings = {
  cmin: number;
  cmax: number;
  tickCount: number; // 0 => auto
  mode: ColorscaleMode;
  levels: number; // used when mode === "discrete"
};

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

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("water3d");
  const [varId, setVarId] = useState<VarId>("T");
  const [projectOn3d, setProjectOn3d] = useState(true);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>("surface");
  const [overlayOpacity, setOverlayOpacity] = useState(0.9);
  const [showColorbar, setShowColorbar] = useState(true);
  const [showBathyContours, setShowBathyContours] = useState(false);
  const [colorSettings, setColorSettings] = useState<Record<VarId, VarColorSettings>>(
    DEFAULT_COLOR_SETTINGS
  );
  const [showSeaIce, setShowSeaIce] = useState(true);
  const [seaIceOpacity, setSeaIceOpacity] = useState(0.55);
  const [stackSlices, setStackSlices] = useState(8);
  const [stackOpacity, setStackOpacity] = useState(0.16);

  const [timeIdx, setTimeIdx] = useState(0);
  const [depthIdx, setDepthIdx] = useState(0);
  const [latTarget, setLatTarget] = useState(75);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(2);

  const [metaStatus, setMetaStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [meta, setMeta] = useState<GsZarrMeta | null>(null);

  const [sliceStatus, setSliceStatus] = useState<"off" | "loading" | "ready" | "failed">(
    "off"
  );
  const [sliceError, setSliceError] = useState<string | null>(null);

  const [horizontalValues, setHorizontalValues] = useState<number[][] | null>(null);
  const [transectValues, setTransectValues] = useState<number[][] | null>(null);
  const [transectLatActual, setTransectLatActual] = useState<number | null>(null);
  const [field3d, setField3d] = useState<{ data: Float32Array; nz: number; ny: number; nx: number } | null>(
    null
  );
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
      setTimeIdx((i) => (i + 1) % timeList.length);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [fps, metaStatus, playing, timeList.length]);

  useEffect(() => {
    if (!meta || metaStatus !== "ready") return;
    if (!projectOn3d) {
      setSliceStatus("off");
      setSliceError(null);
      setHorizontalValues(null);
      setTransectValues(null);
      setTransectLatActual(null);
      setField3d(null);
      setSeaIceValues(null);
      return;
    }

    let cancelled = false;
    setSliceStatus("loading");
    setSliceError(null);

    (async () => {
      try {
        if (viewMode === "water3d") {
          const [v3, ice] = await Promise.all([
            load3DFieldAtTime({ storeUrl: meta.storeUrl, varId, tIndex: safeTimeIdx }),
            showSeaIce ? loadSeaIce2D({ storeUrl: meta.storeUrl, tIndex: safeTimeIdx }) : Promise.resolve(null),
          ]);
          if (cancelled) return;
          setField3d(v3);
          setSeaIceValues(ice);
          setHorizontalValues(null);
          setTransectValues(null);
          setTransectLatActual(null);
          setSliceStatus("ready");
        } else if (viewMode === "horizontal") {
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
          setField3d(null);
          setSeaIceValues(null);
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
          setField3d(null);
          setSeaIceValues(null);
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
        setField3d(null);
        setSeaIceValues(null);
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
    showSeaIce,
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
      mode: projectionMode,
      zPlane: meta.z?.[safeDepthIdx] ?? 0,
      showScale: showColorbar,
      colorbarTitle: range.title,
      colorbarTicks,
    };
  }, [
    colorscale,
    horizontalValues,
    meta,
    overlayOpacity,
    projectOn3d,
    projectionMode,
    safeDepthIdx,
    showColorbar,
    colorbarTicks,
    range.title,
    settings.cmax,
    settings.cmin,
    viewMode,
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
  ]);

  const horizontalPlanes = useMemo(() => {
    if (!meta || !projectOn3d || viewMode !== "water3d" || sliceStatus !== "ready" || !field3d) return undefined;
    const nz = meta.z.length;
    if (!nz) return undefined;
    const n = Math.max(2, Math.min(stackSlices, nz));
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      indices.push(Math.round(t * (nz - 1)));
    }
    const planes = indices.map((k, i) => {
      const values2d = slice3DTo2D({ data: field3d.data, nz: field3d.nz, ny: field3d.ny, nx: field3d.nx, k });
      const showScaleThis = Boolean(showColorbar) && i === indices.length - 1;
      return {
        enabled: true,
        values: values2d,
        lon: meta.lon,
        lat: meta.lat,
        cmin: settings.cmin,
        cmax: settings.cmax,
        colorscale,
        opacity: stackOpacity,
        mode: "surface" as const,
        zPlane: meta.z[k] ?? 0,
        showScale: showScaleThis,
        colorbarTitle: range.title,
        colorbarTicks,
      };
    });

    if (showSeaIce && seaIceValues) {
      planes.push({
        enabled: true,
        values: seaIceValues,
        lon: meta.lon,
        lat: meta.lat,
        cmin: 0,
        cmax: 1,
        colorscale: paletteToColorscale(blues_r_256()),
        opacity: seaIceOpacity,
        mode: "surface" as const,
        zPlane: 0,
        showScale: false,
        colorbarTitle: "Sea ice (0–1)",
      });
    }

    return planes;
  }, [
    colorbarTicks,
    colorscale,
    field3d,
    meta,
    projectOn3d,
    range.title,
    seaIceOpacity,
    seaIceValues,
    settings.cmax,
    settings.cmin,
    showColorbar,
    showSeaIce,
    sliceStatus,
    stackOpacity,
    stackSlices,
    viewMode,
  ]);

  const resetColorScale = useCallback(() => {
    setColorSettings((prev) => ({ ...prev, [varId]: DEFAULT_COLOR_SETTINGS[varId] }));
  }, [varId]);

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
        onStatusChange={handleStatusChange}
        showBathyContours={showBathyContours}
        horizontalField={horizontalField}
        horizontalPlanes={horizontalPlanes}
        transectField={transectField}
      />

      <div className="overlay">
        <div className="panel sidebar">
          <div className="title">
            <div>
              <h1>Greenland Sea</h1>
              <div className="sub">Zarr-driven T/S visualization</div>
            </div>
            <div className="badge">Local</div>
          </div>

          <div className="controls">
            <div className="tabs">
              <button
                className={`tab ${viewMode === "water3d" ? "tabActive" : ""}`}
                onClick={() => setViewMode("water3d")}
              >
                3D Water
              </button>
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

            <div
              style={{
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                padding: "10px 10px",
                background: "rgba(255,255,255,0.02)",
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.78)" }}>
                Color scale
              </div>

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
                          cmin:
                            e.target.value === "" ? prev[varId].cmin : Number(e.target.value),
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
                          cmax:
                            e.target.value === "" ? prev[varId].cmax : Number(e.target.value),
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

            {viewMode === "water3d" ? (
              <>
                <label>
                  3D stack slices (count)
                  <select value={String(stackSlices)} onChange={(e) => setStackSlices(Number(e.target.value))}>
                    <option value="6">6</option>
                    <option value="8">8</option>
                    <option value="10">10</option>
                    <option value="12">12</option>
                    <option value="16">16</option>
                  </select>
                </label>
                <label>
                  Stack opacity
                  <select value={String(stackOpacity)} onChange={(e) => setStackOpacity(Number(e.target.value))}>
                    <option value="0.08">0.08</option>
                    <option value="0.12">0.12</option>
                    <option value="0.14">0.14</option>
                    <option value="0.18">0.18</option>
                    <option value="0.22">0.22</option>
                  </select>
                </label>
                <label>
                  Sea ice (SIarea)
                  <select value={showSeaIce ? "on" : "off"} onChange={(e) => setShowSeaIce(e.target.value === "on")}>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                {showSeaIce ? (
                  <label>
                    Sea ice opacity
                    <select
                      value={String(seaIceOpacity)}
                      onChange={(e) => setSeaIceOpacity(Number(e.target.value))}
                    >
                      <option value="0.35">0.35</option>
                      <option value="0.45">0.45</option>
                      <option value="0.55">0.55</option>
                      <option value="0.65">0.65</option>
                      <option value="0.75">0.75</option>
                    </select>
                  </label>
                ) : null}
              </>
            ) : viewMode === "horizontal" ? (
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
                Latitude target (°N)
                <input
                  type="number"
                  value={latTarget}
                  min={latMin}
                  max={latMax}
                  step={0.1}
                  onChange={(e) => setLatTarget(Number(e.target.value))}
                  disabled={metaStatus !== "ready"}
                />
                {transectLatActual != null ? (
                  <div className="hint">Nearest model latitude: {transectLatActual.toFixed(3)}°N</div>
                ) : null}
              </label>
            )}

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

            <label>
              3D overlay
              <select
                value={projectOn3d ? "on" : "off"}
                onChange={(e) => setProjectOn3d(e.target.value === "on")}
              >
                <option value="on">On</option>
                <option value="off">Off (bathymetry only)</option>
              </select>
            </label>

            {viewMode === "horizontal" ? (
              <label>
                Projection mode
                <select
                  value={projectionMode}
                  onChange={(e) => setProjectionMode(e.target.value as ProjectionMode)}
                  disabled={!projectOn3d}
                >
                  <option value="bathy">Texture on bathymetry</option>
                  <option value="surface">Plane at selected depth</option>
                </select>
              </label>
            ) : null}

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

            <label>
              Colorbar
              <select
                value={showColorbar ? "show" : "hide"}
                onChange={(e) => setShowColorbar(e.target.value === "show")}
              >
                <option value="show">Show</option>
                <option value="hide">Hide</option>
              </select>
            </label>

            <label>
              Bathymetry contours
              <select
                value={showBathyContours ? "on" : "off"}
                onChange={(e) => setShowBathyContours(e.target.value === "on")}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </label>

            <div className="hint">
              Dataset: <b>public/data/GS.zarr</b> — meta <b>{metaStatus}</b>
              {metaStatus === "failed" && metaError ? (
                <div style={{ marginTop: 6 }}>Error: {metaError}</div>
              ) : null}
            </div>

            <div className="hint">
              Slice: <b>{sliceStatus}</b>
              {sliceStatus === "failed" && sliceError ? (
                <div style={{ marginTop: 6 }}>Error: {sliceError}</div>
              ) : null}
            </div>

            <div className="hint">
              3D: Plotly <b>{bathyInfo.plotly}</b>, bathymetry <b>{bathyInfo.bathy}</b>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
