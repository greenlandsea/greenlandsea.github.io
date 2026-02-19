export type HorizontalDepth = "surface" | "500m";

export type HorizontalVariable = "sst" | "sss" | "t500" | "s500";
export type TransectVariable = "temp" | "salt";

export type LonLatBounds = {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

export type LonDepthBounds = {
  lonMin: number;
  lonMax: number;
  depthMin: number; // meters (positive downward)
  depthMax: number; // meters (positive downward)
};

export const HORIZONTAL_VARIABLES: Array<{
  id: HorizontalVariable;
  label: string;
  depths: HorizontalDepth[];
  // expected path (user can drop png/svg here)
  pathByDepth: Record<HorizontalDepth, string>;
  bounds: LonLatBounds;
}> = [
  {
    id: "sst",
    label: "SST (surface)",
    depths: ["surface"],
    pathByDepth: { surface: "maps/horizontal/sst_2010-01-04.png", "500m": "" },
    bounds: { lonMin: -13, lonMax: 8, latMin: 72, latMax: 79 },
  },
  {
    id: "sss",
    label: "SSS (surface)",
    depths: ["surface"],
    pathByDepth: { surface: "maps/horizontal/sss_surface.png", "500m": "" },
    bounds: { lonMin: -13, lonMax: 8, latMin: 72, latMax: 79 },
  },
  {
    id: "t500",
    label: "Temperature (500 m)",
    depths: ["500m"],
    pathByDepth: { surface: "", "500m": "maps/horizontal/temp_500m.png" },
    bounds: { lonMin: -13, lonMax: 8, latMin: 72, latMax: 79 },
  },
  {
    id: "s500",
    label: "Salinity (500 m)",
    depths: ["500m"],
    pathByDepth: { surface: "", "500m": "maps/horizontal/salt_500m.png" },
    bounds: { lonMin: -13, lonMax: 8, latMin: 72, latMax: 79 },
  },
];

export const TRANSECT_VARIABLES_75N: Array<{
  id: TransectVariable;
  label: string;
  // longitude (x) vs depth (y) image along 75N
  path: string;
  lat: number;
  bounds: LonDepthBounds;
}> = [
  {
    id: "temp",
    label: "Temperature (75°N transect)",
    path: "maps/transect/75N/temp_75N.png",
    lat: 75,
    bounds: { lonMin: -13, lonMax: 8, depthMin: 0, depthMax: 3000 },
  },
  {
    id: "salt",
    label: "Salinity (75°N transect)",
    path: "maps/transect/75N/salt_75N.png",
    lat: 75,
    bounds: { lonMin: -13, lonMax: 8, depthMin: 0, depthMax: 3000 },
  },
];
