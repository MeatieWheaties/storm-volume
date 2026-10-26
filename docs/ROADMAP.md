# Roadmap

## Done (staging)
- [x] Vite + TypeScript + three.js project
- [x] Quadtree LOD terrain streaming for Oklahoma (AWS Terrain Tiles)
- [x] SPC tornado tracks draped on terrain, coloured and sized by (E)F rating
- [x] NEXRAD Level II fetch + bake pipeline → Cartesian reflectivity grids (`public/data/radar/`)

## Next: render the radar volume
- [ ] Load `radar/index.json` and upload frames into a `THREE.Data3DTexture` (R8)
- [ ] Isosurfaces at 35 / 50 / 60 dBZ via marching cubes (CPU first, then WebGPU compute)
- [ ] Raymarched volume view as an alternative to the isosurfaces (reflectivity colour table, adjustable opacity)
- [ ] Time slider + playback across frames (~4.5 min apart); interpolate between frames in the shader
- [ ] Highlight the active tornado segment on its track for the current frame time

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
