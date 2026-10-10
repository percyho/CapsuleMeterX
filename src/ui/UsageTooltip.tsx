import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { useUsage } from "../hooks/useUsage";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../types/appSettings";
import type { ResetCardExpiry, UsageWindow } from "../types/usage";
import {
  remainingLabel,
  resetCountdown,
  resetCardExpiryCountdown,
  resetClockLabel,
  usageColor,
  usagePaceColor,
  usagePaceState,
  weeklyResetLabel,
} from "../utils/usage";
import type { UsagePaceState } from "../utils/usage";

type ResetDialogState = "confirm" | "loading" | "success" | "error";
type Language = "zh" | "en";
type Theme = "dark" | "light";

const TEXT = {
  zh: {
    usageDetails: "用量详情",
    usagePreview: "CapsuleMeterX 用量预览",
    switchToEnglish: "切换到 English",
    switchToChinese: "切换到简体中文",
    switchToLight: "切换到明亮主题",
    switchToDark: "切换到暗黑主题",
    statistics: "打开统计",
    settings: "设置",
    startupSettings: "偏好设置",
    settingsDescription: "调整胶囊外观、用量刷新和提醒。",
    startWithWindows: "登录 Windows 时启动",
    startWithWindowsHint: "登录 Windows 后自动显示胶囊。",
    capsuleSection: "胶囊",
    capsuleAlwaysOnTop: "窗口置顶",
    capsuleAlwaysOnTopHint: "让胶囊显示在其他窗口上方。",
    capsuleOpacity: "胶囊透明度",
    capsuleOpacityHint: "拖动滑块调整胶囊及文字的透明度。",
    refreshSection: "刷新",
    refreshInterval: "用量刷新间隔",
    refreshIntervalHint: "从 Codex App Server 定时读取用量。",
    minutes: "分钟",
    alertsSection: "提醒",
    lowBalanceAlert: "余额偏低时提醒",
    lowBalanceAlertHint: "5 小时或本周剩余量低于阈值时发送系统通知。",
    lowBalanceThreshold: "低余额阈值",
    usagePaceAlert: "消耗速度过快时提醒",
    usagePaceAlertHint: "达到所选消耗速度时发送系统通知。",
    usagePaceThreshold: "提醒速度",
    paceThresholdFast: "偏快（≥1.15×）",
    paceThresholdVeryFast: "过快（≥1.5×）",
    notificationPermissionDenied: "未获得系统通知权限，提醒设置未启用。",
    settingsLoading: "正在读取设置…",
    settingsLoadError: "无法读取设置：",
    settingsSaveError: "无法保存设置：",
    offline: "无法获取 Codex 用量数据",
    fiveHour: "5 小时剩余",
    weekly: "本周剩余",
    paceNormal: "消耗速度正常",
    paceFast: "消耗速度偏快",
    paceVeryFast: "消耗速度过快",
    paceUnknown: "消耗速度未知",
    nextReset: "下次重置",
    resetCards: "剩余重置卡",
    cardCountUnit: "张",
    cardExpiry: "离有效时间还剩",
    reset: "重置",
    noConnection: "连接 Codex 后才能使用重置卡",
    expiredCard: "这张重置卡已过期",
    unavailableCard: "缺少可验证的重置卡标识，暂不能安全使用",
    noCards: "暂无可用重置卡",
    loadingCards: "正在读取重置卡信息…",
    unavailableCardDetails: "暂时无法读取卡片详情，无法安全地指定卡片。",
    otherCardsUnavailable: "其余卡片详情暂不可用",
    previewFiveHour: "5h",
    previewWeekly: "本周",
    previewDetails: "点击查看详情",
    confirmTitle: "确认使用重置卡？",
    loadingTitle: "正在使用重置卡…",
    successTitle: "重置成功",
    errorTitle: "重置失败",
    confirmMessage: "确定使用这张重置卡吗？此操作可能无法撤销。",
    loadingMessage: "请稍候，正在等待 Codex 确认重置结果。",
    successMessage: "Codex 已确认重置完成，正在刷新用量。",
    cardRemaining: "重置卡有效期还剩",
    close: "关闭",
    done: "确定",
    cancel: "取消",
    retry: "重试",
    confirmReset: "确认重置",
    usingCard: "正在使用重置卡…",
    nothingToReset: "当前用量无需重置，这张卡仍未使用。",
    noCredit: "账户中没有可用的重置卡。",
    unconfirmedOutcome: "Codex 返回了未确认的结果：",
    invalidCard: "重置卡信息无效，请刷新用量后重试。",
    cardInProgress: "这张重置卡正在处理中，请稍候。",
    serverNotReady: "Codex App Server 尚未就绪，请稍后重试。",
    resetTimedOut: "等待 Codex 确认重置结果超时。请稍后刷新用量，再决定是否重试。",
    serverDisconnected: "Codex App Server 连接已断开，重置结果未能确认。请刷新用量后再试。",
    permanent: "永久有效",
    expiryUnknown: "有效期未知",
    unknown: "未知",
    expired: "已过期",
    underOneMinute: "少于 1 分钟",
  },
  en: {
    usageDetails: "Usage details",
    usagePreview: "CapsuleMeterX usage preview",
    switchToEnglish: "Switch to English",
    switchToChinese: "Switch to Chinese",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    statistics: "Open statistics",
    settings: "Settings",
    startupSettings: "Preferences",
    settingsDescription: "Adjust the capsule, refresh interval, and alerts.",
    startWithWindows: "Start when I sign in to Windows",
    startWithWindowsHint: "Show the capsule after you sign in.",
    capsuleSection: "Capsule",
    capsuleAlwaysOnTop: "Keep on top",
    capsuleAlwaysOnTopHint: "Keep the capsule above other windows.",
    capsuleOpacity: "Capsule opacity",
    capsuleOpacityHint: "Adjust the opacity of the capsule and its text.",
    refreshSection: "Refresh",
    refreshInterval: "Usage refresh interval",
    refreshIntervalHint: "Read usage from Codex App Server on a schedule.",
    minutes: "minutes",
    alertsSection: "Alerts",
    lowBalanceAlert: "Low balance alert",
    lowBalanceAlertHint: "Notify when 5-hour or weekly usage falls below the threshold.",
    lowBalanceThreshold: "Low balance threshold",
    usagePaceAlert: "Fast usage alert",
    usagePaceAlertHint: "Notify when the usage pace reaches the selected level.",
    usagePaceThreshold: "Alert pace",
    paceThresholdFast: "Fast (≥1.15×)",
    paceThresholdVeryFast: "Very fast (≥1.5×)",
    notificationPermissionDenied: "Notification permission was not granted; the alert was not enabled.",
    settingsLoading: "Loading settings…",
    settingsLoadError: "Could not load settings: ",
    settingsSaveError: "Could not save settings: ",
    offline: "Unable to retrieve Codex usage data",
    fiveHour: "5-hour remaining",
    weekly: "Weekly remaining",
    paceNormal: "Usage pace: normal",
    paceFast: "Usage pace: fast",
    paceVeryFast: "Usage pace: very fast",
    paceUnknown: "Usage pace unknown",
    nextReset: "Next reset",
    resetCards: "Available reset cards",
    cardCountUnit: "cards",
    cardExpiry: "Expires in",
    reset: "Reset",
    noConnection: "Connect to Codex to use reset cards",
    expiredCard: "This reset card has expired",
    unavailableCard: "A verifiable reset-card ID is unavailable",
    noCards: "No reset cards available",
    loadingCards: "Loading reset-card information…",
    unavailableCardDetails: "Card details are unavailable, so no card can be selected safely.",
    otherCardsUnavailable: "Details for some cards are unavailable",
    previewFiveHour: "5h",
    previewWeekly: "Week",
    previewDetails: "View details",
    confirmTitle: "Use this reset card?",
    loadingTitle: "Using reset card…",
    successTitle: "Reset successful",
    errorTitle: "Reset failed",
    confirmMessage: "Are you sure you want to use this reset card? This action may not be reversible.",
    loadingMessage: "Please wait while Codex confirms the reset.",
    successMessage: "Codex confirmed the reset. Usage is being refreshed.",
    cardRemaining: "Card expires in",
    close: "Close",
    done: "Done",
    cancel: "Cancel",
    retry: "Retry",
    confirmReset: "Confirm reset",
    usingCard: "Using reset card…",
    nothingToReset: "There is no usage to reset. This card was not used.",
    noCredit: "There are no available reset cards on this account.",
    unconfirmedOutcome: "Codex returned an unconfirmed result: ",
    invalidCard: "Reset-card details are invalid. Refresh usage and try again.",
    cardInProgress: "This reset card is already being processed. Please wait.",
    serverNotReady: "Codex App Server is not ready. Please try again later.",
    resetTimedOut: "Timed out waiting for Codex to confirm the reset. Refresh usage before retrying.",
    serverDisconnected: "Codex App Server disconnected before confirming the reset. Refresh usage and try again.",
    permanent: "Never expires",
    expiryUnknown: "Expiry unknown",
    unknown: "Unknown",
    expired: "Expired",
    underOneMinute: "Less than 1 minute",
  },
} as const;

function storedPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localizeResetError(error: string, language: Language): string {
  if (language === "zh") return error;
  const knownErrors: Record<string, string> = {
    [TEXT.zh.invalidCard]: TEXT.en.invalidCard,
    [TEXT.zh.cardInProgress]: TEXT.en.cardInProgress,
    [TEXT.zh.serverNotReady]: TEXT.en.serverNotReady,
    [TEXT.zh.resetTimedOut]: TEXT.en.resetTimedOut,
    [TEXT.zh.serverDisconnected]: TEXT.en.serverDisconnected,
  };
  return knownErrors[error] ?? error;
}

function usagePaceLabel(state: UsagePaceState, language: Language): string {
  const text = TEXT[language];
  switch (state) {
    case "normal": return text.paceNormal;
    case "fast": return text.paceFast;
    case "very-fast": return text.paceVeryFast;
    default: return text.paceUnknown;
  }
}

function UsageRing({ window, label }: { window: UsageWindow | null; label: string }) {
  const remaining = window?.remainingPercent ?? null;
  const previousRemaining = useRef<number | null>(null);
  const [hasReceivedUpdate, setHasReceivedUpdate] = useState(false);
  const radius = 23;
  const circumference = 2 * Math.PI * radius;
  const progress = remaining === null ? 0 : Math.max(0, Math.min(100, remaining));

  useEffect(() => {
    if (remaining === null) return;

    if (previousRemaining.current === null) setHasReceivedUpdate(true);
    previousRemaining.current = remaining;
  }, [remaining]);

  return (
    <svg
      className="usage-ring"
      viewBox="0 0 54 54"
      role="img"
      aria-label={`${label} ${remainingLabel(window)}`}
    >
      <circle className="usage-ring__track" cx="27" cy="27" r={radius} />
      <circle
        className={`usage-ring__progress${hasReceivedUpdate ? " usage-ring__progress--animated" : ""}`}
        cx="27"
        cy="27"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress / 100)}
        style={{ stroke: usageColor(remaining) }}
      />
      <text
        className="usage-ring__label"
        x="27"
        y="27"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: usageColor(remaining) }}
      >
        {remaining === null ? "--" : `${remaining}%`}
      </text>
    </svg>
  );
}

