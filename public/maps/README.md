# Static image folders (drop-in)

This template loads maps from `public/maps/` so you can drop PNG files without rebuilding code.

## Horizontal maps (lon–lat)

Put images under:

- `public/maps/horizontal/`

Default expected filenames (edit in `src/data/catalog.ts`):

- `sst_surface.png` (or `.svg`)
- `sss_surface.png` (or `.svg`)
- `temp_500m.png` (or `.svg`)
- `salt_500m.png` (or `.svg`)

### SST time series (optional)

If you add multiple SST frames, name them:

- `public/maps/horizontal/sst_YYYY-MM-DD.png`

Example: `sst_2010-01-04.png` (every 5 days).

The app will try to discover these automatically. For faster startup, you can also provide:

- `public/maps/horizontal/sst_manifest.json` with `{"dates":["2010-01-04","2010-01-09", ...]}`

## Transects (75°N)

Put images under:

- `public/maps/transect/75N/`

Default expected filenames:

- `temp_75N.png` (or `.svg`) — x: lon, y: depth
- `salt_75N.png` (or `.svg`)
