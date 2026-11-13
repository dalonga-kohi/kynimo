// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LABEL_WIDTH, Timeline } from "./Timeline.js";

afterEach(() => cleanup());

const layers = [
  { id: "a", name: "background", start: 0, end: 10, keyTimes: [] },
  { id: "b", name: "title", start: 2, end: 8, keyTimes: [2, 5] },
];

function mount(over: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onSeek = vi.fn();
  const onSelect = vi.fn();
  const { container } = render(
    <Timeline
      layers={layers}
      duration={10}
      time={2.5}
      selected={undefined}
      onSelect={onSelect}
      onSeek={onSeek}
      {...over}
    />,
  );
  const root = container.querySelector(".timeline") as HTMLElement;
  // 1000 px wide: a 128 px label column and an 872 px lane.
  root.getBoundingClientRect = () => ({ left: 100, width: 1000 }) as DOMRect;
  root.setPointerCapture = vi.fn();
  root.releasePointerCapture = vi.fn();
  root.hasPointerCapture = () => true;
  return { root, onSeek, onSelect };
}

const lanePx = (fraction: number) => 100 + LABEL_WIDTH + fraction * (1000 - LABEL_WIDTH);

describe("Timeline", () => {
  it("places bars and keys by percent of the duration", () => {
    mount();
    const bars = document.querySelectorAll<HTMLElement>(".row__bar");
    expect(bars[1]?.style.left).toBe("20%");
    expect(bars[1]?.style.width).toBe("60%");
    const keys = document.querySelectorAll<HTMLElement>(".row__key");
    expect(keys).toHaveLength(2);
    expect(keys[1]?.style.left).toBe("calc(50% - 3px)");
  });

  it("puts the playhead at the time", () => {
    mount({ time: 2.5 });
    // 128 px + 25 % of (100 % - 128 px), as jsdom reduces it.
    expect(screen.getByTestId("playhead").style.left).toBe("calc(25% + 96px)");
  });

  it("seeks on a click in the track area and while dragging, clamped to the animation", () => {
    const { root, onSeek } = mount();
    fireEvent.pointerDown(root, { clientX: lanePx(0.5), button: 0, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(5);
    fireEvent.pointerMove(root, { clientX: lanePx(0.9), pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(9, 5));
    fireEvent.pointerMove(root, { clientX: lanePx(1.5), pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(10);
    fireEvent.pointerMove(root, { clientX: 0, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.pointerUp(root, { pointerId: 1 });
    onSeek.mockClear();
    fireEvent.pointerMove(root, { clientX: lanePx(0.2), pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not seek from the name column", () => {
    const { root, onSeek } = mount();
    fireEvent.pointerDown(root, { clientX: 100 + 40, button: 0, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("selects a row by its name, and deselects it again", () => {
    const { onSelect } = mount();
    fireEvent.click(screen.getByRole("button", { name: "title" }));
    expect(onSelect).toHaveBeenCalledWith("b");
    cleanup();
    const again = mount({ selected: "b" });
    fireEvent.click(screen.getByRole("button", { name: "title" }));
    expect(again.onSelect).toHaveBeenCalledWith(undefined);
  });
});
