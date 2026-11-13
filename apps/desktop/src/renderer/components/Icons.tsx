import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** The Cut K. */
export const K_PATH =
  "M0 0H5V120H0Z M11 0H21V120H11Z M47 0H74L47 27Z M51 60L74 37V83Z M47 93L74 120H47Z M111 0H132V120H111L82 91V29Z";

export function Logo({ width = 18, height = 16, ...rest }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={width}
      height={height}
      viewBox="0 0 132 120"
      {...rest}
    >
      <path d={K_PATH} fill="currentColor" />
    </svg>
  );
}

export const MinimizeIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" {...p}>
    <path d="M0 5.5H10" fill="none" stroke="currentColor" />
  </svg>
);

export const MaximizeIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" {...p}>
    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
  </svg>
);

/** Two offset squares, same stroke as the maximize icon. */
export const RestoreIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" {...p}>
    <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" {...p}>
    <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" fill="none" stroke="currentColor" />
  </svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <path
      d="M3 8h10M8.5 3.5 13 8l-4.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <path
      d="M13 8H3M7.5 3.5 3 8l4.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <rect
      x="5.25"
      y="5.25"
      width="8"
      height="8"
      rx="1.75"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M10.75 3.25v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
);

export const CheckIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <path
      d="M3.5 8.5 6.5 11.5 12.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 12 12" {...p}>
    <path
      d="M3 4.5 6 7.5l3-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const FolderIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <path
      d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

export const PauseIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" {...p}>
    <path
      d="M4.5 3v8M9.5 3v8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

export const PlayIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" {...p}>
    <path
      d="M5 3.2v7.6L11 7z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const DownloadIcon = (p: IconProps) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" {...p}>
    <path
      d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
