export type UsagePaceAlertThreshold = "fast" | "very-fast";

export interface AppSettings {
  startWithWindows: boolean;
  capsuleOpacityPercent: number;
  capsuleAlwaysOnTop: boolean;
  refreshIntervalMinutes: number;
  lowBalanceAlertEnabled: boolean;
  lowBalanceThresholdPercent: number;
  usagePaceAlertEnabled: boolean;
  usagePaceAlertThreshold: UsagePaceAlertThreshold;
  autoShutdownOnCodexComplete: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  startWithWindows: false,
  capsuleOpacityPercent: 100,
  capsuleAlwaysOnTop: true,
  refreshIntervalMinutes: 2,
  lowBalanceAlertEnabled: false,
  lowBalanceThresholdPercent: 20,
  usagePaceAlertEnabled: false,
  usagePaceAlertThreshold: "very-fast",
  autoShutdownOnCodexComplete: false,
};
