import json
from pathlib import Path


def downsample_indices(n: int, target: int):
    if n <= target:
        return list(range(n))
    stride = max(1, (n + target - 1) // target)
    idx = list(range(0, n, stride))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def main():
    src = Path("public/data/bathy_RTopo.json")
    dst = Path("public/data/bathy_RTopo_ds.json")

    if not src.exists():
        raise SystemExit(f"Missing {src}")

    print(f"Reading {src} ...")
    with src.open() as f:
        j = json.load(f)

    lon = j["lon"]
    lat = j["lat"]
    z = j["z"]  # signed: land positive, ocean negative (preferred)

    # Target grid size. Keep it modest so Plotly stays responsive.
    target_lon = 500
    target_lat = 350

    lon_idx = downsample_indices(len(lon), target_lon)
    lat_idx = downsample_indices(len(lat), target_lat)

    print(f"Downsampling lon {len(lon)} -> {len(lon_idx)}, lat {len(lat)} -> {len(lat_idx)}")

    out = {
        "lon": [float(lon[i]) for i in lon_idx],
        "lat": [float(lat[jj]) for jj in lat_idx],
        "z": [[float(z[jj][ii]) for ii in lon_idx] for jj in lat_idx],
    }

    dst.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing {dst} ...")
    with dst.open("w") as f:
        json.dump(out, f)

    mb = dst.stat().st_size / (1024 * 1024)
    print(f"Done. {dst} size: {mb:.1f} MB")


if __name__ == "__main__":
    main()

