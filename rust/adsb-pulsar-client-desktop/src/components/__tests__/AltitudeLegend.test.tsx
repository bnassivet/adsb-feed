import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AltitudeLegend } from "../AltitudeLegend";

describe("AltitudeLegend", () => {
  it("renders altitude labels", () => {
    render(<AltitudeLegend />);
    expect(screen.getByText("50k")).toBeInTheDocument();
    expect(screen.getByText("25k")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders ft unit label", () => {
    render(<AltitudeLegend />);
    expect(screen.getByText("ft")).toBeInTheDocument();
  });
});
