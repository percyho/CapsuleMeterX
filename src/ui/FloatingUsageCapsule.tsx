import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUsage } from "../hooks/useUsage";
import { usageColor, usagePaceColor } from "../utils/usage";
import { FastModeIndicator } from "./FastModeIndicator";

const TOOLTIP_HANDOFF_DELAY_MS = 800;
type Theme = "dark" | "light";

function readThemePreference(): Theme {
  try {
    return window.localStorage.getItem("capsulemeter-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function FloatingUsageCapsule() {
  const usage = useUsage();
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const [capsuleWidth, setCapsuleWidth] = useState(120);
  const capsuleRef = useRef<HTMLElement | null>(null);
  const requestedWidth = useRef<number | null>(null);
  const showTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("capsulemeter-theme", theme);
    } catch {
      // Keep the selected theme for this window even if storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const applyTheme = (value: string | null) => {
      if (value === "light" || value === "dark") setTheme(value);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === "capsulemeter-theme") applyTheme(event.newValue);
    };

    window.addEventListener("storage", onStorage);
    if (isTauri()) {
      void listen<string>("capsulemeter-theme-changed", (event) => {
        applyTheme(event.payload);
      }).then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      });
    }

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlisten?.();
    };
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
    },
    [],
  );

  useEffect(() => {
    const capsule = capsuleRef.current;
    if (!capsule) return;

    const observer = new ResizeObserver(() => {
      const width = Math.ceil(capsule.getBoundingClientRect().width);
      if (width <= 0) return;

      setCapsuleWidth((current) => current === width ? current : width);
      if (!isTauri() || requestedWidth.current === width) return;

      requestedWidth.current = width;
      void invoke("resize_capsule", { width }).catch((error) => {
        console.error("Could not resize CapsuleMeterX", error);
        requestedWidth.current = null;
      });
    });

    observer.observe(capsule);
    return () => observer.disconnect();
  }, []);

  const onMouseEnter = () => {
    if (!isTauri()) return;

    void invoke("keep_usage_tooltip");

    showTimer.current = window.setTimeout(() => {
      void invoke("show_usage_tooltip");
    }, 150);
  };

  const onMouseLeave = () => {
    window.clearTimeout(showTimer.current);
    if (!isTauri()) return;

    void invoke("hide_usage_tooltip", { delayMs: TOOLTIP_HANDOFF_DELAY_MS });
  };

  const onMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !isTauri()) return;

    void getCurrentWindow()
      .startDragging()
      .catch((error) => console.error("Could not drag CapsuleMeterX", error));
  };

  const offline = usage.status === "offline";
  const hasUsage = usage.fiveHour !== null || usage.weekly !== null;
  const fiveHourPaceColor = usage.status === "online"
    ? usagePaceColor(usage.fiveHour, now)
    : "var(--text-muted)";
  const weeklyPaceColor = usage.status === "online"
    ? usagePaceColor(usage.weekly, now)
    : "var(--text-muted)";

  return (
    <main
      ref={capsuleRef}
      className={`capsule${offline ? " capsule--offline" : ""}`}
      data-tauri-drag-region
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
      onMouseUp={() => {
        if (isTauri()) void invoke("finish_capsule_drag");
      }}
      aria-label="CapsuleMeterX usage"
    >
      <svg className="capsule__border" viewBox={`0 0 ${capsuleWidth} 32`} aria-hidden="true">
        <path
          d={`M${capsuleWidth / 2} 0.75H16C7.5786 0.75 0.75 7.5786 0.75 16s6.8286 15.25 15.25 15.25H${capsuleWidth / 2}`}
          style={{ stroke: fiveHourPaceColor }}
        />
        <path
          d={`M${capsuleWidth / 2} 0.75H${capsuleWidth - 16}c8.4214 0 15.25 6.8286 15.25 15.25S${capsuleWidth - 7.5786} 31.25 ${capsuleWidth - 16} 31.25H${capsuleWidth / 2}`}
          style={{ stroke: weeklyPaceColor }}
        />
      </svg>
      <FastModeIndicator enabled={usage.fastModeEnabled} />

      {offline ? (
        <span className="capsule__offline">Offline</span>
      ) : usage.status === "loading" ? (
        <span className="capsule__loading">-- · --</span>
      ) : !hasUsage ? (
        <span className="capsule__offline">Usage unavailable</span>
      ) : (
        <span className="capsule__metrics">
          <span className="capsule__label">5h</span>
          <span className="capsule__value" style={{ color: usageColor(usage.fiveHour?.remainingPercent ?? null) }}>
            {usage.fiveHour ? `${usage.fiveHour.remainingPercent}%` : "--"}
          </span>
          <span className="capsule__separator" aria-hidden="true">·</span>
          <span className="capsule__label capsule__week-label">W</span>
          <span className="capsule__value" style={{ color: usageColor(usage.weekly?.remainingPercent ?? null) }}>
            {usage.weekly ? `${usage.weekly.remainingPercent}%` : "--"}
          </span>
        </span>
      )}
    </main>
  );
}
