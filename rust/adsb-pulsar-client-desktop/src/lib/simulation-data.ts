/** Definition of a simulated flight route for demo mode. */
export interface SimulatedFlight {
  hex_ident: string;
  callsign: string;
  squawk: string;
  altitude: number;
  ground_speed: number;
  vertical_rate: number;
  is_on_ground: boolean;
  /** Ordered [lat, lng] waypoints defining the route */
  waypoints: [number, number][];
}

/**
 * 10 simulated flights around the Montreal area (~100 km radius of YUL).
 * Covers departures, arrivals, overflights, and a holding pattern.
 */
export const SIMULATED_FLIGHTS: SimulatedFlight[] = [
  // 1. ACA101 — YUL departure NE toward Quebec City
  {
    hex_ident: "SIM-0001",
    callsign: "ACA101",
    squawk: "4201",
    altitude: 28000,
    ground_speed: 280,
    vertical_rate: 500,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL
      [45.65, -73.35],
      [45.95, -72.80],
      [46.30, -72.20],
      [46.50, -71.50], // Near Quebec City
    ],
  },
  // 2. ACA205 — YUL arrival from SW (Toronto direction)
  {
    hex_ident: "SIM-0002",
    callsign: "ACA205",
    squawk: "4202",
    altitude: 8000,
    ground_speed: 250,
    vertical_rate: -800,
    is_on_ground: false,
    waypoints: [
      [44.50, -75.70], // SW of Montreal
      [44.80, -75.10],
      [45.10, -74.50],
      [45.30, -74.10],
      [45.47, -73.74], // YUL
    ],
  },
  // 3. UAL442 — Overflight W→E high altitude
  {
    hex_ident: "SIM-0003",
    callsign: "UAL442",
    squawk: "4203",
    altitude: 37000,
    ground_speed: 480,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.60, -75.70],
      [45.55, -74.90],
      [45.50, -74.10],
      [45.45, -73.20],
      [45.40, -72.30],
    ],
  },
  // 4. DAL317 — Overflight NW→SE
  {
    hex_ident: "SIM-0004",
    callsign: "DAL317",
    squawk: "4204",
    altitude: 35000,
    ground_speed: 460,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [46.40, -75.50],
      [46.00, -74.80],
      [45.60, -74.10],
      [45.10, -73.30],
      [44.60, -72.50],
    ],
  },
  // 5. TSC789 — YUL departure S toward New York
  {
    hex_ident: "SIM-0005",
    callsign: "TSC789",
    squawk: "4205",
    altitude: 32000,
    ground_speed: 300,
    vertical_rate: 400,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL
      [45.20, -73.60],
      [44.95, -73.50],
      [44.70, -73.40],
      [44.50, -73.30],
    ],
  },
  // 6. ACA330 — YUL arrival from E (Atlantic direction)
  {
    hex_ident: "SIM-0006",
    callsign: "ACA330",
    squawk: "4206",
    altitude: 12000,
    ground_speed: 260,
    vertical_rate: -600,
    is_on_ground: false,
    waypoints: [
      [46.00, -71.50],
      [45.85, -72.10],
      [45.70, -72.70],
      [45.58, -73.30],
      [45.47, -73.74], // YUL
    ],
  },
  // 7. WJA614 — Circular hold NW of YUL (loop-friendly)
  {
    hex_ident: "SIM-0007",
    callsign: "WJA614",
    squawk: "4207",
    altitude: 12000,
    ground_speed: 220,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.80, -74.20],
      [45.90, -74.00],
      [45.85, -73.80],
      [45.70, -73.80],
      [45.65, -74.00],
      [45.75, -74.20],
    ],
  },
  // 8. FDX902 — Overflight S→N (cargo)
  {
    hex_ident: "SIM-0008",
    callsign: "FDX902",
    squawk: "4208",
    altitude: 39000,
    ground_speed: 490,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [44.50, -73.60],
      [44.90, -73.70],
      [45.30, -73.80],
      [45.80, -73.90],
      [46.30, -74.00],
    ],
  },
  // 9. POT225 — Low regional YOW→YUL (Ottawa to Montreal)
  {
    hex_ident: "SIM-0009",
    callsign: "POT225",
    squawk: "4209",
    altitude: 8000,
    ground_speed: 180,
    vertical_rate: -200,
    is_on_ground: false,
    waypoints: [
      [45.32, -75.67], // Near Ottawa
      [45.35, -75.10],
      [45.38, -74.50],
      [45.42, -74.10],
      [45.47, -73.74], // YUL
    ],
  },
  // 10. JAZ515 — YUL departure NW toward Ottawa
  {
    hex_ident: "SIM-0010",
    callsign: "JAZ515",
    squawk: "4210",
    altitude: 22000,
    ground_speed: 260,
    vertical_rate: 300,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL
      [45.55, -74.10],
      [45.60, -74.50],
      [45.55, -74.90],
      [45.40, -75.40],
    ],
  },
];
