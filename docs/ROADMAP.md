# Roadmap

## Done (staging)
- [x] Vite + TypeScript + three.js project
- [x] Quadtree LOD terrain streaming for Oklahoma (AWS Terrain Tiles)
- [x] SPC tornado tracks draped on terrain, coloured and sized by (E)F rating
- [x] NEXRAD Level II fetch + bake pipeline → Cartesian reflectivity grids (`public/data/radar/`)

## Radar volume
- [x] Frames uploaded as R8 `Data3DTexture`s (gzipped on disk, inflated with `DecompressionStream`)
- [x] Raymarched volume: NWS colour table, opacity-corrected compositing, early ray termination
- [x] Rays clipped by a terrain depth pre-pass (log depth decoded in the shader)
- [x] Time slider + playback; neighbouring scans blended in the shader
- [x] Voxel → polar gridding with interpolation between tilts (removes ring/stripe gaps at long range)
- [ ] Gradient-based lighting / self-shadowing for more readable structure
- [ ] Isosurfaces at 35 / 50 / 60 dBZ via marching cubes (WebGPU compute) as a second view
- [ ] Advection-corrected interpolation between frames (crossfading ghosts fast-moving cores)
- [x] Tracks timed from NCEI Storm Events county segments; covered path, funnel marker and on-the-ground list follow radar time

## Atmosphere
- [ ] HRRR (2014+) or ERA5 data at different pressure levels → wind field texture
- [ ] GPU particle streamlines advected through the 3D wind field
- [ ] CAPE / shear overlays on the terrain

## Polish
- [ ] Hilbert-curve ordering of tile requests for cache locality
- [ ] Event picker: Moore 2013-05-20, El Reno 2013-05-31, Shawnee 2013-05-19
- [ ] Deploy to GitHub Pages
- [ ] Data-quality panel: tilt count, gaps, truncated volumes per frame

## Known limitations
- Cone of silence: above the highest tilt (19.5°) close to the radar there's no data, so storm tops near KTLX are clipped.
- The radar grid uses a flat east/north frame around KTLX. Over ±120 km the difference from the scene's Mercator frame is under 1%.