function ResetCardIcon() {
  return (
    <svg className="reset-card__reset-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.5 4h15A2 2 0 0 1 21.5 6v3.2a2.8 2.8 0 0 0 0 5.6V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-3.2a2.8 2.8 0 0 0 0-5.6V6a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 12h6" stroke="var(--usage-accent)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function LanguagesIcon() {
  return (
    <svg className="usage-tooltip__toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 5h9M8 3v2m4.5 0c0 4.2-3 7.6-7.5 9.4M5.5 8c1.3 2.8 3.8 5.1 6.4 6.4M13.5 20l4-10 4 10m-6.5-3h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatisticsIcon() {
  return (
    <svg className="usage-tooltip__toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 3v18h18M8 17v-3m5 3V5m5 12V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Settings2Icon() {
  return (
    <svg className="usage-tooltip__toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 7h-9M14 17H5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="17" cy="7" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="7" cy="17" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="usage-tooltip__toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 2.5v2m0 15v2m9.5-9.5h-2m-15 0h-2m16.22-6.72-1.42 1.42M6.7 17.3l-1.42 1.42m13.44 0-1.42-1.42M6.7 6.7 5.28 5.28" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="usage-tooltip__toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20.4 15.2A8.6 8.6 0 0 1 8.8 3.6 8.8 8.8 0 1 0 20.4 15.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoaderCircleIcon({ button = false }: { button?: boolean }) {
  return (
    <svg
      className={`reset-dialog__loader${button ? " reset-dialog__loader--button" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2a10 10 0 1 0 10 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckCircle2Icon() {
  return (
    <svg className="reset-dialog__status-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 12.2 2.6 2.6 5.6-5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg className="reset-dialog__status-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v4.5m0 3.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="reset-dialog__close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function expiryLabel(card: ResetCardExpiry, now: number, language: Language) {
  const text = TEXT[language];
  if (card.expiresAt === null) {
    return card.expiryDetailsAvailable ? text.permanent : text.expiryUnknown;
  }
  return resetCardExpiryCountdown(card.expiresAt, now, language);
}

function expiryDaysLabel(card: ResetCardExpiry, now: number, language: Language) {
  const text = TEXT[language];
  if (card.expiresAt === null) {
    return card.expiryDetailsAvailable ? text.permanent : text.unknown;
  }
  const seconds = Math.floor(card.expiresAt - now / 1000);
  if (seconds <= 0) return text.expired;
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return language === "zh" ? `${days} 天` : `${days} days`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return language === "zh" ? `${hours} 小时` : `${hours} hours`;
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return language === "zh" ? `${minutes} 分钟` : `${minutes} minutes`;
  return text.underOneMinute;
}

export function UsageTooltipWindow() {
  const usage = useUsage();
  const [now, setNow] = useState(Date.now());
  const [language, setLanguage] = useState<Language>(() =>
    storedPreference("capsulemeter-language") === "en" ? "en" : "zh",
  );
  const [theme, setTheme] = useState<Theme>(() =>
    storedPreference("capsulemeter-theme") === "light" ? "light" : "dark",
  );
  const [viewMode, setViewMode] = useState<"details" | "tray-preview">("details");
  const [selectedCard, setSelectedCard] = useState<ResetCardExpiry | null>(null);
  const [dialogState, setDialogState] = useState<ResetDialogState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [resetError, setResetError] = useState("");
  const [consumedCardIds, setConsumedCardIds] = useState<string[]>([]);
  const idempotencyKeys = useRef(new Map<string, string>());
  const tooltipRef = useRef<HTMLElement>(null);
  const themeTransitioning = useRef(false);
  const themeLeaveCheckTimer = useRef<number | undefined>(undefined);
  const themeGuardReleaseTimer = useRef<number | undefined>(undefined);
  const themeFallbackTimer = useRef<number | undefined>(undefined);
  const text = TEXT[language];
  const fiveHourPaceWindow = usage.status === "online" ? usage.fiveHour : null;
  const weeklyPaceWindow = usage.status === "online" ? usage.weekly : null;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem("capsulemeter-language", language);
      window.localStorage.setItem("capsulemeter-theme", theme);
    } catch {
      // Preferences still apply for the current window when storage is unavailable.
    }
  }, [language, theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>("usage-tooltip-mode", (event) => {
      setViewMode(event.payload === "tray-preview" ? "tray-preview" : "details");
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const resizeTooltip = () => {
      const stagePadding = viewMode === "tray-preview" ? 18 : 8;
      const stageWidth = tooltip.parentElement?.getBoundingClientRect().width
        ?? tooltip.getBoundingClientRect().width + 8;
      const width = Math.ceil(stageWidth);
      const height = Math.ceil(tooltip.getBoundingClientRect().height + stagePadding);
      void invoke("resize_usage_tooltip", { width, height }).catch((error) => {
        console.error("Could not resize usage tooltip", error);
      });
    };

    const observer = new ResizeObserver(resizeTooltip);
    observer.observe(tooltip);
    resizeTooltip();
    return () => observer.disconnect();
  }, [viewMode, dialogState, settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (event.key === "Escape" && dialogState !== "loading") {
        setDialogState(null);
        setSelectedCard(null);
        setResetError("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogState, settingsOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(themeLeaveCheckTimer.current);
    window.clearTimeout(themeGuardReleaseTimer.current);
    window.clearTimeout(themeFallbackTimer.current);
    delete document.documentElement.dataset.themeTransitionFallback;
  }, []);

  useEffect(() => {
    const listedIds = new Set(usage.resetCards.flatMap((card) => card.id ? [card.id] : []));
    setConsumedCardIds((current) => current.filter((id) => listedIds.has(id)));
  }, [usage.resetCards]);

  const consumedStillListed = consumedCardIds.filter((id) =>
    usage.resetCards.some((card) => card.id === id),
  );
  const visibleCards = usage.resetCards.filter((card) =>
    !card.id || !consumedCardIds.includes(card.id),
  );
  const resetCardCount = usage.resetCardsAvailable === null
    ? null
    : Math.max(0, usage.resetCardsAvailable - consumedStillListed.length);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    const applyTheme = () => flushSync(() => setTheme(nextTheme));
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.clearTimeout(themeFallbackTimer.current);
    delete root.dataset.themeTransitionFallback;
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      if (
        effect instanceof KeyframeEffect &&
        (effect.pseudoElement === "::view-transition-old(root)" ||
          effect.pseudoElement === "::view-transition-new(root)")
      ) {
        animation.cancel();
      }
    }
    root.dataset.themeTransitionTarget = nextTheme;
    const protectTooltip = () => {
      themeTransitioning.current = true;
      window.clearTimeout(themeGuardReleaseTimer.current);
      themeGuardReleaseTimer.current = window.setTimeout(() => {
        themeTransitioning.current = false;
      }, 80);
    };

    if (isTauri()) {
      void invoke("keep_usage_tooltip");
      void emit("capsulemeter-theme-changed", nextTheme).catch((error) => {
        console.error("Could not sync CapsuleMeterX theme", error);
      });
    }
    themeTransitioning.current = true;
    window.clearTimeout(themeLeaveCheckTimer.current);
    window.clearTimeout(themeGuardReleaseTimer.current);

    if (
      !reducedMotion &&
      typeof document.startViewTransition === "function"
    ) {
      try {
        const transition = document.startViewTransition(applyTheme);
        void transition.finished.then(protectTooltip, protectTooltip);
        return;
      } catch {
        // Fall back to an immediate theme change if a transition is already running.
      }
    }
    applyTheme();
    if (reducedMotion) {
      themeGuardReleaseTimer.current = window.setTimeout(() => {
        themeTransitioning.current = false;
      }, 180);
      return;
    }

    root.dataset.themeTransitionFallback = nextTheme;
    themeFallbackTimer.current = window.setTimeout(() => {
      delete root.dataset.themeTransitionFallback;
      protectTooltip();
    }, 500);
  };

  const openResetDialog = (card: ResetCardExpiry) => {
    setSelectedCard(card);
    setDialogState("confirm");
    setResetError("");
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const loaded = await invoke<AppSettings>("get_startup_settings");
      setAppSettings(loaded);
    } catch (error) {
      setSettingsError(`${text.settingsLoadError}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSettingsLoading(false);
    }
  };

  const updateAppSetting = async <Key extends keyof AppSettings,>(
    key: Key,
    value: AppSettings[Key],
  ) => {
    if (settingsSaving) return;
    const enablingAlert = value === true &&
      (key === "lowBalanceAlertEnabled" || key === "usagePaceAlertEnabled");
    if (enablingAlert) {
      try {
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) permissionGranted = (await requestPermission()) === "granted";
        if (!permissionGranted) {
          setSettingsError(text.notificationPermissionDenied);
          return;
        }
      } catch (error) {
        setSettingsError(`${text.settingsSaveError}${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const previous = appSettings;
    const next = { ...previous, [key]: value };
    setAppSettings(next);
    setSettingsSaving(true);
    setSettingsError("");
    try {
      const saved = await invoke<AppSettings>("set_startup_settings", { settings: next });
      setAppSettings(saved);
    } catch (error) {
      setAppSettings(previous);
      setSettingsError(`${text.settingsSaveError}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSettingsSaving(false);
    }
  };

  const previewCapsuleOpacity = (opacity: number) => {
    setAppSettings((current) => ({ ...current, capsuleOpacityPercent: opacity }));
  };

  const closeResetDialog = () => {
    if (dialogState === "loading") return;
    setDialogState(null);
    setSelectedCard(null);
    setResetError("");
  };

  const confirmReset = async () => {
    if (!selectedCard?.id || dialogState === "loading") return;

    const creditId = selectedCard.id;
    let idempotencyKey = idempotencyKeys.current.get(creditId);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      idempotencyKeys.current.set(creditId, idempotencyKey);
    }

    setDialogState("loading");
    setResetError("");
    try {
      const outcome = await invoke<string>("consume_reset_card", {
        creditId,
        idempotencyKey,
      });
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        idempotencyKeys.current.delete(creditId);
        setConsumedCardIds((current) => current.includes(creditId) ? current : [...current, creditId]);
        setDialogState("success");
        return;
      }

      idempotencyKeys.current.delete(creditId);
      setResetError(outcome === "nothingToReset"
        ? text.nothingToReset
        : outcome === "noCredit"
          ? text.noCredit
          : `${text.unconfirmedOutcome}${outcome}`);
      setDialogState("error");
    } catch (error) {
      setResetError(error instanceof Error ? error.message : String(error));
      setDialogState("error");
    }
  };

  return (
    <main
      className={`tooltip-stage${viewMode === "tray-preview" ? " tooltip-stage--tray-preview" : ""}`}
      onMouseEnter={() => {
        if (isTauri()) void invoke("keep_usage_tooltip");
      }}
      onMouseLeave={() => {
        if (!isTauri()) return;
        if (themeTransitioning.current) {
          window.clearTimeout(themeLeaveCheckTimer.current);
          themeLeaveCheckTimer.current = window.setTimeout(() => {
            if (!tooltipRef.current?.matches(":hover")) {
              void invoke("hide_usage_tooltip", { delayMs: 100 });
            }
          }, 560);
          return;
        }
        void invoke("hide_usage_tooltip", { delayMs: 100 });
      }}
    >
      <section
        className={`usage-tooltip${viewMode === "tray-preview" ? " usage-tooltip--tray-preview" : ""}${dialogState ? " usage-tooltip--dialog-open" : ""}${settingsOpen ? " usage-tooltip--settings-open" : ""}`}
        aria-label={viewMode === "tray-preview" ? text.usagePreview : text.usageDetails}
        ref={tooltipRef}
      >
        <header className="usage-tooltip__header">
          <h1 className="usage-tooltip__title">
            {viewMode === "tray-preview" ? "CapsuleMeterX" : usage.planName || "ChatGPT"}
          </h1>
          <div className="usage-tooltip__toolbar">
            <button
              className="usage-tooltip__toolbar-button"
              type="button"
              aria-label={text.statistics}
              title={text.statistics}
              onClick={() => {
                if (isTauri()) void invoke("show_statistics_window");
              }}
            >
              <StatisticsIcon />
            </button>
            <button
              className="usage-tooltip__toolbar-button"
              type="button"
              aria-label={language === "zh" ? text.switchToEnglish : text.switchToChinese}
              title={language === "zh" ? text.switchToEnglish : text.switchToChinese}
              onClick={() => setLanguage((current) => current === "zh" ? "en" : "zh")}
            >
              <LanguagesIcon />
            </button>
            <button
              className="usage-tooltip__toolbar-button"
              type="button"
              aria-label={theme === "dark" ? text.switchToLight : text.switchToDark}
              title={theme === "dark" ? text.switchToLight : text.switchToDark}
              onClick={toggleTheme}
            >
              <span
                className={`usage-tooltip__theme-icon-stack${theme === "light" ? " usage-tooltip__theme-icon-stack--light" : ""}`}
                aria-hidden="true"
              >
                <span className="usage-tooltip__theme-icon usage-tooltip__theme-icon--sun"><SunIcon /></span>
                <span className="usage-tooltip__theme-icon usage-tooltip__theme-icon--moon"><MoonIcon /></span>
              </span>
            </button>
            <button
              className="usage-tooltip__toolbar-button"
              type="button"
              aria-label={text.settings}
              title={text.settings}
              onClick={() => void openSettings()}
            >
              <Settings2Icon />
            </button>
          </div>
        </header>
        {viewMode === "tray-preview" ? (
          <>
            <div className="tray-preview__usage">
              <span className="tray-preview__metric">
                <span>{text.previewFiveHour}</span>
                <strong>{remainingLabel(usage.fiveHour)}</strong>
              </span>
              <span className="tray-preview__separator" aria-hidden="true">·</span>
              <span className="tray-preview__metric">
                <span>{text.previewWeekly}</span>
                <strong>{remainingLabel(usage.weekly)}</strong>
              </span>
            </div>
            {usage.status === "offline" && (
              <p className="tray-preview__offline">
                {usage.connectionError ? `${text.offline}: ${usage.connectionError}` : text.offline}
              </p>
            )}
            <button
              className="tray-preview__details-button"
              type="button"
              onClick={() => {
                if (isTauri()) void invoke("show_tray_usage_details");
              }}
            >
              {text.previewDetails} <span aria-hidden="true">→</span>
            </button>
          </>
        ) : (
          <>
            {usage.status === "offline" && (
              <p className="usage-tooltip__offline">
                {usage.connectionError ? `${text.offline}: ${usage.connectionError}` : text.offline}
              </p>
            )}

            <div className="usage-tooltip__periods">
              <div className="usage-window">
                <UsageRing window={usage.fiveHour} label={text.fiveHour} />
                <div className="usage-window__summary">
                  <strong>{text.fiveHour}</strong>
                  <span style={{ color: usagePaceColor(fiveHourPaceWindow, now) }}>
                    {usagePaceLabel(usagePaceState(fiveHourPaceWindow, now), language)}
                  </span>
                  <span>{text.nextReset}</span>
                </div>
                <span className="usage-window__time">
                  {resetCountdown(usage.fiveHour, now)} · {resetClockLabel(usage.fiveHour)}
                </span>
              </div>
              <div className="usage-window">
                <UsageRing window={usage.weekly} label={text.weekly} />
                <div className="usage-window__summary">
                  <strong>{text.weekly}</strong>
                  <span style={{ color: usagePaceColor(weeklyPaceWindow, now) }}>
                    {usagePaceLabel(usagePaceState(weeklyPaceWindow, now), language)}
                  </span>
                  <span>{text.nextReset}</span>
                </div>
                <span className="usage-window__time">
                  {weeklyResetLabel(usage.weekly, language)}
                </span>
              </div>
            </div>

            <div className="reset-cards">
              <div className="reset-cards__heading">
                <h2>{text.resetCards}</h2>
                <span>
                  {resetCardCount === null
                    ? "--"
                    : language === "zh"
                      ? `${resetCardCount} ${text.cardCountUnit}`
                      : `${resetCardCount} ${resetCardCount === 1 ? "card" : text.cardCountUnit}`}
                </span>
              </div>

              {visibleCards.map((card, index) => {
                const expiry = expiryLabel(card, now, language);
                const expiryText = typeof expiry === "string" ? expiry : expiry.label;
                const expiryColor = typeof expiry === "string" ? "var(--text-weak)" : expiry.color;
                const expired = card.expiresAt !== null && card.expiresAt <= now / 1000;
                const canRedeem = Boolean(
                  card.id &&
                  card.status === "available" &&
                  card.resetType === "codexRateLimits" &&
                  usage.status === "online" &&
                  !expired,
                );
                const disabledReason = usage.status !== "online"
                  ? text.noConnection
                  : expired
                    ? text.expiredCard
                    : !card.id || card.resetType !== "codexRateLimits"
                      ? text.unavailableCard
                      : undefined;

                return (
                  <article
                    className={`reset-card reset-card--${index % 2 === 0 ? "blue" : "violet"}${canRedeem ? "" : " reset-card--disabled"}`}
                    key={card.id ?? `reset-card-${index}`}
                  >
                    <div className="reset-card__icon"><ResetCardIcon /></div>
                    <div className="reset-card__expiry">
                      <span>{text.cardExpiry}</span>
                      <strong style={{ color: expiryColor }}>{expiryText}</strong>
                    </div>
                    <button
                      className="reset-card__action"
                      type="button"
                      disabled={!canRedeem || dialogState === "loading"}
                      title={disabledReason}
                      onClick={() => openResetDialog(card)}
                    >
                      {text.reset}
                    </button>
                  </article>
                );
              })}

              {visibleCards.length === 0 && (
                <p className="reset-cards__empty">
                  {resetCardCount === 0
                    ? text.noCards
                    : resetCardCount === null
                      ? text.loadingCards
                      : text.unavailableCardDetails}
                </p>
              )}
              {resetCardCount !== null && resetCardCount > visibleCards.length && (
                <p className="reset-cards__note">{text.otherCardsUnavailable}</p>
              )}
            </div>
          </>
        )}

        {viewMode === "details" && dialogState && selectedCard && (
          <div
            className="reset-dialog-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeResetDialog();
            }}
          >
            <section className="reset-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-dialog-title">
              {dialogState !== "loading" && (
                <button className="reset-dialog__close" type="button" aria-label={text.close} onClick={closeResetDialog}>
                  <CloseIcon />
                </button>
              )}
              <div className={`reset-dialog__symbol reset-dialog__symbol--${dialogState}`}>
                {dialogState === "loading" ? (
                  <LoaderCircleIcon />
                ) : dialogState === "success" ? (
                  <CheckCircle2Icon />
                ) : dialogState === "error" ? (
                  <AlertCircleIcon />
                ) : (
                  <ResetCardIcon />
                )}
              </div>
              <h2 id="reset-dialog-title">
                {dialogState === "confirm"
                  ? text.confirmTitle
                  : dialogState === "loading"
                    ? text.loadingTitle
                    : dialogState === "success"
                      ? text.successTitle
                      : text.errorTitle}
              </h2>
              <p className="reset-dialog__message" role={dialogState === "error" ? "alert" : undefined}>
                {dialogState === "confirm"
                  ? text.confirmMessage
                  : dialogState === "loading"
                    ? text.loadingMessage
                    : dialogState === "success"
                      ? text.successMessage
                      : localizeResetError(resetError, language)}
              </p>
              <div className="reset-dialog__card">
                <span className="reset-dialog__card-icon"><ResetCardIcon /></span>
                <span>{text.cardRemaining}</span>
                <strong>{expiryDaysLabel(selectedCard, now, language)}</strong>
              </div>
              <div className={`reset-dialog__actions reset-dialog__actions--${dialogState}`}>
                {dialogState === "success" ? (
                  <button className="reset-dialog__primary" type="button" onClick={closeResetDialog}>
                    {text.done}
                  </button>
                ) : (
                  <>
                    <button
                      className="reset-dialog__secondary"
                      type="button"
                      disabled={dialogState === "loading"}
                      onClick={closeResetDialog}
                    >
                      <CloseIcon />
                      {text.cancel}
                    </button>
                    {dialogState !== "loading" && (
                      <button
                        className="reset-dialog__primary"
                        type="button"
                        onClick={() => void confirmReset()}
                        disabled={selectedCard.expiresAt !== null && selectedCard.expiresAt <= now / 1000}
                      >
                        {dialogState === "error" ? text.retry : text.confirmReset}
                      </button>
                    )}
                    {dialogState === "loading" && (
                      <button className="reset-dialog__primary" type="button" disabled>
                        <LoaderCircleIcon button />
                        {text.usingCard}
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        )}

        {viewMode === "details" && settingsOpen && (
          <div
            className="settings-dialog-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) setSettingsOpen(false);
            }}
          >
            <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
              <button className="settings-dialog__close" type="button" aria-label={text.close} onClick={() => setSettingsOpen(false)}>
                <CloseIcon />
              </button>
              <h2 id="settings-dialog-title">{text.startupSettings}</h2>
              <p className="settings-dialog__description">{text.settingsDescription}</p>
              {settingsLoading ? (
                <p className="settings-dialog__status">{text.settingsLoading}</p>
              ) : (
                <div className="settings-dialog__options">
                  <section className="settings-group">
                    <h3>{text.capsuleSection}</h3>
                    <label className="settings-option">
                      <span className="settings-option__copy">
                        <strong>{text.startWithWindows}</strong>
                        <span>{text.startWithWindowsHint}</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={appSettings.startWithWindows}
                        disabled={settingsSaving}
                        onChange={(event) => void updateAppSetting("startWithWindows", event.currentTarget.checked)}
                      />
                    </label>
                    <label className="settings-option">
                      <span className="settings-option__copy">
                        <strong>{text.capsuleAlwaysOnTop}</strong>
                        <span>{text.capsuleAlwaysOnTopHint}</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={appSettings.capsuleAlwaysOnTop}
                        disabled={settingsSaving}
                        onChange={(event) => void updateAppSetting("capsuleAlwaysOnTop", event.currentTarget.checked)}
                      />
                    </label>
                    <div className="settings-range">
                      <div className="settings-range__header">
                        <span className="settings-option__copy">
                          <strong>{text.capsuleOpacity}</strong>
                          <span>{text.capsuleOpacityHint}</span>
                        </span>
                        <output>{appSettings.capsuleOpacityPercent}%</output>
                      </div>
                      <input
                        className="settings-range__input"
                        aria-label={text.capsuleOpacity}
                        type="range"
                        min="40"
                        max="100"
                        step="5"
                        value={appSettings.capsuleOpacityPercent}
                        disabled={settingsSaving}
                        onChange={(event) => previewCapsuleOpacity(Number(event.currentTarget.value))}
                        onPointerUp={(event) => void updateAppSetting("capsuleOpacityPercent", Number(event.currentTarget.value))}
                        onKeyUp={(event) => void updateAppSetting("capsuleOpacityPercent", Number(event.currentTarget.value))}
                      />
                    </div>
                  </section>
                  <section className="settings-group">
                    <h3>{text.refreshSection}</h3>
                    <div className="settings-control">
                      <span className="settings-option__copy">
                        <strong>{text.refreshInterval}</strong>
                        <span>{text.refreshIntervalHint}</span>
                      </span>
                      <select
                        aria-label={text.refreshInterval}
                        value={appSettings.refreshIntervalMinutes}
                        disabled={settingsSaving}
                        onChange={(event) => void updateAppSetting("refreshIntervalMinutes", Number(event.currentTarget.value))}
                      >
                        {[1, 2, 5, 10].map((minutes) => (
                          <option key={minutes} value={minutes}>{minutes} {text.minutes}</option>
                        ))}
                      </select>
                    </div>
                  </section>
                  <section className="settings-group">
                    <h3>{text.alertsSection}</h3>
                    <label className="settings-option">
                      <span className="settings-option__copy">
                        <strong>{text.lowBalanceAlert}</strong>
                        <span>{text.lowBalanceAlertHint}</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={appSettings.lowBalanceAlertEnabled}
                        disabled={settingsSaving}
                        onChange={(event) => void updateAppSetting("lowBalanceAlertEnabled", event.currentTarget.checked)}
                      />
                    </label>
                    <div className={`settings-range${appSettings.lowBalanceAlertEnabled ? "" : " settings-control--disabled"}`}>
                      <div className="settings-range__header">
                        <span className="settings-option__copy">
                          <strong>{text.lowBalanceThreshold}</strong>
                        </span>
                        <output>{appSettings.lowBalanceThresholdPercent}%</output>
                      </div>
                      <input
                        className="settings-range__input"
                        aria-label={text.lowBalanceThreshold}
                        type="range"
                        min="5"
                        max="50"
                        step="5"
                        value={appSettings.lowBalanceThresholdPercent}
                        disabled={settingsSaving || !appSettings.lowBalanceAlertEnabled}
                        onChange={(event) => {
                          const threshold = Number(event.currentTarget.value);
                          setAppSettings((current) => ({ ...current, lowBalanceThresholdPercent: threshold }));
                        }}
                        onPointerUp={(event) => void updateAppSetting("lowBalanceThresholdPercent", Number(event.currentTarget.value))}
                        onKeyUp={(event) => void updateAppSetting("lowBalanceThresholdPercent", Number(event.currentTarget.value))}
                      />
                    </div>
                    <label className="settings-option">
                      <span className="settings-option__copy">
                        <strong>{text.usagePaceAlert}</strong>
                        <span>{text.usagePaceAlertHint}</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={appSettings.usagePaceAlertEnabled}
                        disabled={settingsSaving}
                        onChange={(event) => void updateAppSetting("usagePaceAlertEnabled", event.currentTarget.checked)}
                      />
                    </label>
                    <div className={`settings-control${appSettings.usagePaceAlertEnabled ? "" : " settings-control--disabled"}`}>
                      <span className="settings-option__copy">
                        <strong>{text.usagePaceThreshold}</strong>
                      </span>
                      <select
                        aria-label={text.usagePaceThreshold}
                        value={appSettings.usagePaceAlertThreshold}
                        disabled={settingsSaving || !appSettings.usagePaceAlertEnabled}
                        onChange={(event) => {
                          const threshold = event.currentTarget.value;
                          if (threshold === "fast" || threshold === "very-fast") {
                            void updateAppSetting("usagePaceAlertThreshold", threshold);
                          }
                        }}
                      >
                        <option value="fast">{text.paceThresholdFast}</option>
                        <option value="very-fast">{text.paceThresholdVeryFast}</option>
                      </select>
                    </div>
                  </section>
                </div>
              )}
              {settingsError && <p className="settings-dialog__error" role="alert">{settingsError}</p>}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
