import * as zarr from "zarrita";
import { withBase } from "./paths";

export type GsZarrVariable = {
  id: "T" | "S";
  label: string;
  units?: string;
  available: boolean;
};

export type GsZarrMeta = {
  storeUrl: string;
  lon: number[];
  lat: number[];
  z: number[]; // meters (typically negative down)
  timeIso: string[]; // YYYY-MM-DD
  variables: GsZarrVariable[];
};

type ZMetadata = {
  metadata: Record<string, any>;
  zarr_consolidated_format?: number;
};

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function toAbsoluteUrl(urlOrPath: string) {
  if (typeof window === "undefined") return urlOrPath;
  return new URL(urlOrPath, window.location.href).toString();
}

function configuredStoreUrl() {
  try {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("store");
      if (p && p.trim()) return p.trim();
    }
  } catch {
    // ignore
  }

  const envUrl = (import.meta as any)?.env?.VITE_GS_ZARR_URL;
  if (typeof envUrl === "string" && envUrl.trim()) return envUrl.trim();

  return "";
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText} for ${url}`);
  }
  return (await r.json()) as T;
}

function parseTimeUnits(units: string): { baseMs: number; unit: "seconds" | "days" } | null {
  // Examples:
  // - "seconds since 1993-08-01"
  // - "seconds since 1993-08-01 00:00:00"
  const m = units.match(/^\s*(seconds|days)\s+since\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/i);
  if (!m) return null;
  const unit = m[1].toLowerCase() as "seconds" | "days";
  const ymd = m[2];
  const hh = Number(m[3] ?? "0");
  const mm = Number(m[4] ?? "0");
  const ss = Number(m[5] ?? "0");
  const [y, mon, d] = ymd.split("-").map((x) => Number(x));
  const baseMs = Date.UTC(y, mon - 1, d, hh, mm, ss);
  return { baseMs, unit };
}

function toIsoDates(values: ArrayLike<number>, units: string) {
  const parsed = parseTimeUnits(units);
  if (!parsed) {
    return Array.from({ length: values.length }, (_, i) => `t=${i}`);
  }
  const unitMs = parsed.unit === "days" ? 24 * 60 * 60 * 1000 : 1000;
  const out: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const ms = parsed.baseMs + Number(values[i]) * unitMs;
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function ensureNegativeDown(z: number[]) {
  const finite = z.filter((v) => Number.isFinite(v));
  if (!finite.length) return z;
  const allPositive = finite.every((v) => v >= 0);
  if (!allPositive) return z;
  return z.map((v) => (Number.isFinite(v) ? -Math.abs(v) : v));
}

function reshape2D(data: ArrayLike<number>, nRows: number, nCols: number): number[][] {
  const out: number[][] = new Array(nRows);
  let k = 0;
  for (let j = 0; j < nRows; j++) {
    const row = new Array(nCols);
    for (let i = 0; i < nCols; i++) row[i] = Number(data[k++]);
    out[j] = row;
  }
  return out;
}

type BathyGrid = { lon: number[]; lat: number[] };

async function loadBathyLonLat(): Promise<BathyGrid> {
  // Fallback only (used if lon/lat cannot be read from the Zarr store).
  // Prefer the smaller bathy.json if present; RTopo can be extremely high-res.
  const candidates = [withBase("data/bathy.json"), withBase("data/bathy_RTopo.json")];
  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const j = await fetchJson<any>(url);
      if (!Array.isArray(j?.lon) || !Array.isArray(j?.lat)) continue;
      return { lon: j.lon.map(Number), lat: j.lat.map(Number) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Failed to load lon/lat from bathymetry json (tried ${candidates.join(", ")}): ${String(
      (lastErr as any)?.message ?? lastErr
    )}`
  );
}

const arrayPromiseCache = new Map<string, Promise<any>>();

async function openArray(storeUrl: string, name: string) {
  const key = `${storeUrl}::${name}`;
  const cached = arrayPromiseCache.get(key);
  if (cached) return cached;
  const p = zarr.open(new zarr.FetchStore(`${storeUrl}/${name}`), { kind: "array" } as any);
  arrayPromiseCache.set(key, p);
  return p;
}

