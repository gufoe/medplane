// Sicily Channel monitoring area bounds
export const SICILY_CHANNEL_BOUNDS = {
    minLat: 32.2429767,
    maxLat: 36.5500941,
    minLon: 10.0583451,
    maxLon: 16.9922709
} as const;

// Central Mediterranean monitoring area bounds
export const CENTRAL_MED_POLYGON = [
  [37.557, 12.676],
  [37.335, 9.863],
  [35.23, 11.113],
  [33.866, 10.087],
  [32.789, 12.481],
  [32.887, 13.195],
  [32.369, 15.082],
  [31.477, 15.631],
  [30.991, 17.625],
  [30.244, 19.192],
  [30.272, 19.122],
  [31.204, 20.164],
  [31.976, 19.948],
  [32.94, 21.716],
  [36.681, 19.585],
  [36.681, 15.134]
] as const;

// for fast initial filtering
export const CENTRAL_MED_BOUNDS = {
  minLat: 30.244,
  maxLat: 37.557,
  minLon: 9.863,
  maxLon: 21.716
} as const;

// Aircraft monitoring thresholds
export const MONITORING_THRESHOLDS = {
    // Altitude in feet
    altitude: {
        min: 100,
        max: 25000
    },
    // Speed in knots
    speed: {
        min: 50,
        max: 300
    },
    // Minimum distance from coast in km
    coast: {
        minDistance: 8
    }
} as const;
