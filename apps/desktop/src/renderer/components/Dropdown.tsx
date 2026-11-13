import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import "./Dropdown.css";

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** Set on a choice among several: marks the current one. */
  checked?: boolean;
}

interface DropdownProps {
  /** What the trigger button shows. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  /** Accessible name of the menu. */
  label: string;
  triggerClassName?: string;
  /** Which edge of the trigger the menu lines up with. Default left. */
  align?: "left" | "right";
  disabled?: boolean;
}

/** A button that opens a menu: arrow keys move, Enter picks, Esc and outside clicks close. */
export function Dropdown({
  trigger,
  items,
  label,
  triggerClassName,
  align = "left",
  disabled,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const first = Math.max(
      0,
      items.findIndex((i) => i.checked),
    );
    itemRefs.current[first]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, items]);

  const move = (from: number, step: number) => {
    const count = items.length;
    itemRefs.current[(from + step + count) % count]?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") move(at, 1);
    else if (e.key === "ArrowUp") move(Math.max(at, 0), -1);
    else if (e.key === "Home") itemRefs.current[0]?.focus();
    else if (e.key === "End") itemRefs.current[items.length - 1]?.focus();
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="dropdown no-drag" ref={root}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={menuId}
          className={`dropdown__menu dropdown__menu--${align}`}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKey}
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              className="dropdown__item"
              {...(item.checked === undefined
                ? { role: "menuitem" }
                : { role: "menuitemradio", "aria-checked": item.checked })}
              tabIndex={-1}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.checked ? <span className="dropdown__mark" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
