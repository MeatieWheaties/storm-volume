// Scene-wide settings. Scene units are kilometres: +x east, -z north, +y up.

export interface LonLat {
  lon: number;
  lat: number;
}

/** Scene origin. Centred on the KTLX radar so baked radar volumes need no re-projection. */
export const ORIGIN: LonLat = { lon: -97.2778, lat: 35.3331 };

/** Oklahoma bounding box (degrees). Terrain streaming is clipped to this. */
export const OKLAHOMA_BOUNDS = { west: -103.0, east: -94.43, south: 33.62, north: 37.0 };

export const EVENT = {
  label: 'May 20, 2013 · Moore, OK · EF5',
  focus: { lon: -97.49, lat: 35.33 } as LonLat,
};

export const RADAR_SITE = {
  id: 'KTLX',
  position: ORIGIN,
  /** Level II reflectivity range in km. */
  rangeKm: 460,
};

export const TERRAIN = {
  tileUrl: (z: number, x: number, y: number) =>
    `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`,
  rootZoom: 7,
  maxZoom: 13,
  /** Vertices per tile edge (excluding skirt). */
  segments: 64,
  /** Split a tile when the camera is closer than tileWidth * splitFactor. */
  splitFactor: 1.6,
  maxConcurrentLoads: 6,
  maxCachedTiles: 700,
  defaultExaggeration: 4,
};
