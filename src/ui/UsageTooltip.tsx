import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUsage } from "../hooks/useUsage";
import type { ResetCardExpiry, UsageWindow } from "../types/usage";
import {
  remainingLabel,
  resetCountdown,
  resetCardExpiryCountdown,
  resetClockLabel,
  usageColor,
  weeklyResetLabel,
} from "../utils/usage";

type ResetDialogState = "confirm" | "loading" | "success" | "error";

function UsageRing({ window, label }: { window: UsageWindow | null; label: string }) {
  const remaining = window?.remainingPercent ?? null;
  const radius = 23;
  const circumference = 2 * Math.PI * radius;
  const progress = remaining === null ? 0 : Math.max(0, Math.min(100, remaining));

  return (
    <svg
      className="usage-ring"
      viewBox="0 0 54 54"
      role="img"
      aria-label={`${label} ${remainingLabel(window)}`}
    >
      <circle className="usage-ring__track" cx="27" cy="27" r={radius} />
      <circle
        className="usage-ring__progress"
        cx="27"
        cy="27"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress / 100)}
        style={{ stroke: usageColor(remaining) }}
      />
      <text className="usage-ring__label" x="27" y="27" textAnchor="middle" dominantBaseline="central">
        {remaining === null ? "--" : `${remaining}%`}
      </text>
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg className="reset-card__ticket" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7.25A2.25 2.25 0 0 0 6.25 5h11.5A2.25 2.25 0 0 0 20 7.25v1.1a2.6 2.6 0 0 0 0 5.3v1.1A2.25 2.25 0 0 0 17.75 17h-11.5A2.25 2.25 0 0 0 4 14.75v-1.1a2.6 2.6 0 0 0 0-5.3v-1.1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 8.5v1m0 2v1m0 2h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function expiryLabel(card: ResetCardExpiry, now: number) {
  if (card.expiresAt === null) {
    return card.expiryDetailsAvailable ? "永久有效" : "有效期未知";
  }
  return resetCardExpiryCountdown(card.expiresAt, now);
}

