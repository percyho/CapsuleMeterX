export interface QuotaHistorySample {
  sampledAt: number;
  fiveHourRemainingPercent: number | null;
  fiveHourResetsAt: number | null;
  weeklyRemainingPercent: number | null;
  weeklyResetsAt: number | null;
  dataSource: string;
}

export interface TokenDailyBucket {
  startDate: string;
  tokens: number;
  dataSource: string;
}

export interface TokenUsageHistory {
  summary: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
  };
  dailyUsageBuckets: TokenDailyBucket[];
  updatedAt: number | null;
}

export interface StatisticsData {
  quotaSamples: QuotaHistorySample[];
  tokenUsage: TokenUsageHistory;
  tokenError: string | null;
  tokenFetchPending: boolean;
}

export const EMPTY_STATISTICS: StatisticsData = {
  quotaSamples: [],
  tokenUsage: {
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: [],
    updatedAt: null,
  },
  tokenError: null,
  tokenFetchPending: false,
};
