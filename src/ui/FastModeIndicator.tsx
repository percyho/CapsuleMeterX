interface FastModeIndicatorProps {
  enabled: boolean | null;
}

export function FastModeIndicator({ enabled }: FastModeIndicatorProps) {
  const label = enabled === null
    ? "Fast mode status unavailable"
    : enabled
      ? "Fast mode enabled"
      : "Fast mode disabled";

  return (
    <svg
      className={`fast-mode-indicator${enabled === true ? " fast-mode-indicator--enabled" : ""}`}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      <path d="M9.35 0.85 3.1 8.45h3.72l-.3 6.7 6.38-8.63H9.05l.3-5.67Z" />
      <title>{label}</title>
    </svg>
  );
}
