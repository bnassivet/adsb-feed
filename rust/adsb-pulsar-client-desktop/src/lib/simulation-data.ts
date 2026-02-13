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
 * 20 simulated flights concentrated around Montreal (within 30km).
 *
 * Features:
 * - Helicopter patrols: Police, medical, news, fire, tour helicopters (500-1500ft)
 * - High-maneuvering aircraft: CF-18 fighter aerobatics, trainer touch-and-goes
 * - Varying altitudes: 500ft (float plane) to 40000ft (overflight)
 * - Commercial traffic: Arrivals/departures at YUL (12000-22000ft)
 * - General aviation: VFR sightseeing, student pilots, banner tow (1000-3000ft)
 * - Special operations: Skydiving, banner towing, float plane tours
 *
 * First 10 flights: Mixed altitudes (1000-40000ft) with commercial and military
 * Last 10 flights: Low-level only (500-2800ft) around Montreal landmarks
 */
export const SIMULATED_FLIGHTS: SimulatedFlight[] = [
  // 1. HELI01 — Police/news helicopter touring Old Port and Île Sainte-Hélène
  {
    hex_ident: "SIM-0001",
    callsign: "HELI01",
    squawk: "7001",
    altitude: 1000,
    ground_speed: 80,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.508, -73.554], // Old Port
      [45.514, -73.548], // Along waterfront
      [45.520, -73.540], // Approaching Jean-Drapeau
      [45.517, -73.530], // Parc Jean-Drapeau (island)
      [45.513, -73.520], // East side of island
      [45.507, -73.525], // South shore view
      [45.502, -73.540], // Habitat 67 area
      [45.505, -73.550], // Return to Old Port
    ],
  },

  // 2. CF418 — CF-18 fighter jet performing aerobatic maneuvers over St. Lawrence
  {
    hex_ident: "SIM-0002",
    callsign: "CF418",
    squawk: "7002",
    altitude: 8000,
    ground_speed: 420,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.45, -73.50], // Start south of city
      [45.52, -73.48], // Sharp turn north
      [45.58, -73.55], // Bank west
      [45.55, -73.65], // Tight turn south
      [45.48, -73.62], // Loop southeast
      [45.43, -73.55], // Complete maneuver
      [45.47, -73.47], // Return east
      [45.50, -73.52], // Center for next pass
    ],
  },

  // 3. TRN220 — Training aircraft doing touch-and-go patterns at YUL
  {
    hex_ident: "SIM-0003",
    callsign: "TRN220",
    squawk: "7003",
    altitude: 1800,
    ground_speed: 110,
    vertical_rate: -150,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL runway approach
      [45.45, -73.78], // Downwind leg
      [45.42, -73.75], // Base turn
      [45.44, -73.70], // Final approach
      [45.47, -73.74], // Touch-and-go
      [45.49, -73.77], // Climb out
      [45.48, -73.80], // Crosswind turn
      [45.46, -73.82], // Back to downwind
    ],
  },

  // 4. ACA825 — Commercial arrival from east, descending into YUL
  {
    hex_ident: "SIM-0004",
    callsign: "ACA825",
    squawk: "4301",
    altitude: 12000,
    ground_speed: 260,
    vertical_rate: -800,
    is_on_ground: false,
    waypoints: [
      [45.55, -73.20], // East approach
      [45.52, -73.40], // Descending
      [45.50, -73.55], // Final approach path
      [45.48, -73.65], // Lined up
      [45.47, -73.74], // YUL
    ],
  },

  // 5. TSC630 — Commercial departure to south, climbing
  {
    hex_ident: "SIM-0005",
    callsign: "TSC630",
    squawk: "4302",
    altitude: 15000,
    ground_speed: 300,
    vertical_rate: 1200,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL departure
      [45.42, -73.68], // Climb south
      [45.35, -73.60], // Continue climb
      [45.28, -73.55], // Leaving Montreal area
      [45.20, -73.50], // En route
    ],
  },

  // 6. WJA552 — Regional jet in holding pattern north of YUL
  {
    hex_ident: "SIM-0006",
    callsign: "WJA552",
    squawk: "4303",
    altitude: 9000,
    ground_speed: 220,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.62, -73.65], // Holding pattern NW
      [45.65, -73.55], // North leg
      [45.63, -73.45], // Turn east
      [45.58, -73.40], // Southeast corner
      [45.55, -73.50], // Turn back west
      [45.58, -73.60], // Complete pattern
    ],
  },

  // 7. UAL944 — High altitude overflight crossing Montreal W to E
  {
    hex_ident: "SIM-0007",
    callsign: "UAL944",
    squawk: "4304",
    altitude: 40000,
    ground_speed: 480,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.52, -74.00], // West of Montreal
      [45.51, -73.70], // Over western suburbs
      [45.50, -73.40], // Over city center
      [45.49, -73.10], // East of Montreal
      [45.48, -72.80], // Continuing east
    ],
  },

  // 8. CRJ105 — Corporate jet arriving from west
  {
    hex_ident: "SIM-0008",
    callsign: "CRJ105",
    squawk: "4305",
    altitude: 18000,
    ground_speed: 280,
    vertical_rate: -600,
    is_on_ground: false,
    waypoints: [
      [45.48, -74.20], // West approach
      [45.48, -74.00], // Descending
      [45.47, -73.85], // On approach
      [45.47, -73.74], // YUL
    ],
  },

  // 9. FDX771 — Cargo departure north, climbing to cruise
  {
    hex_ident: "SIM-0009",
    callsign: "FDX771",
    squawk: "4306",
    altitude: 22000,
    ground_speed: 320,
    vertical_rate: 800,
    is_on_ground: false,
    waypoints: [
      [45.47, -73.74], // YUL departure
      [45.52, -73.72], // Climb north
      [45.58, -73.70], // Continue climb
      [45.65, -73.68], // Cruise altitude
      [45.72, -73.65], // En route north
    ],
  },

  // 10. VFR88 — Local sightseeing flight circling downtown
  {
    hex_ident: "SIM-0010",
    callsign: "VFR88",
    squawk: "1200",
    altitude: 3000,
    ground_speed: 95,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.50, -73.57], // Downtown Montreal
      [45.52, -73.50], // East side
      [45.54, -73.56], // North
      [45.52, -73.63], // West side (Mount Royal)
      [45.48, -73.60], // Southwest
      [45.47, -73.54], // South
      [45.49, -73.52], // Return downtown
    ],
  },

  // 11. HELI02 — Medical helicopter (EVAC) doing hospital circuit
  {
    hex_ident: "SIM-0011",
    callsign: "EVAC1",
    squawk: "7700",
    altitude: 800,
    ground_speed: 90,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.495, -73.580], // Montreal General Hospital
      [45.505, -73.590], // North to CHUM
      [45.515, -73.575], // Jewish General area
      [45.508, -73.565], // Maisonneuve-Rosemont
      [45.500, -73.572], // Return to MGH area
    ],
  },

  // 12. N123AB — Small Cessna doing practice approaches at Saint-Hubert
  {
    hex_ident: "SIM-0012",
    callsign: "N123AB",
    squawk: "1200",
    altitude: 1200,
    ground_speed: 85,
    vertical_rate: -100,
    is_on_ground: false,
    waypoints: [
      [45.52, -73.42], // Saint-Hubert approach
      [45.50, -73.40], // Base leg
      [45.48, -73.42], // Final
      [45.46, -73.41], // Touch-and-go
      [45.48, -73.38], // Crosswind
      [45.51, -73.40], // Downwind
    ],
  },

  // 13. NEWS1 — TV news helicopter covering traffic over bridges
  {
    hex_ident: "SIM-0013",
    callsign: "NEWS1",
    squawk: "7001",
    altitude: 1500,
    ground_speed: 75,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.490, -73.545], // Jacques Cartier Bridge
      [45.505, -73.550], // Over Old Port
      [45.520, -73.565], // Champlain Bridge area
      [45.510, -73.595], // Victoria Bridge
      [45.495, -73.585], // Return to Jacques Cartier
      [45.485, -73.560], // South shore view
    ],
  },

  // 14. C-FXYZ — Float plane doing St. Lawrence River tour
  {
    hex_ident: "SIM-0014",
    callsign: "C-FXYZ",
    squawk: "1200",
    altitude: 500,
    ground_speed: 70,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.485, -73.520], // Low over river east
      [45.495, -73.535], // Near Boucherville
      [45.505, -73.545], // Old Montreal waterfront
      [45.515, -73.555], // Parc Jean-Drapeau low pass
      [45.520, -73.540], // Island circuit
      [45.510, -73.525], // Return along river
    ],
  },

  // 15. BANNER — Banner-towing aircraft over festivals
  {
    hex_ident: "SIM-0015",
    callsign: "BANNER",
    squawk: "1200",
    altitude: 1000,
    ground_speed: 65,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.495, -73.570], // Downtown west
      [45.500, -73.550], // Over festivals area
      [45.505, -73.560], // Plateau circuit
      [45.510, -73.575], // North end
      [45.505, -73.585], // West side
      [45.498, -73.578], // Return south
    ],
  },

  // 16. VFR12 — Student pilot practicing slow flight over north shore
  {
    hex_ident: "SIM-0016",
    callsign: "VFR12",
    squawk: "1200",
    altitude: 2500,
    ground_speed: 60,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.55, -73.60], // North of city
      [45.57, -73.55], // Northeast
      [45.56, -73.50], // East turn
      [45.54, -73.48], // South turn
      [45.52, -73.52], // West turn
      [45.53, -73.58], // Return north
    ],
  },

  // 17. POLICE — Police helicopter patrol over highways
  {
    hex_ident: "SIM-0017",
    callsign: "POLICE",
    squawk: "7001",
    altitude: 1200,
    ground_speed: 95,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.48, -73.68], // Highway 20 west
      [45.50, -73.63], // Decarie interchange
      [45.52, -73.60], // Metropolitan east
      [45.54, -73.62], // Highway 40
      [45.52, -73.67], // Back to 20
      [45.49, -73.65], // Circuit
    ],
  },

  // 18. SKYDIVE — Skydiving jump plane climbing for drop zone
  {
    hex_ident: "SIM-0018",
    callsign: "SKYDIVE",
    squawk: "1200",
    altitude: 2800,
    ground_speed: 100,
    vertical_rate: 500,
    is_on_ground: false,
    waypoints: [
      [45.42, -73.50], // South shore DZ
      [45.43, -73.52], // Climb pattern
      [45.44, -73.54], // Continue climb
      [45.43, -73.56], // Turn for drop
      [45.42, -73.54], // Over DZ
      [45.41, -73.52], // Descend after drop
    ],
  },

  // 19. N789CD — Private pilot doing Mount Royal scenic tour
  {
    hex_ident: "SIM-0019",
    callsign: "N789CD",
    squawk: "1200",
    altitude: 2200,
    ground_speed: 90,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.505, -73.590], // Mount Royal west
      [45.515, -73.600], // North side
      [45.520, -73.590], // Over summit
      [45.518, -73.580], // East lookout
      [45.510, -73.575], // South side
      [45.502, -73.585], // Complete circuit
    ],
  },

  // 20. FIREFTR — Fire patrol helicopter checking water sources
  {
    hex_ident: "SIM-0020",
    callsign: "FIREFTR",
    squawk: "7001",
    altitude: 600,
    ground_speed: 70,
    vertical_rate: 0,
    is_on_ground: false,
    waypoints: [
      [45.475, -73.545], // St. Lawrence low
      [45.485, -73.555], // Along shore
      [45.495, -73.565], // Lachine Canal
      [45.505, -73.580], // Westward
      [45.495, -73.595], // Water access points
      [45.485, -73.585], // Return to river
      [45.478, -73.570], // Low patrol
    ],
  },
];
