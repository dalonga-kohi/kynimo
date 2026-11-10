/** The Kynimo K, as drawn in the design mockups. One colour, inherited from the text. */
export const MARK_PATH =
  "M0 0H5V120H0Z M11 0H21V120H11Z M47 0H74L47 27Z M51 60L74 37V83Z M47 93L74 120H47Z M111 0H132V120H111L82 91V29Z";

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 132 120" fill="currentColor" aria-hidden="true">
      <path d={MARK_PATH} />
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}
