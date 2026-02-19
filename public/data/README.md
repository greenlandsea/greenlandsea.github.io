# Optional 3D background bathymetry

If you provide a gridded bathymetry file, the Plotly 3D background will use it instead of the built-in synthetic surface.

Create:

- `public/data/bathy.json`

Format:

```json
{
  "lon": [-25, -24.5, "..."],
  "lat": [62, 62.25, "..."],
  "z": [
    [-2000, -2100, "..."],
    [-1900, -2050, "..."]
  ]
}
```

Where `z[j][i]` corresponds to `lat[j]`, `lon[i]` (depth in meters; negative is below sea level).

This app also accepts **positive depth** (meters, positive downward). If the entire grid is non-negative, it will automatically flip the sign so the bathymetry renders as a basin.
