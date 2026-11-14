import type { KeyboardEvent } from "react";
import "./Segmented.css";

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** `nav` is the app's page switch (a navigation landmark); `tabs` switches a panel. */
  kind: "nav" | "tabs";
  /** `md`: 32 px items in a 3 px frame (app bar); `lg`: 36 px in 4 px (panels). */
  size?: "md" | "lg";
}

/** The pill with a raised current item, as in the app bar and the client picker. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  kind,
  size = "md",
}: SegmentedProps<T>) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (kind !== "tabs" || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    const at = items.findIndex((i) => i.value === value);
    const to = (at + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    const next = items[to];
    if (next === undefined) return;
    e.preventDefault();
    onChange(next.value);
    // The newly current tab takes focus with it.
    (e.currentTarget.querySelectorAll('[role="tab"]')[to] as HTMLElement | undefined)?.focus();
  };
  const buttons = items.map((item) => {
    const current = item.value === value;
    return (
      <button
        key={item.value}
        type="button"
        className="segmented__item"
        data-current={current}
        onClick={() => onChange(item.value)}
        {...(kind === "tabs"
          ? { role: "tab", "aria-selected": current, tabIndex: current ? 0 : -1 }
          : { "aria-current": current ? ("page" as const) : undefined })}
      >
        {item.label}
      </button>
    );
  });

  return kind === "nav" ? (
    <nav className={`segmented segmented--${size} no-drag`} aria-label={label}>
      {buttons}
    </nav>
  ) : (
    <div
      className={`segmented segmented--${size} no-drag`}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {buttons}
    </div>
  );
}
