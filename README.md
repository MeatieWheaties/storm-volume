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
  radar/RadarVolume.ts      loads baked frames into 3D textures; raymarched box
  radar/volume.frag.glsl    raymarcher: box intersect, terrain-depth clip, transfer function
  radar/reflectivity.ts     NWS colour table, opacity curve, legend
scripts/
  fetch-spc-tracks.mjs      SPC 1950–2024 tornado CSV → public/data/tracks.geojson
  fetch-nexrad.mjs          Level II volumes from s3://unidata-nexrad-level2 → data/raw/
  bake-radar.mjs            voxel → polar resampling into a 256×256×40 gzipped uint8 dBZ grid
```

**Coordinates.** Scene units are kilometres: +x east, −z north, +y up. The origin is the KTLX radar, so baked radar grids line up with the scene without reprojection.

**Terrain streaming.** Root tiles at zoom 7 cover the state, and tiles split down to zoom 13 near the camera. A tile is replaced by its children only once all four have loaded, so the surface never has holes. Skirts hide cracks where neighbouring tiles are at different detail levels. Vertical exaggeration is applied as a group scale, so it doesn't require rebuilding geometry.

**Radar rendering.** Each frame is a 256×256×40 R8 3D texture. The box's back faces launch one ray per pixel, intersected with the volume bounds and clipped against a terrain-only depth pre-pass (the logarithmic depth buffer is decoded in the shader). Samples are composited front to back through a 256-entry colour/opacity lookup with step-size opacity correction, and the two neighbouring scans are blended for smooth playback.

**Radar baking.** Gridding runs voxel → polar. Each voxel centre is converted to azimuth, slant range and elevation angle with the inverse 4/3 effective-earth-radius beam model. It is sampled on the tilts directly below and above it (nearest radial, linear in range) and interpolated linearly in elevation angle. At storm tops and edges, where only one tilt has echo, the echo extends half a beamwidth and stops. Duplicate cuts (split-cut pairs, SAILS repeats) are merged, keeping the longest-range scan. Output encoding: `0` = no echo, otherwise `dBZ = value / 2 − 32`.

## Data sources

| Data | Source |
|---|---|
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding) |
| Tornado tracks | [NOAA SPC Severe Weather Database](https://www.spc.noaa.gov/wcm/) |
| Radar | [NOAA NEXRAD Level II on AWS](https://registry.opendata.aws/noaa-nexrad/) (`unidata-nexrad-level2`) |

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).
