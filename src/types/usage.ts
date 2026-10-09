export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
}

export type ConnectionStatus = "loading" | "online" | "offline";

export interface ResetCardExpiry {
  id: string | null;
  resetType: string;
  status: string;
  expiresAt: number | null;
  expiryDetailsAvailable: boolean;
}

export interface UsageSnapshot {
  status: ConnectionStatus;
  connectionError: string | null;
  planName: string;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  resetCardsAvailable: number | null;
  resetCards: ResetCardExpiry[];
  nextResetCardExpiresAt: number | null;
  resetCardExpiryDetailsAvailable: boolean;
  resetCardsNeverExpire: boolean;
  fastModeEnabled: boolean | null;
}

export const EMPTY_USAGE: UsageSnapshot = {
  status: "loading",
  connectionError: null,
  planName: "ChatGPT",
  fiveHour: null,
  weekly: null,
  resetCardsAvailable: null,
  resetCards: [],
  nextResetCardExpiresAt: null,
  resetCardExpiryDetailsAvailable: false,
  resetCardsNeverExpire: false,
  fastModeEnabled: null,
};
