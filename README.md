# Storm Volume

A real-time 3D viewer for Oklahoma severe weather: streamed terrain, NOAA SPC tornado damage paths, and NEXRAD Level II radar volumes, starting with the **May 20, 2013 Moore EF5**.

Built with TypeScript, three.js and Vite. No API keys required; all data comes from public NOAA and AWS Open Data archives.

## Quick start

```bash
npm install
npm run data      # fetch tornado tracks + radar scans and bake them into public/data/
npm run dev       # http://localhost:5173
```

## Architecture

```
src/
  config.ts                 scene origin (KTLX radar), Oklahoma bounds, event, LOD tuning
  geo/projection.ts         lon/lat ⇄ scene km (local Web Mercator, cos-lat scaled)
  terrain/TerrainTile.ts    Terrarium PNG decode → skirted height-field mesh with normals and hypsometric colours
  terrain/TerrainManager.ts quadtree LOD streaming, distance-prioritised loads, LRU eviction
  overlays/TornadoTracks.ts SPC paths draped on whatever terrain LOD is loaded
  overlays/RadarSite.ts     KTLX marker and range rings
scripts/
  fetch-spc-tracks.mjs      SPC 1950–2024 tornado CSV → public/data/tracks.geojson
  fetch-nexrad.mjs          Level II volumes from s3://unidata-nexrad-level2 → data/raw/
  bake-radar.mjs            polar gates → 256×256×40 Cartesian uint8 dBZ grid (4/3-earth beam model)
```

**Coordinates.** Scene units are kilometres: +x east, −z north, +y up. The origin is the KTLX radar, so baked radar grids line up with the scene without reprojection.

**Terrain streaming.** Root tiles at zoom 7 cover the state, and tiles split down to zoom 13 near the camera. A tile is replaced by its children only once all four have loaded, so the surface never has holes. Skirts hide cracks where neighbouring tiles are at different detail levels. Vertical exaggeration is applied as a group scale, so it doesn't require rebuilding geometry.

**Radar baking.** Each gate is placed using the standard 4/3 effective-earth-radius beam height and ground-range model, then max-binned into a voxel. Short vertical gaps between tilts are linearly filled. Output encoding: `0` = no echo, otherwise `dBZ = value / 2 − 32`.

## Data sources

| Data | Source |
|---|---|
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding) |
| Tornado tracks | [NOAA SPC Severe Weather Database](https://www.spc.noaa.gov/wcm/) |
| Radar | [NOAA NEXRAD Level II on AWS](https://registry.opendata.aws/noaa-nexrad/) (`unidata-nexrad-level2`) |

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).
