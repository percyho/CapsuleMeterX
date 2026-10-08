import { useEffect, useRef, useState } from "react";

interface FastModeIndicatorProps {
  enabled: boolean | null;
}

export function FastModeIndicator({ enabled }: FastModeIndicatorProps) {
  const wasDisabled = useRef(enabled === false);
  const [activation, setActivation] = useState(0);

  useEffect(() => {
    if (enabled === true && wasDisabled.current) {
      setActivation((current) => current + 1);
    }
    wasDisabled.current = enabled === false;
  }, [enabled]);

  const label = enabled === null
    ? "Fast mode status unavailable"
    : enabled
      ? "Fast mode enabled"
      : "Fast mode disabled";

  return (
    <svg
      key={activation}
      className={`fast-mode-indicator${enabled === true ? " fast-mode-indicator--enabled" : ""}${activation > 0 ? " fast-mode-indicator--activated" : ""}`}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      onAnimationEnd={() => {
        if (activation > 0) setActivation(0);
      }}
    >
      <path d="M9.35 0.85 3.1 8.45h3.72l-.3 6.7 6.38-8.63H9.05l.3-5.67Z" />
      <title>{label}</title>
    </svg>
  );
}
