import "./Button.css";

/** The small mono label over a picture: an accent dot and a line of text. */
export function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={`pill${className === undefined ? "" : ` ${className}`}`}>
      <span className="pill__dot" />
      <span>{children}</span>
    </span>
  );
}
