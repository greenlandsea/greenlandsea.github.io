# Greenland Sea website (local template)

This is a lightweight Vite + React template for:

- **Horizontal 2D maps** (lon–lat) like SST/SSS or 500 m temperature/salinity.
- **Vertical transects** along **75°N** (lon on x-axis, depth on y-axis).
- **Interactive 3D background** (Plotly surface) to provide a “3D Greenland Sea” context.
- Optional: **project your PNGs onto the 3D scene** (draped horizontal layer + vertical “curtain” transect).

## Run locally

```bash
npm install
npm start
```

## Drop-in images

Replace the placeholder SVGs by dropping PNGs/SVGs into `public/maps/` (see `public/maps/README.md`).
The app will try `.png` first, then fall back to the bundled `.svg` placeholder with the same basename.

### Notes on projection

The “Project PNG on 3D” option approximates texture mapping by sampling your PNG into a 256-color palette and drawing it as a Plotly `surfacecolor`.
It works best if the PNG is a **data-only raster** (no axis labels / margins). Bounds are configured in `src/data/catalog.ts`.

## Optional bathymetry

Add `public/data/bathy.json` (see `public/data/README.md`) to drive the Plotly 3D background with real bathymetry.

## Zarr dataset (static website friendly)

For large 4D datasets (lon/lat/depth/time), the recommended path is **Zarr** in `public/data/GS.zarr/` so the site can fetch only the chunks it needs.

- Put your Zarr store at `public/data/GS.zarr/`
- Run the site with `npm start`

The UI lets you:

- Choose `T` / `S`
- Pick `time` and `depth` (horizontal) or `time` and `latitude` (transect)
- Play/pause animation
- Project the selected slice onto the Plotly 3D bathymetry

### Configure dataset URL

By default the site loads the Zarr store from:

- `public/data/GS.zarr/` (served as `.../data/GS.zarr/`)

You can override the dataset location:

- Query param: `?store=https://your-host/GS.zarr`
- Build-time env: `VITE_GS_ZARR_URL=https://your-host/GS.zarr`

This is useful for GitHub Pages, because very large Zarr stores may exceed repository size limits.

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/pages.yml`.

1. Push the code to `greenlandsea/greenlandsea.github.io` (branch `main`).
2. In GitHub repo settings → Pages, set **Build and deployment** to **GitHub Actions**.
3. (Optional) Add a repo variable `GS_ZARR_URL` to point to a remotely hosted Zarr store (recommended for large datasets).
