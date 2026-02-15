import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionStatusIndicator } from "../ConnectionStatus";
import type { ConnectionStatus } from "@/lib/types";

describe("ConnectionStatusIndicator", () => {
  it("renders Connected with green badge", () => {
    const status: ConnectionStatus = { status: "Connected" };
    const { container } = render(
      <ConnectionStatusIndicator label="Socket" status={status} />
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
    const badge = container.querySelector(".bg-green-500");
    expect(badge).not.toBeNull();
  });

  it("renders Disconnected with gray badge", () => {
    const status: ConnectionStatus = { status: "Disconnected" };
    const { container } = render(
      <ConnectionStatusIndicator label="Socket" status={status} />
    );
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    const badge = container.querySelector(".bg-gray-500");
    expect(badge).not.toBeNull();
  });

  it("renders Connecting with yellow pulsing badge", () => {
    const status: ConnectionStatus = { status: "Connecting" };
    const { container } = render(
      <ConnectionStatusIndicator label="Socket" status={status} />
    );
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    const badge = container.querySelector(".bg-yellow-500.animate-pulse");
    expect(badge).not.toBeNull();
  });

  it("renders Error with message", () => {
    const status: ConnectionStatus = { status: "Error", message: "connection refused" };
    render(
      <ConnectionStatusIndicator label="Pulsar" status={status} />
    );
    expect(screen.getByText("Error: connection refused")).toBeInTheDocument();
  });

  it("renders the label", () => {
    const status: ConnectionStatus = { status: "Connected" };
    render(
      <ConnectionStatusIndicator label="Pulsar" status={status} />
    );
    expect(screen.getByText("Pulsar:")).toBeInTheDocument();
  });
});
