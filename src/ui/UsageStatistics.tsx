import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUsage } from "../hooks/useUsage";
import { EMPTY_STATISTICS, type QuotaHistorySample, type StatisticsData, type TokenDailyBucket } from "../types/statistics";
import "../statistics.css";

type Tab = "quota" | "tokens";
type QuotaPeriod = "fiveHour" | "weekly";
type RangePreset = 7 | 30 | 90 | "custom";
type Theme = "dark" | "light";

interface DateRange {
  start: string;
  end: string;
}

interface ChartDatum {
  key: string;
  timestamp: number;
  value: number;
  title: string;
  detail: string;
}

interface Point extends ChartDatum {
  x: number;
  y: number;
}

const PLOT = { left: 58, right: 836, top: 18, bottom: 192, height: 224 };
const QUOTA_CSV_HEADER = ["timestamp", "quota_type", "remaining_percent", "reset_at", "event_type", "data_source"];
const TOKEN_CSV_HEADER = ["timestamp", "model", "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "total_tokens", "data_source"];

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDay(value: string, end = false): number {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return NaN;
  return end
    ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
    : new Date(year, month - 1, day).getTime();
}

function bucketTimestamp(bucket: TokenDailyBucket): number {
  const [year, month, day] = bucket.startDate.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day, 12).getTime();
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp));
}

function formatRecordDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const datePart = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const timePart = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${datePart}  ${timePart}`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatSpan(first: number | undefined, last: number | undefined): string {
  if (first === undefined || last === undefined) return "—";
  const minutes = Math.max(0, Math.floor((last - first) / 60_000));
  if (minutes === 0) return "单点记录";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function makeCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function downsample(points: ChartDatum[], limit = 900): ChartDatum[] {
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function readThemePreference(): Theme {
  try {
    return window.localStorage.getItem("capsulemeter-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    const low = Math.min(current.y, next.y);
    const high = Math.max(current.y, next.y);
    const firstControlY = clamp(current.y + (next.y - previous.y) * 0.12, low, high);
    const secondControlY = clamp(next.y - (after.y - current.y) * 0.12, low, high);
    const width = next.x - current.x;
    path += ` C ${current.x + width / 3} ${firstControlY}, ${next.x - width / 3} ${secondControlY}, ${next.x} ${next.y}`;
  }
  return path;
}

function niceTokenMaximum(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * magnitude;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5v5l3.3 2" /></svg>;
}

function CalendarIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.8" y="5.5" width="16.4" height="15" rx="2.5" /><path d="M8 3.5v4M16 3.5v4M4 9.5h16" /></svg>;
}

function StatisticsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="13" width="4" height="8" rx="2" /><rect x="10" y="8" width="4" height="13" rx="2" /><rect x="17.5" y="3" width="4" height="18" rx="2" /></svg>;
}

function TokenCubeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 8.4 4.7v9L12 21.2l-8.4-4.7v-9L12 2.8Z" /><path d="m3.9 7.5 8.1 4.7 8.1-4.7M12 12.2v9" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8v10.4m-4-3.7 4 4 4-4M4 17v2.2c0 .6.5 1.1 1.1 1.1h13.8c.6 0 1.1-.5 1.1-1.1V17" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function SummaryCard({
  title,
  description,
  value,
  kind,
  icon,
}: {
  title: string;
  description: string;
  value: number | null;
  kind: "violet" | "blue" | "mint";
  icon: React.ReactNode;
}) {
  const percent = value === null ? 0 : clamp(value, 0, 100);
  return (
    <article className={`statistics-summary statistics-summary--${kind}`}>
      <span className="statistics-summary__icon">{icon}</span>
      <div className="statistics-summary__copy">
        <span>{title}</span>
        <small>{description}</small>
      </div>
      <strong>{value === null ? "—" : `${value}%`}</strong>
      <div className="statistics-summary__track"><span style={{ width: `${percent}%` }} /></div>
    </article>
  );
}

function EmptyHistory({
  loading,
  error,
  onRetry,
  loadingText = "正在加载历史记录…",
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  loadingText?: string;
}) {
  if (loading) return <p className="statistics-empty">{loadingText}</p>;
  if (error) {
    return <div className="statistics-empty statistics-empty--error"><span>历史数据加载失败</span><button type="button" onClick={onRetry}>重试</button></div>;
  }
  return <p className="statistics-empty">暂无历史记录</p>;
}

function TrendChart({
  data,
  mode,
  color,
  zoomResetKey,
  hidden = false,
  emptyMessage = "暂无历史记录",
}: {
  data: ChartDatum[];
  mode: "quota" | "tokens";
  color: string;
  zoomResetKey: string;
  hidden?: boolean;
  emptyMessage?: string;
}) {
  const [activePoint, setActivePoint] = useState<Point | null>(null);
  const [timeDomain, setTimeDomain] = useState<{ min: number; max: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotted = useMemo(() => downsample(data), [data]);
  const maximum = mode === "quota"
    ? 100
    : niceTokenMaximum(data.reduce((current, point) => Math.max(current, point.value), 0));
  const timestamps = plotted.map((point) => point.timestamp);
  const dataMinTime = timestamps[0] ?? 0;
  const dataMaxTime = timestamps[timestamps.length - 1] ?? 0;
  const minTime = timeDomain
    ? clamp(timeDomain.min, dataMinTime, dataMaxTime)
    : dataMinTime;
  const maxTime = timeDomain
    ? clamp(timeDomain.max, minTime, dataMaxTime)
    : dataMaxTime;
  const points: Point[] = plotted.map((point) => {
    const ratio = maxTime === minTime ? 0.5 : (point.timestamp - minTime) / (maxTime - minTime);
    return {
      ...point,
      x: PLOT.left + ratio * (PLOT.right - PLOT.left),
      y: PLOT.bottom - clamp(point.value, 0, maximum) / maximum * (PLOT.bottom - PLOT.top),
    };
  });
  const gapThreshold = mode === "quota" ? 10 * 60_000 : 36 * 60 * 60_000;
  const segments = points.reduce<Point[][]>((groups, point) => {
    const current = groups[groups.length - 1];
    if (!current || point.timestamp - current[current.length - 1].timestamp > gapThreshold) groups.push([point]);
    else current.push(point);
    return groups;
  }, []);
  const areas = segments.filter((segment) => segment.length > 1).map((segment) => {
    const path = smoothPath(segment);
    return `${path} L ${segment[segment.length - 1].x} ${PLOT.bottom} L ${segment[0].x} ${PLOT.bottom} Z`;
  });
  const valueTicks = mode === "quota" ? [0, 50, 100] : [0, 0.25, 0.5, 0.75, 1].map((ratio) => maximum * ratio);
  const labelTimes = Array.from({ length: 7 }, (_, index) => minTime + (maxTime - minTime) * index / 6);

  useEffect(() => setActivePoint(null), [data, mode, hidden]);
  useEffect(() => setTimeDomain(null), [zoomResetKey, mode, hidden]);

  const handleChartWheel = useCallback((event: WheelEvent) => {
    const fullSpan = dataMaxTime - dataMinTime;
    if (fullSpan <= 0 || event.deltaY === 0) return;

    const chart = chartRef.current;
    const bounds = chart?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;

    event.preventDefault();
    const plotLeft = bounds.left + bounds.width * PLOT.left / 860;
    const plotWidth = bounds.width * (PLOT.right - PLOT.left) / 860;
    const anchorRatio = clamp((event.clientX - plotLeft) / plotWidth, 0, 1);
    const deltaY = event.deltaMode === 1 ? event.deltaY * 32 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY;
    const zoomFactor = Math.exp(-deltaY * 0.002);
    const minSpan = Math.min(fullSpan, Math.max(60_000, fullSpan / 256));

    setTimeDomain((current) => {
      const currentMin = current ? clamp(current.min, dataMinTime, dataMaxTime) : dataMinTime;
      const currentMax = current ? clamp(current.max, currentMin, dataMaxTime) : dataMaxTime;
      const currentSpan = Math.max(1, currentMax - currentMin);
      const nextSpan = clamp(currentSpan / zoomFactor, minSpan, fullSpan);
      if (nextSpan >= fullSpan - 1) return null;

      const anchorTime = currentMin + anchorRatio * currentSpan;
      let nextMin = anchorTime - anchorRatio * nextSpan;
      let nextMax = nextMin + nextSpan;
      if (nextMin < dataMinTime) {
        nextMin = dataMinTime;
        nextMax = nextMin + nextSpan;
      }
      if (nextMax > dataMaxTime) {
        nextMax = dataMaxTime;
        nextMin = nextMax - nextSpan;
      }
      return { min: nextMin, max: nextMax };
    });
  }, [dataMinTime, dataMaxTime]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.addEventListener("wheel", handleChartWheel, { passive: false });
    return () => chart.removeEventListener("wheel", handleChartWheel);
  }, [handleChartWheel, hidden]);

  if (data.length === 0 || hidden) {
    return <div className="statistics-chart__empty">{hidden ? "已隐藏总量曲线" : emptyMessage}</div>;
  }

  return (
    <div className="statistics-chart" ref={chartRef} title="滚动滚轮缩放图表">
      <svg className="statistics-chart__svg" viewBox={`0 0 860 ${PLOT.height}`} preserveAspectRatio="none" role="img" aria-label={mode === "quota" ? "额度剩余趋势" : "每日 Token 总量趋势"}>
        <defs>
          <linearGradient id="statistics-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={color} stopOpacity="0.015" />
          </linearGradient>
          <clipPath id="statistics-chart-clip"><rect x={PLOT.left} y={PLOT.top} width={PLOT.right - PLOT.left} height={PLOT.bottom - PLOT.top} /></clipPath>
        </defs>
        {valueTicks.map((tick, index) => {
          const y = PLOT.bottom - tick / maximum * (PLOT.bottom - PLOT.top);
          const label = mode === "quota" ? `${Math.round(tick)}%` : compactNumber(tick);
          return (
            <g key={`y-${index}`}>
              <line x1={PLOT.left} y1={y} x2={PLOT.right} y2={y} className="statistics-chart__grid" />
              <text x={PLOT.left - 12} y={y + 4} textAnchor="end" className="statistics-chart__axis-label">{label}</text>
            </g>
          );
        })}
        {labelTimes.map((_, index) => (
          <line key={`x-grid-${index}`} x1={PLOT.left + index / 6 * (PLOT.right - PLOT.left)} y1={PLOT.top} x2={PLOT.left + index / 6 * (PLOT.right - PLOT.left)} y2={PLOT.bottom} className="statistics-chart__grid statistics-chart__grid--vertical" />
        ))}
        {labelTimes.map((timestamp, index) => (
          <text key={`x-${index}`} x={PLOT.left + index / 6 * (PLOT.right - PLOT.left)} y={PLOT.height - 7} textAnchor={index === 0 ? "start" : index === 6 ? "end" : "middle"} className="statistics-chart__axis-label">
            {timestamp ? formatDate(timestamp) : "—"}
          </text>
        ))}
        <g clipPath="url(#statistics-chart-clip)">
          {areas.map((area, index) => <path key={`area-${index}`} d={area} fill="url(#statistics-chart-fill)" />)}
          {segments.map((segment, index) => <path key={`line-${index}`} d={smoothPath(segment)} className="statistics-chart__line" style={{ stroke: color }} />)}
          {points.map((point) => (
            <circle
              key={point.key}
              cx={point.x}
              cy={point.y}
              r={points.length <= 120 ? 4.4 : 2.1}
              className="statistics-chart__point"
              style={{ stroke: color }}
              tabIndex={0}
              aria-label={`${point.title} ${mode === "quota" ? `${point.value}%` : formatNumber(point.value)}`}
              onMouseEnter={() => setActivePoint(point)}
              onMouseLeave={() => setActivePoint(null)}
              onFocus={() => setActivePoint(point)}
              onBlur={() => setActivePoint(null)}
            />
          ))}
        </g>
      </svg>
      {activePoint && (
        <div className="statistics-chart__tooltip" style={{
          left: `${clamp(activePoint.x / 860 * 100, 15, 85)}%`,
          top: `${clamp(activePoint.y / PLOT.height * 100 - 3, 4, 74)}%`,
        }}>
          <strong>{activePoint.title}</strong>
          <span>{mode === "quota" ? `剩余额度 ${activePoint.value}%` : `总 Token ${formatNumber(activePoint.value)}`}</span>
          <small>{activePoint.detail}</small>
        </div>
      )}
    </div>
  );
}

export function UsageStatisticsPage() {
  const usage = useUsage();
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const [tab, setTab] = useState<Tab>("quota");
  const [quotaPeriod, setQuotaPeriod] = useState<QuotaPeriod>("fiveHour");
  const [range, setRange] = useState<RangePreset>(7);
  const [customRange, setCustomRange] = useState<DateRange>(() => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { start: localDay(start), end: localDay(today) };
  });
  const [draftRange, setDraftRange] = useState<DateRange>(customRange);
  const [customOpen, setCustomOpen] = useState(false);
  const [showTokenTotal, setShowTokenTotal] = useState(true);
  const [statistics, setStatistics] = useState<StatisticsData>(EMPTY_STATISTICS);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [visibleRecords, setVisibleRecords] = useState(5);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const updateTheme = (value: string | null) => {
      if (!disposed) setTheme(value === "light" ? "light" : "dark");
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "capsulemeter-theme") updateTheme(event.newValue);
    };

    void listen<string>("capsulemeter-theme-changed", (event) => updateTheme(event.payload)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    window.addEventListener("storage", handleStorage);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenStatistics: (() => void) | undefined;
    let unlistenSamples: (() => void) | undefined;
    void listen<StatisticsData>("statistics-updated", (event) => {
      if (!disposed) {
        setStatistics(event.payload);
        setHistoryError(false);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlistenStatistics = stop;
    });
    void listen<QuotaHistorySample>("statistics-quota-sample", (event) => {
      if (disposed) return;
      setStatistics((current) => current.quotaSamples.some((sample) => sample.sampledAt === event.payload.sampledAt)
        ? current
        : { ...current, quotaSamples: [...current.quotaSamples, event.payload].sort((a, b) => a.sampledAt - b.sampledAt) });
    }).then((stop) => {
      if (disposed) stop();
      else unlistenSamples = stop;
    });
    void invoke<StatisticsData>("get_statistics_data")
      .then((data) => {
        if (!disposed) {
          setStatistics(data);
          setHistoryError(false);
        }
      })
      .catch(() => { if (!disposed) setHistoryError(true); })
      .finally(() => { if (!disposed) setHistoryLoading(false); });
    return () => {
      disposed = true;
      unlistenStatistics?.();
      unlistenSamples?.();
    };
  }, [loadAttempt]);

  const retryHistoryLoad = () => {
    setHistoryLoading(true);
    setHistoryError(false);
    setLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => setVisibleRecords(5), [tab, quotaPeriod, range, customRange]);

  const bounds = useMemo(() => {
    if (range === "custom") return { start: parseLocalDay(customRange.start), end: parseLocalDay(customRange.end, true) };
    const end = Date.now();
    return { start: end - range * 24 * 60 * 60 * 1000, end };
  }, [range, customRange]);

  const quotaRecords = useMemo(() => {
    const valueKey = quotaPeriod === "fiveHour" ? "fiveHourRemainingPercent" : "weeklyRemainingPercent";
    const resetKey = quotaPeriod === "fiveHour" ? "fiveHourResetsAt" : "weeklyResetsAt";
    return statistics.quotaSamples
      .filter((sample) => sample.sampledAt >= bounds.start && sample.sampledAt <= bounds.end && sample[valueKey] !== null)
      .map((sample) => ({ sample, value: sample[valueKey] as number, resetAt: sample[resetKey] }))
      .sort((left, right) => left.sample.sampledAt - right.sample.sampledAt);
  }, [statistics.quotaSamples, quotaPeriod, bounds]);

  const tokenRecords = useMemo(() => statistics.tokenUsage.dailyUsageBuckets
    .filter((bucket) => {
      const timestamp = bucketTimestamp(bucket);
      return timestamp >= bounds.start && timestamp <= bounds.end;
    })
    .sort((left, right) => left.startDate.localeCompare(right.startDate)), [statistics.tokenUsage.dailyUsageBuckets, bounds]);

  const quotaChartData = useMemo<ChartDatum[]>(() => quotaRecords.map(({ sample, value }) => ({
    key: String(sample.sampledAt),
    timestamp: sample.sampledAt,
    value,
    title: formatDateTime(sample.sampledAt),
    detail: "额度采样",
  })), [quotaRecords]);

  const tokenChartData = useMemo<ChartDatum[]>(() => tokenRecords.map((bucket) => ({
    key: bucket.startDate,
    timestamp: bucketTimestamp(bucket),
    value: bucket.tokens,
    title: bucket.startDate,
    detail: "每日总量（App Server 日汇总）",
  })), [tokenRecords]);

  const currentQuotaFirst = quotaRecords[0]?.sample.sampledAt;
  const currentQuotaLast = quotaRecords[quotaRecords.length - 1]?.sample.sampledAt;
  const tokenFirst = tokenRecords.length ? bucketTimestamp(tokenRecords[0]) : undefined;
  const tokenLast = tokenRecords.length ? bucketTimestamp(tokenRecords[tokenRecords.length - 1]) : undefined;
  const closePage = () => {
    if (isTauri()) void invoke("hide_statistics_window");
  };

  const applyCustomRange = () => {
    const start = parseLocalDay(draftRange.start);
    const end = parseLocalDay(draftRange.end, true);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      setNotice("结束日期不能早于开始日期");
      return;
    }
    setCustomRange(draftRange);
    setRange("custom");
    setCustomOpen(false);
  };

  const selectRange = (preset: RangePreset) => {
    if (preset === "custom") {
      setDraftRange(customRange);
      setCustomOpen(true);
      return;
    }
    setRange(preset);
    setCustomOpen(false);
  };

  const exportCsv = async () => {
    const rows: Array<Array<string | number | null>> = tab === "quota"
      ? quotaRecords.map(({ sample, value, resetAt }) => [
          new Date(sample.sampledAt).toISOString(),
          quotaPeriod === "fiveHour" ? "5h" : "weekly",
          value,
          resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
          "quota_sample",
          sample.dataSource,
        ])
      : tokenRecords.map((bucket) => [bucket.startDate, null, null, null, null, null, bucket.tokens, bucket.dataSource]);

    if (rows.length === 0) {
      setNotice("当前时间范围内没有可导出的数据");
      return;
    }
    if (!isTauri()) {
      setNotice("CSV 保存仅在桌面应用中可用");
      return;
    }
    const date = localDay(new Date()).replaceAll("-", "");
    const fileName = tab === "tokens"
      ? `capsulemeter-tokens-${date}.csv`
      : `capsulemeter-quota-${quotaPeriod === "fiveHour" ? "5h" : "weekly"}-${date}.csv`;
    try {
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await invoke("save_statistics_csv", { path, contents: makeCsv(tab === "quota" ? QUOTA_CSV_HEADER : TOKEN_CSV_HEADER, rows) });
      setNotice("CSV 已保存");
    } catch (error) {
      setNotice(`CSV 保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const refreshTokens = () => {
    if (!isTauri()) return;
    void invoke("refresh_statistics_token_usage").catch((error) => {
      setNotice(`Token 历史读取失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const currentFiveHour = usage.fiveHour?.remainingPercent ?? null;
  const currentWeekly = usage.weekly?.remainingPercent ?? null;
  const summaryCount = tab === "quota" ? quotaRecords.length : tokenRecords.length;
  const summarySpan = tab === "quota"
    ? formatSpan(currentQuotaFirst, currentQuotaLast)
    : formatSpan(tokenFirst, tokenLast);

  return (
    <main className="statistics-page">
      <div className="statistics-page__inner">
        <header
          className="statistics-header"
          data-tauri-drag-region
          onMouseDown={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("button, input, a")) return;
            if (!isTauri() || event.button !== 0) return;
            event.preventDefault();
            void getCurrentWindow().startDragging().catch((error) => {
              console.error("无法拖动统计窗口", error);
            });
          }}
        >
          <div className="statistics-header__identity">
            <span className="statistics-header__icon"><StatisticsIcon /></span>
            <div>
              <h1>统计</h1>
              <p className="statistics-header__subtitle">查看您的使用情况和历史记录</p>
            </div>
          </div>
          <button className="statistics-close" type="button" aria-label="关闭" title="关闭" onClick={closePage}><CloseIcon /></button>
        </header>

        <nav className="statistics-tabs" aria-label="统计类型">
          <button className={tab === "quota" ? "is-active" : ""} type="button" onClick={() => setTab("quota")}><ClockIcon />额度使用历史</button>
          <button className={tab === "tokens" ? "is-active" : ""} type="button" onClick={() => setTab("tokens")}><TokenCubeIcon />Token 使用历史</button>
        </nav>

        {tab === "quota" ? (
          <>
            <section className="statistics-summary-grid" aria-label="当前额度">
              <SummaryCard title="5 小时额度" description="当前周期剩余" value={currentFiveHour} kind="violet" icon={<ClockIcon />} />
              <SummaryCard title="本周额度" description="当前周期剩余" value={currentWeekly} kind="blue" icon={<CalendarIcon />} />
            </section>
            <section className="statistics-detail-card">
              <div className="statistics-detail-heading">
                <div className="statistics-detail-heading__title">
                  <span className="statistics-detail-heading__icon"><ClockIcon /></span>
                  <h2>额度使用详情</h2>
                </div>
                <div className="statistics-detail-heading__meta">
                  <span className="statistics-detail-metric"><i /><span>采样点数</span><strong>{formatNumber(summaryCount)}</strong></span>
                  <span className="statistics-detail-metric"><CalendarIcon /><span>记录跨度</span><strong>{summarySpan}</strong></span>
                  <button className="statistics-export" type="button" onClick={() => void exportCsv()}><DownloadIcon />下载 CSV</button>
                </div>
              </div>
              <div className="statistics-trend-heading">
                <h3>历史趋势</h3>
                <div className="statistics-control-row">
                  <div className="statistics-segmented" aria-label="额度类型">
                    <button type="button" className={quotaPeriod === "fiveHour" ? "is-active" : ""} onClick={() => setQuotaPeriod("fiveHour")}>5 小时</button>
                    <button type="button" className={quotaPeriod === "weekly" ? "is-active" : ""} onClick={() => setQuotaPeriod("weekly")}>本周</button>
                  </div>
                  <div className="statistics-segmented statistics-segmented--range" aria-label="时间范围">
                    {([7, 30, 90, "custom"] as RangePreset[]).map((preset) => (
                      <button key={preset} type="button" className={range === preset ? "is-active" : ""} onClick={() => selectRange(preset)}>
                        {preset === "custom" ? "自定义" : `${preset} 天`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {customOpen && (
                <div className="statistics-custom-range" role="dialog" aria-label="自定义时间范围">
                  <label>开始日期<input type="date" value={draftRange.start} max={draftRange.end} onChange={(event) => setDraftRange((current) => ({ ...current, start: event.target.value }))} /></label>
                  <label>结束日期<input type="date" value={draftRange.end} min={draftRange.start} onChange={(event) => setDraftRange((current) => ({ ...current, end: event.target.value }))} /></label>
                  <div><button type="button" onClick={() => setCustomOpen(false)}>取消</button><button className="is-primary" type="button" onClick={applyCustomRange}>应用</button></div>
                </div>
              )}
              <div className="statistics-chart-panel">
                <TrendChart
                  data={quotaChartData}
                  mode="quota"
                  color="#8758F5"
                  zoomResetKey={`${quotaPeriod}:${range}:${customRange.start}:${customRange.end}`}
                  emptyMessage={historyLoading ? "正在加载历史记录…" : historyError ? "历史数据加载失败" : "暂无历史记录"}
                />
              </div>
              <div className="statistics-history">
                <div className="statistics-history__heading"><h3>历史记录</h3></div>
                {quotaRecords.length === 0 ? <EmptyHistory loading={historyLoading} error={historyError} onRetry={retryHistoryLoad} /> : (
                  <div className="statistics-record-list">
                    {[...quotaRecords].reverse().slice(0, visibleRecords).map(({ sample, value }) => (
                      <article className="statistics-record" key={`${quotaPeriod}-${sample.sampledAt}`}>
                        <i className="statistics-record__dot" />
                        <time>{formatRecordDateTime(sample.sampledAt)}</time>
                        <span className="statistics-record__event">额度采样</span>
                        <span className="statistics-record__value">剩余 {value}%</span>
                      </article>
                    ))}
                  </div>
                )}
                {quotaRecords.length > visibleRecords && <button className="statistics-load-more" type="button" onClick={() => setVisibleRecords((count) => count + 5)}>显示更多记录</button>}
              </div>
            </section>
          </>
        ) : (
          <>
            <section className="statistics-summary-grid statistics-summary-grid--tokens" aria-label="Token 汇总">
              <article className="statistics-token-summary"><span>累计 Token</span><strong>{formatNumber(statistics.tokenUsage.summary.lifetimeTokens)}</strong><small>Codex 账户汇总</small></article>
              <article className="statistics-token-summary"><span>输入 Token</span><strong>—</strong><small>当前数据源未提供拆分</small></article>
              <article className="statistics-token-summary"><span>输出 Token</span><strong>—</strong><small>当前数据源未提供拆分</small></article>
            </section>
            <section className="statistics-detail-card">
              <div className="statistics-detail-heading">
                <div className="statistics-detail-heading__title">
                  <span className="statistics-detail-heading__icon statistics-detail-heading__icon--token"><TokenCubeIcon /></span>
                  <h2>Token 使用详情</h2>
                </div>
                <div className="statistics-detail-heading__meta">
                  <span className="statistics-detail-metric"><i /><span>有效记录数</span><strong>{formatNumber(summaryCount)}</strong></span>
                  <span className="statistics-detail-metric"><CalendarIcon /><span>记录跨度</span><strong>{summarySpan}</strong></span>
                  <button className="statistics-export" type="button" onClick={() => void exportCsv()}><DownloadIcon />下载 CSV</button>
                </div>
              </div>
              <div className="statistics-trend-heading">
                <h3>Token 使用趋势</h3>
                <div className="statistics-control-row statistics-control-row--tokens">
                <div className="statistics-segmented statistics-segmented--range" aria-label="时间范围">
                  {([7, 30, 90, "custom"] as RangePreset[]).map((preset) => (
                    <button key={preset} type="button" className={range === preset ? "is-active" : ""} onClick={() => selectRange(preset)}>
                      {preset === "custom" ? "自定义" : `${preset} 天`}
                    </button>
                  ))}
                </div>
                  <button className={`statistics-legend statistics-legend--button${showTokenTotal ? " is-visible" : ""}`} type="button" onClick={() => setShowTokenTotal((value) => !value)}><i />总 Token</button>
                </div>
              </div>
              {customOpen && (
                <div className="statistics-custom-range" role="dialog" aria-label="自定义时间范围">
                  <label>开始日期<input type="date" value={draftRange.start} max={draftRange.end} onChange={(event) => setDraftRange((current) => ({ ...current, start: event.target.value }))} /></label>
                  <label>结束日期<input type="date" value={draftRange.end} min={draftRange.start} onChange={(event) => setDraftRange((current) => ({ ...current, end: event.target.value }))} /></label>
                  <div><button type="button" onClick={() => setCustomOpen(false)}>取消</button><button className="is-primary" type="button" onClick={applyCustomRange}>应用</button></div>
                </div>
              )}
              <div className="statistics-chart-panel">
                <TrendChart
                  data={tokenChartData}
                  mode="tokens"
                  color="#2584D8"
                  zoomResetKey={`tokens:${range}:${customRange.start}:${customRange.end}`}
                  hidden={!showTokenTotal}
                  emptyMessage={historyLoading || statistics.tokenFetchPending ? "正在读取 Token 历史…" : historyError ? "历史数据加载失败" : "暂无历史记录"}
                />
              </div>
              {statistics.tokenError && (
                <div className="statistics-error" role="alert"><span>Token 历史读取失败：{statistics.tokenError}</span><button type="button" onClick={refreshTokens}>重试</button></div>
              )}
              {!statistics.tokenError && statistics.tokenFetchPending && <p className="statistics-inline-status">正在读取 Codex 账户 Token 汇总…</p>}
              <p className="statistics-data-note">当前 App Server 仅提供账户每日 Token 总量及累计汇总，不含输入/输出拆分、模型、单次请求记录；图表和列表仅展示实际返回的每日总量。</p>
              <div className="statistics-history">
                <div className="statistics-history__heading"><h3>历史记录</h3></div>
                {tokenRecords.length === 0 ? <EmptyHistory loading={historyLoading || (!historyError && statistics.tokenFetchPending)} error={historyError} onRetry={retryHistoryLoad} loadingText="正在读取 Token 历史…" /> : (
                  <div className="statistics-record-list statistics-record-list--tokens">
                    {[...tokenRecords].reverse().slice(0, visibleRecords).map((bucket) => (
                      <article className="statistics-record" key={bucket.startDate}>
                        <i className="statistics-record__dot statistics-record__dot--blue" />
                        <time>{bucket.startDate}</time>
                        <span className="statistics-record__event">每日账户汇总</span>
                        <span className="statistics-record__value">{formatNumber(bucket.tokens)} tokens</span>
                        <span className="statistics-record__reset">模型 / 输入 / 输出不可用</span>
                      </article>
                    ))}
                  </div>
                )}
                {tokenRecords.length > visibleRecords && <button className="statistics-load-more" type="button" onClick={() => setVisibleRecords((count) => count + 5)}>显示更多记录</button>}
              </div>
            </section>
          </>
        )}
      </div>
      {notice && <div className="statistics-toast" role="status">{notice}</div>}
    </main>
  );
}
