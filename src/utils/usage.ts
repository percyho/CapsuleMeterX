import type { UsageWindow } from "../types/usage";

export function usageColor(remaining: number | null): string {
  if (remaining === null) return "var(--text-muted)";
  if (remaining < 10) return "var(--usage-danger)";
  if (remaining < 30) return "var(--usage-warning)";
  return "var(--usage-green)";
}

export function usagePaceColor(window: UsageWindow | null, now: number): string {
  if (!window || window.resetsAt === null || window.windowDurationMins <= 0) {
    return "var(--text-muted)";
  }

  const durationSeconds = window.windowDurationMins * 60;
  const remainingSeconds = Math.max(0, window.resetsAt - now / 1000);
  const elapsedFraction = Math.max(
    0.05,
    Math.min(1, (durationSeconds - remainingSeconds) / durationSeconds),
  );
  const usedFraction = Math.max(0, Math.min(100, window.usedPercent)) / 100;
  const paceRatio = usedFraction / elapsedFraction;

  if (paceRatio >= 1.5) return "var(--usage-danger)";
  if (paceRatio >= 1.15) return "var(--usage-warning)";
  return "var(--usage-green)";
}

export function remainingLabel(window: UsageWindow | null): string {
  return window ? `${window.remainingPercent}%` : "--";
}

export function resetCountdown(window: UsageWindow | null, now: number): string {
  if (window?.resetsAt == null) return "--";

  const seconds = Math.max(0, Math.floor(window.resetsAt - now / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

export function weeklyResetCountdown(window: UsageWindow | null, now: number): string {
  if (window?.resetsAt == null) return "--";

  const seconds = Math.max(0, Math.floor(window.resetsAt - now / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

export function resetCardExpiryCountdown(expiresAt: number, now: number): {
  label: string;
  color: string;
} {
  const seconds = Math.floor(expiresAt - now / 1000);
  if (seconds <= 0) return { label: "已过期", color: "var(--usage-danger)" };

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const label = days > 0
    ? `${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`
    : hours > 0
      ? `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`
      : minutes > 0
        ? `${minutes} 分钟`
        : "少于 1 分钟";
  const color = seconds <= 86_400
    ? "var(--usage-danger)"
    : seconds <= 604_800
      ? "var(--usage-warning)"
      : "var(--usage-green)";

  return { label, color };
}

export function resetClockLabel(window: UsageWindow | null): string {
  if (window?.resetsAt == null) return "--:--";

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(window.resetsAt * 1000));
}

export function resetTimeLabel(window: UsageWindow | null, now: number): string {
  if (window?.resetsAt == null) return "--";

  const resetDate = new Date(window.resetsAt * 1000);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetDate);

  if (sameDay(resetDate, today)) return `今天 ${time}`;
  if (sameDay(resetDate, tomorrow)) return `明天 ${time}`;

  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetDate);
}

export function weeklyResetLabel(window: UsageWindow | null): string {
  if (window?.resetsAt == null) return "--";

  const resetDate = new Date(window.resetsAt * 1000);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
  }).format(resetDate);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetDate);

  return `${weekday} ${time}`;
}