export async function loadGsZarrMeta(): Promise<GsZarrMeta> {
  // zarrita's FetchStore requires an absolute URL for `new URL(root)`.
  const configured = configuredStoreUrl();
  const candidates = configured
    ? [configured]
    : [withBase("data/GS_web.zarr"), withBase("data/GS.zarr")];

  let storeUrl = "";
  let zmeta: ZMetadata | null = null;
  let lastErr: unknown = null;
  for (const c of candidates) {
    const u = normalizeBaseUrl(toAbsoluteUrl(c));
    try {
      zmeta = await fetchJson<ZMetadata>(`${u}/.zmetadata`);
      storeUrl = u;
      break;
    } catch (e) {
      lastErr = e;
      zmeta = null;
      storeUrl = "";
    }
  }
  if (!storeUrl) {
    throw new Error(
      `Could not find a readable Zarr store. Tried: ${candidates.join(", ")}. Last error: ${String(
        (lastErr as any)?.message ?? lastErr
      )}`
    );
  }

  const bathy = await loadBathyLonLat();

  const timeUnits = String(zmeta?.metadata?.["time/.zattrs"]?.units ?? "seconds since 1970-01-01");

  const lonLat = await (async () => {
    try {
      // Common names for coordinates in this project.
      const lonArr = await openArray(storeUrl, "lon");
      const latArr = await openArray(storeUrl, "lat");
      const lonFull = await zarr.get(lonArr);
      const latFull = await zarr.get(latArr);
      const shape = lonFull.shape;
      const latShape = latFull.shape;
      const tol = 1e-6;

      // 1D regular axes
      if (shape.length === 1 && latShape.length === 1) {
        const lon = Array.from(lonFull.data as any, (v: any) => Number(v));
        const lat = Array.from(latFull.data as any, (v: any) => Number(v));
        if (lon.length && lat.length) return { lon, lat };
        return bathy;
      }

      // 2D "regular" grid represented as lon(lat,lon) and lat(lat,lon).
      if (shape.length === 2 && latShape.length === 2 && shape[0] === latShape[0] && shape[1] === latShape[1]) {
        const nLat = shape[0];
        const nLon = shape[1];
        const lonData = lonFull.data as any;
        const latData = latFull.data as any;

        const lon1d: number[] = new Array(nLon);
        for (let i = 0; i < nLon; i++) lon1d[i] = Number(lonData[i]);

        const lat1d: number[] = new Array(nLat);
        for (let j = 0; j < nLat; j++) lat1d[j] = Number(latData[j * nLon]);

        // Verify regularity: lon constant across rows; lat constant across cols.
        for (let i = 0; i < nLon; i++) {
          const a = lon1d[i];
          const b = Number(lonData[(nLat - 1) * nLon + i]);
          if (Math.abs(a - b) > tol) throw new Error("lon(lat,lon) is not constant across rows");
        }
        for (let j = 0; j < nLat; j++) {
          const a = lat1d[j];
          const b = Number(latData[j * nLon + (nLon - 1)]);
          if (Math.abs(a - b) > tol) throw new Error("lat(lat,lon) is not constant across columns");
        }

        return { lon: lon1d, lat: lat1d };
      }

      return bathy;
    } catch {
      return bathy;
    }
  })();

  // Coordinates (best-effort). If the coordinate arrays use an unsupported codec, we fall back to indices.
  const timeArr = await openArray(storeUrl, "time");
  const timeFull = await zarr.get(timeArr);
  // time is often int64 -> may arrive as BigInt64Array
  const timeNum = Array.from(timeFull.data as any, (v: any) => Number(v));
  const timeIso = toIsoDates(timeNum, timeUnits);

  const zVals = await (async () => {
    try {
      const zArr = await openArray(storeUrl, "Z");
      const zFull = await zarr.get(zArr);
      return ensureNegativeDown(Array.from(zFull.data as any, (v: any) => Number(v)));
    } catch {
      // Fallback: derive approximate cell-center depths from drF (thickness).
      try {
        const drfArr = await openArray(storeUrl, "drF");
        const drfFull = await zarr.get(drfArr);
        const drf = Array.from(drfFull.data as any, (v: any) => Number(v));
        let cum = 0;
        const z = drf.map((dz) => {
          const c = -(cum + dz / 2);
          cum += dz;
          return c;
        });
        return ensureNegativeDown(z);
      } catch {
        return Array.from({ length: 1 }, () => 0);
      }
    }
  })();

  const variables: GsZarrVariable[] = await Promise.all(
    (["T", "S"] as const).map(async (id) => {
      const attrs = zmeta?.metadata?.[`${id}/.zattrs`];
      const label = id === "T" ? "Temperature (T)" : "Salinity (S)";
      const units = typeof attrs?.units === "string" ? attrs.units : undefined;
      try {
        // Probe by attempting to open (will 404 if missing).
        await openArray(storeUrl, id);
        return { id, label, units, available: true };
      } catch {
        return { id, label, units, available: false };
      }
    })
  );

  return {
    storeUrl,
    lon: lonLat.lon,
    lat: lonLat.lat,
    z: zVals,
    timeIso,
    variables,
  };
}

export function nearestIndex(values: number[], target: number) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i] - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export async function loadHorizontalSlice(opts: {
  storeUrl: string;
  varId: "T" | "S";
  tIndex: number;
  zIndex: number;
  nLat: number;
  nLon: number;
}): Promise<number[][]> {
  const arr = await openArray(opts.storeUrl, opts.varId);
  const out = await zarr.get(arr, [opts.tIndex, opts.zIndex, null, null] as any);
  const shape = out.shape;
  if (shape.length !== 2) {
    throw new Error(`Expected 2D slice, got shape [${shape.join(",")}]`);
  }
  return reshape2D(out.data as any, shape[0], shape[1]);
}

export async function loadTransectSlice(opts: {
  storeUrl: string;
  varId: "T" | "S";
  tIndex: number;
  yIndex: number; // index into YC
}): Promise<{ values: number[][] }> {
  const arr = await openArray(opts.storeUrl, opts.varId);
  const out = await zarr.get(arr, [opts.tIndex, null, opts.yIndex, null] as any);
  const shape = out.shape;
  if (shape.length !== 2) {
    throw new Error(`Expected 2D transect, got shape [${shape.join(",")}]`);
  }
  return { values: reshape2D(out.data as any, shape[0], shape[1]) };
}