function expiryDaysLabel(card: ResetCardExpiry, now: number) {
  if (card.expiresAt === null) {
    return card.expiryDetailsAvailable ? "永久有效" : "未知";
  }
  const seconds = Math.floor(card.expiresAt - now / 1000);
  if (seconds <= 0) return "已过期";
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${days} 天`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${hours} 小时`;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分钟` : "少于 1 分钟";
}

export function UsageTooltipWindow() {
  const usage = useUsage();
  const [now, setNow] = useState(Date.now());
  const [viewMode, setViewMode] = useState<"details" | "tray-preview">("details");
  const [selectedCard, setSelectedCard] = useState<ResetCardExpiry | null>(null);
  const [dialogState, setDialogState] = useState<ResetDialogState | null>(null);
  const [resetError, setResetError] = useState("");
  const [consumedCardIds, setConsumedCardIds] = useState<string[]>([]);
  const idempotencyKeys = useRef(new Map<string, string>());
  const tooltipRef = useRef<HTMLElement>(null);

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
  }, [viewMode, dialogState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dialogState !== "loading") {
        setDialogState(null);
        setSelectedCard(null);
        setResetError("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogState]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
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

  const openResetDialog = (card: ResetCardExpiry) => {
    setSelectedCard(card);
    setDialogState("confirm");
    setResetError("");
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
        ? "当前用量无需重置，这张卡仍未使用。"
        : outcome === "noCredit"
          ? "账户中没有可用的重置卡。"
          : `Codex 返回了未确认的结果：${outcome}`);
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
        if (isTauri()) void invoke("hide_usage_tooltip", { delayMs: 100 });
      }}
    >
      <section
        className={`usage-tooltip${viewMode === "tray-preview" ? " usage-tooltip--tray-preview" : ""}${dialogState ? " usage-tooltip--dialog-open" : ""}`}
        aria-label={viewMode === "tray-preview" ? "CapsuleMeterX usage preview" : "Usage details"}
        ref={tooltipRef}
      >
        {viewMode === "tray-preview" ? (
          <>
            <h1 className="usage-tooltip__title">CapsuleMeterX</h1>
            <div className="tray-preview__usage">
              <span className="tray-preview__metric">
                <span>5h</span>
                <strong>{remainingLabel(usage.fiveHour)}</strong>
              </span>
              <span className="tray-preview__separator" aria-hidden="true">·</span>
              <span className="tray-preview__metric">
                <span>Week</span>
                <strong>{remainingLabel(usage.weekly)}</strong>
              </span>
            </div>
            {usage.status === "offline" && (
              <p className="tray-preview__offline">Codex App Server 未连接</p>
            )}
            <button
              className="tray-preview__details-button"
              type="button"
              onClick={() => {
                if (isTauri()) void invoke("show_tray_usage_details");
              }}
            >
              点击查看详情 <span aria-hidden="true">→</span>
            </button>
          </>
        ) : (
          <>
            <h1 className="usage-tooltip__title">{usage.planName || "ChatGPT"}</h1>

            {usage.status === "offline" && (
              <p className="usage-tooltip__offline">无法连接 Codex App Server</p>
            )}

            <div className="usage-tooltip__periods">
              <div className="usage-window">
                <UsageRing window={usage.fiveHour} label="5 小时剩余" />
                <div className="usage-window__summary">
                  <strong>5 小时剩余</strong>
                  <span>下次重置</span>
                </div>
                <span className="usage-window__time">
                  {resetCountdown(usage.fiveHour, now)} · {resetClockLabel(usage.fiveHour)}
                </span>
              </div>
              <div className="usage-window">
                <UsageRing window={usage.weekly} label="本周剩余" />
                <div className="usage-window__summary">
                  <strong>本周剩余</strong>
                  <span>下次重置</span>
                </div>
                <span className="usage-window__time">
                  {weeklyResetLabel(usage.weekly)}
                </span>
              </div>
            </div>

            <div className="reset-cards">
              <div className="reset-cards__heading">
                <h2>剩余重置卡</h2>
                <span>{resetCardCount === null ? "--" : `${resetCardCount} 张`}</span>
              </div>

              {visibleCards.map((card, index) => {
                const expiry = expiryLabel(card, now);
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
                  ? "连接 Codex 后才能使用重置卡"
                  : expired
                    ? "这张重置卡已过期"
                    : !card.id || card.resetType !== "codexRateLimits"
                      ? "缺少可验证的重置卡标识，暂不能安全使用"
                      : undefined;

                return (
                  <article
                    className={`reset-card reset-card--${index % 2 === 0 ? "blue" : "violet"}`}
                    key={card.id ?? `reset-card-${index}`}
                  >
                    <div className="reset-card__icon"><TicketIcon /></div>
                    <div className="reset-card__expiry">
                      <span>离有效时间还剩</span>
                      <strong style={{ color: expiryColor }}>{expiryText}</strong>
                    </div>
                    <button
                      className="reset-card__action"
                      type="button"
                      disabled={!canRedeem || dialogState === "loading"}
                      title={disabledReason}
                      onClick={() => openResetDialog(card)}
                    >
                      重置
                    </button>
                  </article>
                );
              })}

              {visibleCards.length === 0 && (
                <p className="reset-cards__empty">
                  {resetCardCount === 0
                    ? "暂无可用重置卡"
                    : resetCardCount === null
                      ? "正在读取重置卡信息…"
                      : "暂时无法读取卡片详情，无法安全地指定卡片。"}
                </p>
              )}
              {resetCardCount !== null && resetCardCount > visibleCards.length && (
                <p className="reset-cards__note">其余卡片详情暂不可用</p>
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
                <button className="reset-dialog__close" type="button" aria-label="关闭" onClick={closeResetDialog}>
                  ×
                </button>
              )}
              <div className={`reset-dialog__symbol reset-dialog__symbol--${dialogState}`}>
                {dialogState === "loading" ? (
                  <span className="reset-dialog__spinner" aria-hidden="true" />
                ) : dialogState === "success" ? (
                  <span aria-hidden="true">✓</span>
                ) : (
                  <TicketIcon />
                )}
              </div>
              <h2 id="reset-dialog-title">
                {dialogState === "confirm"
                  ? "确认使用重置卡？"
                  : dialogState === "loading"
                    ? "正在使用重置卡…"
                    : dialogState === "success"
                      ? "重置成功"
                      : "重置失败"}
              </h2>
              <p className="reset-dialog__message" role={dialogState === "error" ? "alert" : undefined}>
                {dialogState === "confirm"
                  ? "确定使用这张重置卡吗？此操作可能无法撤销。"
                  : dialogState === "loading"
                    ? "请稍候，正在等待 Codex 确认重置结果。"
                    : dialogState === "success"
                      ? "Codex 已确认重置完成，正在刷新用量。"
                      : resetError}
              </p>
              <div className="reset-dialog__card">
                <span className="reset-dialog__card-icon"><TicketIcon /></span>
                <span>重置卡有效期还剩</span>
                <strong>{expiryDaysLabel(selectedCard, now)}</strong>
              </div>
              <div className={`reset-dialog__actions reset-dialog__actions--${dialogState}`}>
                {dialogState === "success" ? (
                  <button className="reset-dialog__primary" type="button" onClick={closeResetDialog}>
                    确定
                  </button>
                ) : (
                  <>
                    <button
                      className="reset-dialog__secondary"
                      type="button"
                      disabled={dialogState === "loading"}
                      onClick={closeResetDialog}
                    >
                      取消
                    </button>
                    {dialogState !== "loading" && (
                      <button
                        className="reset-dialog__primary"
                        type="button"
                        onClick={() => void confirmReset()}
                        disabled={selectedCard.expiresAt !== null && selectedCard.expiresAt <= now / 1000}
                      >
                        {dialogState === "error" ? "重试" : "确认重置"}
                      </button>
                    )}
                    {dialogState === "loading" && (
                      <button className="reset-dialog__primary" type="button" disabled>
                        <span className="reset-dialog__spinner reset-dialog__spinner--button" aria-hidden="true" />
                        正在使用重置卡…
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
