import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetarInfo } from "../MetarInfo";
import { normalizeMetar } from "@/lib/metar";

const cyul = normalizeMetar({
  icaoId: "CYUL", name: "Montreal/Trudeau Intl, QC, CA", lat: 45.468, lon: -73.742, obsTime: 1795053600,
  fltCat: "IFR", temp: 9, dewp: 4, wdir: 250, wspd: 9, wgst: 16, visib: 15, altim: 1027.2,
  clouds: [{ cover: "OVC", base: 800 }], rawOb: "METAR CYUL 190200Z 25009G16KT 15SM OVC008 09/04 A3033",
})!;
const NOW = cyul.obsTimeMs + 25 * 60_000;

describe("MetarInfo", () => {
  it("renders nothing without a station", () => {
    const { container } = render(<MetarInfo metar={null} nowMs={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("decodes the report and keeps the raw text", () => {
    render(<MetarInfo metar={cyul} nowMs={NOW} />);
    expect(screen.getByText("CYUL")).toBeInTheDocument();
    expect(screen.getByText("IFR")).toBeInTheDocument();
    expect(screen.getByText(/25 min ago/)).toBeInTheDocument();
    expect(screen.getByText(/250° 9G16 kt/)).toBeInTheDocument();
    expect(screen.getByText(/OVC 800 ft/)).toBeInTheDocument();
    expect(screen.getByText(/9 \/ 4 °C/)).toBeInTheDocument();
    expect(screen.getByText(/QNH 1027 hPa/)).toBeInTheDocument();
    expect(screen.getByText("METAR CYUL 190200Z 25009G16KT 15SM OVC008 09/04 A3033")).toBeInTheDocument();
  });

  it("flags an old report", () => {
    render(<MetarInfo metar={cyul} nowMs={cyul.obsTimeMs + 3 * 3_600_000} />);
    expect(screen.getByText(/old report/i)).toBeInTheDocument();
  });
});
