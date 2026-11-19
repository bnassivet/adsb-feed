import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AirspaceInfo } from "../AirspaceInfo";
import type { Airspace } from "@/lib/airspace";

function a(name: string, over: Partial<Airspace> = {}): Airspace {
  return {
    id: `CA:${name}`, name, type: 7, typeLabel: "TMA", icaoClass: 2, classLabel: "C",
    lower: "2500 ft", upper: "FL180", lowerFt: 2500, ring: [], bbox: [0, 0, 0, 0], country: "CA",
    ...over,
  };
}

describe("AirspaceInfo", () => {
  it("renders nothing for an empty stack", () => {
    const { container } = render(<AirspaceInfo stack={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each airspace with type, class and vertical limits", () => {
    render(<AirspaceInfo stack={[a("MONTREAL CTR", { typeLabel: "CTR", lower: "GND", upper: "3000 ft" }), a("MONTREAL TMA")]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("MONTREAL CTR");
    expect(items[0]).toHaveTextContent("CTR C");
    expect(items[0]).toHaveTextContent("GND – 3000 ft");
    expect(items[1]).toHaveTextContent("2500 ft – FL180");
  });

  it("omits the class letter for special-use airspace", () => {
    render(<AirspaceInfo stack={[a("CYR 606", { typeLabel: "Restricted", classLabel: null })]} />);
    expect(screen.getByRole("listitem")).toHaveTextContent(/Restricted\s*·/);
  });

  it("caps a tall stack and says how many are left", () => {
    render(<AirspaceInfo stack={Array.from({ length: 9 }, (_, i) => a(`A${i}`))} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
  });
});
