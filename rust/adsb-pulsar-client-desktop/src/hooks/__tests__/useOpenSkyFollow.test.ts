import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOpenSkyFollow } from "../useOpenSkyFollow";

describe("useOpenSkyFollow", () => {
  it("follows and stops following an aircraft by its hex, whatever the key it is asked by", () => {
    const { result } = renderHook(() => useOpenSkyFollow(["3C6444", "39DE4F"]));
    expect(result.current.followed).toEqual([]);
    act(() => result.current.toggle("osky:3c6444"));
    expect(result.current.followed).toEqual(["3C6444"]);
    expect(result.current.isFollowed("3C6444")).toBe(true);
    act(() => result.current.toggle("3C6444"));
    expect(result.current.followed).toEqual([]);
  });

  it("forgets an aircraft that is no longer known anywhere", () => {
    const { result, rerender } = renderHook(({ known }) => useOpenSkyFollow(known), {
      initialProps: { known: ["3C6444"] },
    });
    act(() => result.current.toggle("3C6444"));
    rerender({ known: [] });
    expect(result.current.followed).toEqual([]);
  });
});
