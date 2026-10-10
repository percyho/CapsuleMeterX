use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{IconMenuItem, Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

const CAPSULE_LABEL: &str = "capsule";
const TOOLTIP_LABEL: &str = "tooltip";
const STATISTICS_LABEL: &str = "statistics";
const TRAY_ID: &str = "capsulemeterx-tray";
const ICON_SIZE: u32 = 32;
const CAPSULE_WIDTH: f64 = 120.0;
const CAPSULE_HEIGHT: f64 = 32.0;
const TOOLTIP_WIDTH: f64 = 360.0;
const TOOLTIP_MIN_WIDTH: f64 = 220.0;
const TOOLTIP_HEIGHT: f64 = 420.0;
const TOOLTIP_MIN_HEIGHT: f64 = 80.0;
const POLL_INTERVAL: Duration = Duration::from_secs(120);
const FAST_MODE_POLL_INTERVAL: Duration = Duration::from_secs(10);
const SNAP_THRESHOLD: f64 = 24.0;
const CODEX_TASK_MONITOR_OWNER: &str = "CapsuleMeterXCodexTaskMonitor";
const CODEX_TASK_MONITOR_SCRIPT: &str = include_str!("../resources/codex-task-monitor.ps1");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageWindow {
    id: String,
    label: String,
    used_percent: u8,
    remaining_percent: u8,
    window_duration_mins: u64,
    resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetCardExpiry {
    id: Option<String>,
    reset_type: String,
    status: String,
    expires_at: Option<i64>,
    expiry_details_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSnapshot {
    status: String,
    connection_error: Option<String>,
    plan_name: String,
    five_hour: Option<UsageWindow>,
    weekly: Option<UsageWindow>,
    reset_cards_available: Option<u64>,
    reset_cards: Vec<ResetCardExpiry>,
    next_reset_card_expires_at: Option<i64>,
    reset_card_expiry_details_available: bool,
    reset_cards_never_expire: bool,
    fast_mode_enabled: Option<bool>,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            status: "loading".into(),
            connection_error: None,
            plan_name: "ChatGPT".into(),
            five_hour: None,
            weekly: None,
            reset_cards_available: None,
            reset_cards: Vec::new(),
            next_reset_card_expires_at: None,
            reset_card_expiry_details_available: false,
            reset_cards_never_expire: false,
            fast_mode_enabled: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StartupSettings {
    start_with_windows: bool,
    capsule_opacity_percent: u8,
    capsule_always_on_top: bool,
    refresh_interval_minutes: u8,
    low_balance_alert_enabled: bool,
    low_balance_threshold_percent: u8,
    usage_pace_alert_enabled: bool,
    usage_pace_alert_threshold: String,
    auto_shutdown_on_codex_complete: bool,
}

impl Default for StartupSettings {
    fn default() -> Self {
        Self {
            start_with_windows: false,
            capsule_opacity_percent: 100,
            capsule_always_on_top: true,
            refresh_interval_minutes: 2,
            low_balance_alert_enabled: false,
            low_balance_threshold_percent: 20,
            usage_pace_alert_enabled: false,
            usage_pace_alert_threshold: "very-fast".into(),
            auto_shutdown_on_codex_complete: false,
        }
    }
}

impl StartupSettings {
    fn normalized(mut self) -> Self {
        self.capsule_opacity_percent = self.capsule_opacity_percent.clamp(40, 100);
        self.refresh_interval_minutes = match self.refresh_interval_minutes {
            1 | 2 | 5 | 10 => self.refresh_interval_minutes,
            _ => 2,
        };
        self.low_balance_threshold_percent = self.low_balance_threshold_percent.clamp(5, 50);
        if self.usage_pace_alert_threshold != "fast"
            && self.usage_pace_alert_threshold != "very-fast"
        {
            self.usage_pace_alert_threshold = "very-fast".into();
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaHistorySample {
    sampled_at: i64,
    five_hour_remaining_percent: Option<u8>,
    five_hour_resets_at: Option<i64>,
    weekly_remaining_percent: Option<u8>,
    weekly_resets_at: Option<i64>,
    data_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TokenDailyBucket {
    start_date: String,
    tokens: i64,
    data_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TokenUsageSummary {
    lifetime_tokens: Option<i64>,
    peak_daily_tokens: Option<i64>,
    longest_running_turn_sec: Option<i64>,
    current_streak_days: Option<i64>,
    longest_streak_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TokenUsageHistory {
    summary: TokenUsageSummary,
    daily_usage_buckets: Vec<TokenDailyBucket>,
    updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StatisticsData {
    quota_samples: Vec<QuotaHistorySample>,
    token_usage: TokenUsageHistory,
    token_error: Option<String>,
    token_fetch_pending: bool,
}

struct ConsumeResetCardRequest {
    credit_id: String,
    idempotency_key: String,
    response: Sender<Result<String, String>>,
    _guard: ActiveResetCardGuard,
}

struct ActiveResetCardGuard {
    credit_id: String,
    active_cards: Arc<Mutex<HashSet<String>>>,
}

impl Drop for ActiveResetCardGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_cards.lock() {
            active.remove(&self.credit_id);
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TrayAnchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct AppState {
    usage: Mutex<UsageSnapshot>,
    refresh_tx: Sender<()>,
    token_refresh_tx: Sender<()>,
    consume_reset_tx: Sender<ConsumeResetCardRequest>,
    statistics: Mutex<StatisticsData>,
    consuming_reset_cards: Arc<Mutex<HashSet<String>>>,
    tooltip_epoch: Arc<AtomicU64>,
    tray_anchor: Mutex<Option<TrayAnchor>>,
    drag_watch_active: Arc<AtomicBool>,
    server_child: Mutex<Option<Arc<Mutex<Child>>>>,
    startup_settings: Mutex<StartupSettings>,
}

impl AppState {
    fn new(
        refresh_tx: Sender<()>,
        token_refresh_tx: Sender<()>,
        consume_reset_tx: Sender<ConsumeResetCardRequest>,
    ) -> Self {
        Self {
            usage: Mutex::new(UsageSnapshot::default()),
            refresh_tx,
            token_refresh_tx,
            consume_reset_tx,
            statistics: Mutex::new(StatisticsData::default()),
            consuming_reset_cards: Arc::new(Mutex::new(HashSet::new())),
            tooltip_epoch: Arc::new(AtomicU64::new(0)),
            tray_anchor: Mutex::new(None),
            drag_watch_active: Arc::new(AtomicBool::new(false)),
            server_child: Mutex::new(None),
            startup_settings: Mutex::new(StartupSettings::default()),
        }
    }
}

#[tauri::command]
fn get_usage_snapshot(state: State<'_, AppState>) -> UsageSnapshot {
    state
        .usage
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn get_statistics_data(state: State<'_, AppState>) -> StatisticsData {
    state
        .statistics
        .lock()
        .map(|statistics| statistics.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn get_startup_settings(state: State<'_, AppState>) -> StartupSettings {
    state
        .startup_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_startup_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: StartupSettings,
) -> Result<StartupSettings, String> {
    let settings = settings.normalized();
    let previous = state
        .startup_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default();

    if previous.start_with_windows != settings.start_with_windows {
        let autostart = app.autolaunch();
        if settings.start_with_windows {
            autostart.enable().map_err(|error| error.to_string())?;
        } else {
            autostart.disable().map_err(|error| error.to_string())?;
        }
    }

    if let Some(capsule) = app.get_webview_window(CAPSULE_LABEL) {
        capsule
            .set_always_on_top(settings.capsule_always_on_top)
            .map_err(|error| error.to_string())?;
    }

    if previous.auto_shutdown_on_codex_complete != settings.auto_shutdown_on_codex_complete {
        configure_codex_task_monitor(&app, settings.auto_shutdown_on_codex_complete)?;
    }

    if let Err(error) = save_startup_settings(&app, &settings) {
        if previous.auto_shutdown_on_codex_complete != settings.auto_shutdown_on_codex_complete {
            let _ = configure_codex_task_monitor(&app, previous.auto_shutdown_on_codex_complete);
        }
        return Err(error);
    }
    if let Ok(mut current) = state.startup_settings.lock() {
        *current = settings.clone();
    }
    if previous.refresh_interval_minutes != settings.refresh_interval_minutes {
        let _ = state.refresh_tx.send(());
    }
    if !settings.auto_shutdown_on_codex_complete {
        let _ = cancel_auto_shutdown_inner(&app);
    }
    let _ = app.emit("app-settings-updated", settings.clone());

    Ok(settings)
}

#[tauri::command]
fn cancel_auto_shutdown(app: AppHandle) -> Result<bool, String> {
    cancel_auto_shutdown_inner(&app)
}

#[tauri::command]
fn show_statistics_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    hide_tooltip_window(&app);
    let window = app
        .get_webview_window(STATISTICS_LABEL)
        .ok_or_else(|| "Statistics window is unavailable".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    request_token_usage_refresh(&app, &state)
}

#[tauri::command]
fn hide_statistics_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(STATISTICS_LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn refresh_statistics_token_usage(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    request_token_usage_refresh(&app, &state)
}

#[tauri::command]
fn save_statistics_csv(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("csv"))
    {
        return Err("Please choose a .csv file".into());
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn request_token_usage_refresh(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if let Ok(mut statistics) = state.statistics.lock() {
        statistics.token_fetch_pending = true;
        statistics.token_error = None;
    }
    publish_statistics(app);
    if let Err(error) = state.token_refresh_tx.send(()) {
        set_token_fetch_error(app, format!("Codex App Server is unavailable: {error}"));
        return Err(error.to_string());
    }
    Ok(())
}

fn statistics_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(name))
}

fn startup_settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    statistics_file(app, "startup-settings.json")
}

fn load_startup_settings(app: &AppHandle) -> StartupSettings {
    startup_settings_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<StartupSettings>(&contents).ok())
        .unwrap_or_default()
        .normalized()
}

fn configured_poll_interval(app: &AppHandle) -> Duration {
    app.try_state::<AppState>()
        .and_then(|state| {
            state.startup_settings.lock().ok().map(|settings| {
                Duration::from_secs(u64::from(settings.refresh_interval_minutes) * 60)
            })
        })
        .unwrap_or(POLL_INTERVAL)
}

fn save_startup_settings(app: &AppHandle, settings: &StartupSettings) -> Result<(), String> {
    let path = startup_settings_file(app)?;
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn codex_task_monitor_paths(
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok((
        directory.join("codex-task-monitor.ps1"),
        directory.join("codex-task-monitor-state.json"),
        directory.join("codex-shutdown-pending.json"),
        directory.join("codex-task-monitor.enabled"),
    ))
}

fn codex_hooks_file(app: &AppHandle) -> Result<PathBuf, String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").map(|path| PathBuf::from(path).join(".codex")))
        .or_else(|| app.path().home_dir().ok().map(|path| path.join(".codex")))
        .ok_or_else(|| "Could not locate the Codex home directory".to_owned())?;
    Ok(home.join("hooks.json"))
}

fn hook_entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|handlers| {
            handlers.iter().any(|handler| {
                handler
                    .get("command")
                    .or_else(|| handler.get("commandWindows"))
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(CODEX_TASK_MONITOR_OWNER))
            })
        })
}

fn quoted_hook_path(path: &std::path::Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

fn configure_codex_task_monitor(app: &AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(not(windows))]
    if enabled {
        return Err("Codex task shutdown monitoring is available only on Windows".into());
    }

    let (script_path, state_path, pending_path, enabled_path) = codex_task_monitor_paths(app)?;
    if enabled {
        fs::write(&script_path, CODEX_TASK_MONITOR_SCRIPT).map_err(|error| error.to_string())?;
    }

    let hooks_path = codex_hooks_file(app)?;
    if !enabled && !hooks_path.exists() {
        let _ = fs::remove_file(&enabled_path);
        return Ok(());
    }
    if enabled {
        if let Some(parent) = hooks_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }

    let mut document = if hooks_path.exists() {
        let contents = fs::read_to_string(&hooks_path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&contents)
            .map_err(|error| format!("Could not read Codex hooks.json: {error}"))?
    } else {
        json!({})
    };
    let root = document
        .as_object_mut()
        .ok_or_else(|| "Codex hooks.json must contain a JSON object".to_owned())?;

    if enabled {
        let hooks = root.entry("hooks").or_insert_with(|| json!({}));
        let events = hooks
            .as_object_mut()
            .ok_or_else(|| "The hooks value in Codex hooks.json must be an object".to_owned())?;
        for (event, timeout) in [
            ("UserPromptSubmit", 3),
            ("Stop", 45),
            ("Interrupt", 3),
            ("SessionEnd", 3),
        ] {
            let command = format!(
                "powershell.exe -WindowStyle Hidden -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {} -Event {} -StatePath {} -PendingPath {} -EnabledPath {} -Owner {}",
                quoted_hook_path(&script_path),
                event,
                quoted_hook_path(&state_path),
                quoted_hook_path(&pending_path),
                quoted_hook_path(&enabled_path),
                CODEX_TASK_MONITOR_OWNER,
            );
            let entries = events
                .entry(event.to_owned())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| format!("Codex hook event {event} must contain an array"))?;
            entries.retain(|entry| !hook_entry_is_ours(entry));
            entries.push(json!({
                "hooks": [{
                    "type": "command",
                    "command": command.clone(),
                    "commandWindows": command,
                    "async": true,
                    "timeout": timeout,
                    "statusMessage": "CapsuleMeterX 正在监听 Codex 任务"
                }]
            }));
        }
    } else {
        let Some(events) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
            let _ = fs::remove_file(&enabled_path);
            return Ok(());
        };
        let mut empty_events = Vec::new();
        for (event, entries) in events.iter_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| !hook_entry_is_ours(entry));
                if entries.is_empty() {
                    empty_events.push(event.clone());
                }
            }
        }
        for event in empty_events {
            events.remove(&event);
        }
    }

    let contents = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    let temporary_path = hooks_path.with_extension("json.tmp");
    fs::write(&temporary_path, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary_path, &hooks_path).map_err(|error| error.to_string())?;

    if enabled {
        fs::write(&enabled_path, b"enabled").map_err(|error| error.to_string())?;
    } else {
        let _ = fs::remove_file(&enabled_path);
    }
    Ok(())
}

fn cancel_auto_shutdown_inner(app: &AppHandle) -> Result<bool, String> {
    let (_, _, pending_path, _) = codex_task_monitor_paths(app)?;
    if !pending_path.exists() {
        return Ok(false);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = Command::new("shutdown.exe")
            .arg("/a")
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|error| error.to_string())?;
        let _ = fs::remove_file(pending_path);
        Ok(status.success())
    }

    #[cfg(not(windows))]
    {
        let _ = fs::remove_file(pending_path);
        Ok(false)
    }
}

fn load_statistics(app: &AppHandle) -> StatisticsData {
    let mut statistics = StatisticsData::default();
    if let Ok(path) = statistics_file(app, "quota-history.jsonl") {
        if let Ok(contents) = fs::read_to_string(path) {
            statistics.quota_samples = contents
                .lines()
                .filter_map(|line| serde_json::from_str::<QuotaHistorySample>(line).ok())
                .collect();
            statistics
                .quota_samples
                .sort_by_key(|sample| sample.sampled_at);
        }
    }
    if let Ok(path) = statistics_file(app, "token-usage.json") {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(history) = serde_json::from_str::<TokenUsageHistory>(&contents) {
                statistics.token_usage = history;
            }
        }
    }
    statistics
}

fn publish_statistics(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(window) = app.get_webview_window(STATISTICS_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(statistics) = state.statistics.lock() else {
        return;
    };
    let _ = app.emit("statistics-updated", statistics.clone());
}

fn publish_quota_sample(app: &AppHandle, sample: QuotaHistorySample) {
    let visible = app
        .get_webview_window(STATISTICS_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        let _ = app.emit("statistics-quota-sample", sample);
    }
}

fn now_epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn record_quota_sample(app: &AppHandle, snapshot: &UsageSnapshot) {
    if snapshot.five_hour.is_none() && snapshot.weekly.is_none() {
        return;
    }
    let sample = QuotaHistorySample {
        sampled_at: now_epoch_millis(),
        five_hour_remaining_percent: snapshot
            .five_hour
            .as_ref()
            .map(|window| window.remaining_percent),
        five_hour_resets_at: snapshot
            .five_hour
            .as_ref()
            .and_then(|window| window.resets_at),
        weekly_remaining_percent: snapshot
            .weekly
            .as_ref()
            .map(|window| window.remaining_percent),
        weekly_resets_at: snapshot.weekly.as_ref().and_then(|window| window.resets_at),
        data_source: "codex-app-server/account/rateLimits/read".into(),
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut statistics) = state.statistics.lock() else {
        return;
    };
    if statistics
        .quota_samples
        .binary_search_by_key(&sample.sampled_at, |existing| existing.sampled_at)
        .is_ok()
    {
        return;
    }
    let Ok(path) = statistics_file(app, "quota-history.jsonl") else {
        eprintln!("Could not resolve the quota history path");
        return;
    };
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        eprintln!("Could not open the quota history file");
        return;
    };
    if serde_json::to_writer(&mut file, &sample).is_err() || writeln!(file).is_err() {
        eprintln!("Could not persist the quota history sample");
        return;
    }
    statistics.quota_samples.push(sample.clone());
    statistics
        .quota_samples
        .sort_by_key(|entry| entry.sampled_at);
    drop(statistics);
    publish_quota_sample(app, sample);
}

fn set_token_fetch_error(app: &AppHandle, error: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut statistics) = state.statistics.lock() {
            statistics.token_fetch_pending = false;
            statistics.token_error = Some(error);
        }
    }
    publish_statistics(app);
}

fn save_token_usage(app: &AppHandle, history: &TokenUsageHistory) {
    let Ok(path) = statistics_file(app, "token-usage.json") else {
        set_token_fetch_error(app, "Could not resolve the Token history path".into());
        return;
    };
    let Ok(contents) = serde_json::to_vec_pretty(history) else {
        set_token_fetch_error(app, "Could not serialize Token history".into());
        return;
    };
    if let Err(error) = fs::write(path, contents) {
        set_token_fetch_error(app, format!("Could not save Token history: {error}"));
    }
}

fn update_token_usage(app: &AppHandle, result: &Value) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut statistics) = state.statistics.lock() else {
        return;
    };
    let summary = result.get("summary").unwrap_or(&Value::Null);
    let current = &mut statistics.token_usage.summary;
    if let Some(value) = summary.get("lifetimeTokens").and_then(Value::as_i64) {
        current.lifetime_tokens = Some(value);
    }
    if let Some(value) = summary.get("peakDailyTokens").and_then(Value::as_i64) {
        current.peak_daily_tokens = Some(value);
    }
    if let Some(value) = summary.get("longestRunningTurnSec").and_then(Value::as_i64) {
        current.longest_running_turn_sec = Some(value);
    }
    if let Some(value) = summary.get("currentStreakDays").and_then(Value::as_i64) {
        current.current_streak_days = Some(value);
    }
    if let Some(value) = summary.get("longestStreakDays").and_then(Value::as_i64) {
        current.longest_streak_days = Some(value);
    }
    if let Some(buckets) = result.get("dailyUsageBuckets").and_then(Value::as_array) {
        for bucket in buckets {
            let Some(start_date) = bucket.get("startDate").and_then(Value::as_str) else {
                continue;
            };
            let Some(tokens) = bucket.get("tokens").and_then(Value::as_i64) else {
                continue;
            };
            let daily = TokenDailyBucket {
                start_date: start_date.to_owned(),
                tokens,
                data_source: "codex-app-server/account/usage/read".into(),
            };
            if let Some(existing) = statistics
                .token_usage
                .daily_usage_buckets
                .iter_mut()
                .find(|existing| existing.start_date == daily.start_date)
            {
                *existing = daily;
            } else {
                statistics.token_usage.daily_usage_buckets.push(daily);
            }
        }
        statistics
            .token_usage
            .daily_usage_buckets
            .sort_by(|left, right| left.start_date.cmp(&right.start_date));
    }
    statistics.token_usage.updated_at = Some(now_epoch_millis());
    statistics.token_error = None;
    statistics.token_fetch_pending = false;
    let history = statistics.token_usage.clone();
    drop(statistics);
    save_token_usage(app, &history);
    publish_statistics(app);
}

#[tauri::command]
async fn consume_reset_card(
    state: State<'_, AppState>,
    credit_id: String,
    idempotency_key: String,
) -> Result<String, String> {
    if credit_id.trim().is_empty() || idempotency_key.trim().is_empty() {
        return Err("重置卡信息无效，请刷新用量后重试。".into());
    }

    {
        let mut active = state
            .consuming_reset_cards
            .lock()
            .map_err(|error| error.to_string())?;
        if !active.insert(credit_id.clone()) {
            return Err("这张重置卡正在处理中，请稍候。".into());
        }
    }

    let active_cards = Arc::clone(&state.consuming_reset_cards);
    let consume_reset_tx = state.consume_reset_tx.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (response_tx, response_rx) = mpsc::channel();
        let guard = ActiveResetCardGuard {
            credit_id: credit_id.clone(),
            active_cards,
        };
        consume_reset_tx
            .send(ConsumeResetCardRequest {
                credit_id,
                idempotency_key,
                response: response_tx,
                _guard: guard,
            })
            .map_err(|_| "Codex App Server 尚未就绪，请稍后重试。".to_owned())?;
        response_rx
            .recv_timeout(Duration::from_secs(35))
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => {
                    "等待 Codex 确认重置结果超时。请稍后刷新用量，再决定是否重试。".to_owned()
                }
                RecvTimeoutError::Disconnected => {
                    "Codex App Server 连接已断开，重置结果未能确认。请刷新用量后再试。".to_owned()
                }
            })?
    })
    .await
    .map_err(|error| error.to_string())?;

    if matches!(result.as_deref(), Ok("reset" | "alreadyRedeemed")) {
        let _ = state.refresh_tx.send(());
    }
    result
}

#[tauri::command]
fn show_usage_tooltip(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    clear_tray_anchor(&state);
    let _ = app.emit("usage-tooltip-mode", "details");
    show_tooltip_window(&app, &state.tooltip_epoch, None)
}

#[tauri::command]
fn show_tray_usage_details(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let anchor = (*state
        .tray_anchor
        .lock()
        .map_err(|error| error.to_string())?)
    .filter(|anchor| anchor.width > 0.0 && anchor.height > 0.0);
    let Some(anchor) = anchor else {
        clear_tray_anchor(&state);
        let _ = app.emit("usage-tooltip-mode", "details");
        return show_tooltip_window(&app, &state.tooltip_epoch, None);
    };

    show_tray_tooltip_window(&app, &state, anchor, "details", None)
}

#[tauri::command]
fn resize_usage_tooltip(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(tooltip) = app.get_webview_window(TOOLTIP_LABEL) else {
        return Err("Tooltip window is unavailable".into());
    };
    let Some(capsule) = app.get_webview_window(CAPSULE_LABEL) else {
        return Err("Capsule window is unavailable".into());
    };

    let tray_anchor = app
        .try_state::<AppState>()
        .and_then(|state| state.tray_anchor.lock().ok().and_then(|anchor| *anchor));
    let monitor = tray_anchor
        .and_then(|anchor| {
            app.monitor_from_point(
                anchor.x + anchor.width / 2.0,
                anchor.y + anchor.height / 2.0,
            )
            .ok()
            .flatten()
        })
        .or_else(|| capsule.current_monitor().ok().flatten());
    let max_height = monitor
        .map(|monitor| monitor.work_area().size.height as f64 / monitor.scale_factor())
        .unwrap_or(f64::MAX);
    let width = if width.is_finite() {
        width.clamp(TOOLTIP_MIN_WIDTH, TOOLTIP_WIDTH)
    } else {
        TOOLTIP_WIDTH
    };
    let height = if height.is_finite() {
        height.clamp(TOOLTIP_MIN_HEIGHT, max_height.max(TOOLTIP_MIN_HEIGHT))
    } else {
        TOOLTIP_HEIGHT
    };

    tooltip
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    if let Some(anchor) = tray_anchor {
        position_tray_tooltip(&app, &tooltip, anchor);
    } else {
        position_tooltip(&capsule, &tooltip);
    }
    Ok(())
}

fn show_tooltip_window(
    app: &AppHandle,
    tooltip_epoch: &Arc<AtomicU64>,
    auto_hide_after: Option<Duration>,
) -> Result<(), String> {
    let _ = app.emit("usage-tooltip-mode", "details");
    let Some(capsule) = app.get_webview_window(CAPSULE_LABEL) else {
        return Err("Capsule window is unavailable".into());
    };
    let Some(tooltip) = app.get_webview_window(TOOLTIP_LABEL) else {
        return Err("Tooltip window is unavailable".into());
    };

    position_tooltip(&capsule, &tooltip);
    let _ = tooltip.set_always_on_top(true);
    tooltip.show().map_err(|error| error.to_string())?;

    let epoch = tooltip_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(delay) = auto_hide_after {
        let app = app.clone();
        let guard = Arc::clone(tooltip_epoch);
        thread::spawn(move || {
            thread::sleep(delay);
            if guard.load(Ordering::SeqCst) == epoch {
                hide_tooltip_window(&app);
            }
        });
    }

    Ok(())
}

fn show_tray_tooltip_window(
    app: &AppHandle,
    state: &AppState,
    anchor: TrayAnchor,
    mode: &str,
    auto_hide_after: Option<Duration>,
) -> Result<(), String> {
    if let Ok(mut current_anchor) = state.tray_anchor.lock() {
        *current_anchor = Some(anchor);
    }
    let _ = app.emit("usage-tooltip-mode", mode);

    let Some(tooltip) = app.get_webview_window(TOOLTIP_LABEL) else {
        return Err("Tooltip window is unavailable".into());
    };
    position_tray_tooltip(app, &tooltip, anchor);
    let _ = tooltip.set_always_on_top(true);
    tooltip.show().map_err(|error| error.to_string())?;

    let epoch = state.tooltip_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(delay) = auto_hide_after {
        let app = app.clone();
        let guard = Arc::clone(&state.tooltip_epoch);
        thread::spawn(move || {
            thread::sleep(delay);
            if guard.load(Ordering::SeqCst) == epoch {
                hide_tooltip_window(&app);
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn keep_usage_tooltip(state: State<'_, AppState>) {
    state.tooltip_epoch.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn hide_usage_tooltip(app: AppHandle, state: State<'_, AppState>, delay_ms: u64) {
    let epoch = state.tooltip_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let guard = Arc::clone(&state.tooltip_epoch);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        if guard.load(Ordering::SeqCst) == epoch {
            hide_tooltip_window(&app);
        }
    });
}

fn clear_tray_anchor(state: &AppState) {
    if let Ok(mut anchor) = state.tray_anchor.lock() {
        *anchor = None;
    }
}

fn tray_anchor_from_rect(rect: Rect) -> TrayAnchor {
    let position = rect.position.to_physical::<f64>(1.0);
    let size = rect.size.to_physical::<f64>(1.0);
    TrayAnchor {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

#[tauri::command]
fn finish_capsule_drag(app: AppHandle) {
    snap_capsule_to_edges(&app);
}

#[tauri::command]
fn resize_capsule(app: AppHandle, width: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPSULE_LABEL) else {
        return Err("Capsule window is unavailable".into());
    };
    let width = if width.is_finite() {
        width.clamp(64.0, 280.0)
    } else {
        CAPSULE_WIDTH
    };
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let current_size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = window.current_monitor().ok().flatten();
    let edge = monitor.as_ref().map(|monitor| {
        let area = monitor.work_area();
        let left = area.position.x;
        let right = left + area.size.width as i32;
        let scale = monitor.scale_factor();
        let current_right = position.x + current_size.width as i32;
        let pinned_left = (position.x - left).abs() <= 2;
        let pinned_right = (right - current_right).abs() <= 2;
        (left, right, scale, pinned_left, pinned_right)
    });

    window
        .set_size(LogicalSize::new(width, CAPSULE_HEIGHT))
        .map_err(|error| error.to_string())?;

    if let Some((left, right, scale, pinned_left, pinned_right)) = edge {
        let new_width = (width * scale).round() as i32;
        let x = if pinned_right {
            right - new_width
        } else if pinned_left {
            left
        } else {
            position.x
        }
        .clamp(left, (right - new_width).max(left));
        if x != position.x {
            window
                .set_position(PhysicalPosition::new(x, position.y))
                .map_err(|error| error.to_string())?;
        }
    }
    if let Ok(position) = window.outer_position() {
        save_capsule_position(&app, position);
    }
    Ok(())
}

fn hide_tooltip_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TOOLTIP_LABEL) {
        let _ = window.hide();
    }
    if let Some(state) = app.try_state::<AppState>() {
        clear_tray_anchor(&state);
    }
}

fn position_tray_tooltip(app: &AppHandle, tooltip: &tauri::WebviewWindow, anchor: TrayAnchor) {
    let monitor = app
        .monitor_from_point(
            anchor.x + anchor.width / 2.0,
            anchor.y + anchor.height / 2.0,
        )
        .ok()
        .flatten()
        .or_else(|| tooltip.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let Ok(tooltip_size) = tooltip.outer_size() else {
        return;
    };

    let scale = monitor.scale_factor();
    let tooltip_width = tooltip_size.width as i32;
    let tooltip_height = tooltip_size.height as i32;
    let work_area = monitor.work_area();
    let left = work_area.position.x;
    let top = work_area.position.y;
    let right = left + work_area.size.width as i32;
    let bottom = top + work_area.size.height as i32;
    let anchor_left = anchor.x.round() as i32;
    let anchor_top = anchor.y.round() as i32;
    let anchor_width = anchor.width.round() as i32;
    let anchor_height = anchor.height.round() as i32;
    let gap = (8.0 * scale).round() as i32;

    let mut x = anchor_left + anchor_width / 2 - tooltip_width / 2;
    x = x.clamp(left, (right - tooltip_width).max(left));
    let above = anchor_top - tooltip_height - gap;
    let below = anchor_top + anchor_height + gap;
    let y = if above >= top {
        above
    } else if below + tooltip_height <= bottom {
        below
    } else {
        above.clamp(top, (bottom - tooltip_height).max(top))
    };

    let _ = tooltip.set_position(PhysicalPosition::new(x, y));
}

fn position_tooltip(capsule: &tauri::WebviewWindow, tooltip: &tauri::WebviewWindow) {
    let Ok(capsule_position) = capsule.outer_position() else {
        return;
    };
    let Ok(Some(monitor)) = capsule.current_monitor() else {
        return;
    };

    let scale = monitor.scale_factor();
    let Ok(capsule_size) = capsule.outer_size() else {
        return;
    };
    let capsule_width = capsule_size.width as i32;
    let capsule_height = capsule_size.height as i32;
    let Ok(tooltip_size) = tooltip.outer_size() else {
        return;
    };
    let tooltip_width = tooltip_size.width as i32;
    let tooltip_height = tooltip_size.height as i32;
    let work_area = monitor.work_area();
    let left = work_area.position.x;
    let top = work_area.position.y;
    let right = left + work_area.size.width as i32;
    let bottom = top + work_area.size.height as i32;

    let mut x = capsule_position.x;
    if x + tooltip_width > right {
        x = capsule_position.x + capsule_width - tooltip_width;
    }
    x = x.clamp(left, (right - tooltip_width).max(left));

    let below = capsule_position.y + capsule_height + (8.0 * scale).round() as i32;
    let above = capsule_position.y - tooltip_height - (8.0 * scale).round() as i32;
    let y = if below + tooltip_height <= bottom {
        below
    } else if above >= top {
        above
    } else {
        below.clamp(top, (bottom - tooltip_height).max(top))
    };

    let _ = tooltip.set_position(PhysicalPosition::new(x, y));
}

fn save_capsule_position(app: &AppHandle, position: PhysicalPosition<i32>) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("capsule-position.json");
    let saved = SavedPosition {
        x: position.x,
        y: position.y,
    };
    if let Ok(contents) = serde_json::to_vec(&saved) {
        let _ = fs::write(path, contents);
    }
}

fn snap_capsule_to_edges(app: &AppHandle) {
    let Some(window) = app.get_webview_window(CAPSULE_LABEL) else {
        return;
    };
    let (Ok(position), Ok(Some(monitor)), Ok(size)) = (
        window.outer_position(),
        window.current_monitor(),
        window.outer_size(),
    ) else {
        return;
    };

    let scale = monitor.scale_factor();
    let width = size.width as i32;
    let height = size.height as i32;
    let threshold = (SNAP_THRESHOLD * scale).round() as i32;
    let area = monitor.work_area();
    let left = area.position.x;
    let top = area.position.y;
    let right = left + area.size.width as i32;
    let bottom = top + area.size.height as i32;
    let max_x = (right - width).max(left);
    let max_y = (bottom - height).max(top);

    let mut x = position.x.clamp(left, max_x);
    let mut y = position.y.clamp(top, max_y);
    if x - left <= threshold {
        x = left;
    } else if max_x - x <= threshold {
        x = max_x;
    }
    if y - top <= threshold {
        y = top;
    } else if max_y - y <= threshold {
        y = max_y;
    }

    let snapped = PhysicalPosition::new(x, y);
    if snapped != position {
        let _ = window.set_position(snapped);
    }
    save_capsule_position(app, snapped);
}

fn start_drag_release_watcher(app: &AppHandle, active: &Arc<AtomicBool>) {
    if !left_mouse_button_is_down()
        || active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }

    let app = app.clone();
    let active = Arc::clone(active);
    thread::spawn(move || {
        loop {
            while left_mouse_button_is_down() {
                thread::sleep(Duration::from_millis(30));
            }
            thread::sleep(Duration::from_millis(80));
            if !left_mouse_button_is_down() {
                break;
            }
        }
        snap_capsule_to_edges(&app);
        active.store(false, Ordering::Release);
    });
}

#[cfg(windows)]
fn left_mouse_button_is_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 }
}

#[cfg(not(windows))]
fn left_mouse_button_is_down() -> bool {
    false
}

fn load_capsule_position(app: &AppHandle) -> Option<SavedPosition> {
    let path = app
        .path()
        .app_data_dir()
        .ok()?
        .join("capsule-position.json");
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn place_capsule(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }

    let saved = load_capsule_position(app);
    let monitor = saved
        .and_then(|position| {
            monitors
                .iter()
                .find(|monitor| {
                    let area = monitor.work_area();
                    let right = area.position.x + area.size.width as i32;
                    let bottom = area.position.y + area.size.height as i32;
                    position.x >= area.position.x
                        && position.x < right
                        && position.y >= area.position.y
                        && position.y < bottom
                })
                .cloned()
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .unwrap_or_else(|| monitors[0].clone());

    let scale = monitor.scale_factor();
    let width = (CAPSULE_WIDTH * scale).round() as i32;
    let height = (CAPSULE_HEIGHT * scale).round() as i32;
    let area = monitor.work_area();
    let left = area.position.x;
    let top = area.position.y;
    let right = left + area.size.width as i32;
    let bottom = top + area.size.height as i32;

    let (x, y) = if let Some(saved) = saved {
        (
            saved.x.clamp(left, (right - width).max(left)),
            saved.y.clamp(top, (bottom - height).max(top)),
        )
    } else {
        (
            (right - width - (16.0 * scale).round() as i32).max(left),
            (top + (16.0 * scale).round() as i32).min((bottom - height).max(top)),
        )
    };

    let position = PhysicalPosition::new(x, y);
    let _ = window.set_position(position);
    save_capsule_position(app, position);
}

fn usage_icon(snapshot: &UsageSnapshot) -> Image<'static> {
    const SUBPIXEL_SAMPLES: usize = 4;
    const TRACK: [u8; 3] = [0x34, 0x3b, 0x46];
    const UNKNOWN: [u8; 3] = [0x8b, 0x93, 0x9e];

    let size = ICON_SIZE as usize;
    let mut pixels = vec![0_u8; size * size * 4];
    let remaining = if snapshot.status == "online" {
        snapshot
            .five_hour
            .as_ref()
            .map(|window| window.remaining_percent.min(100))
    } else {
        None
    };
    let progress = match remaining {
        Some(value) if value >= 60 => [0x19, 0xe6, 0xb5],
        Some(value) if value >= 30 => [0xff, 0xd4, 0x49],
        Some(value) if value >= 10 => [0xff, 0x92, 0x3f],
        Some(_) => [0xff, 0x4d, 0x68],
        None => UNKNOWN,
    };
    let center = 16.0_f32;
    let ring_radius = 11.5_f32;
    let ring_half_width = 1.75_f32;
    let sweep = remaining
        .map(|value| std::f32::consts::TAU * value as f32 / 100.0)
        .unwrap_or(0.0);
    let end_x = center + ring_radius * sweep.sin();
    let end_y = center - ring_radius * sweep.cos();
    let total_samples = (SUBPIXEL_SAMPLES * SUBPIXEL_SAMPLES) as u32;

    for y in 0..size {
        for x in 0..size {
            let mut stroke_samples = 0_u32;
            let mut progress_samples = 0_u32;
            for sample_y in 0..SUBPIXEL_SAMPLES {
                for sample_x in 0..SUBPIXEL_SAMPLES {
                    let px = x as f32 + (sample_x as f32 + 0.5) / SUBPIXEL_SAMPLES as f32;
                    let py = y as f32 + (sample_y as f32 + 0.5) / SUBPIXEL_SAMPLES as f32;
                    let dx = px - center;
                    let dy = py - center;
                    let distance = (dx * dx + dy * dy).sqrt();
                    if (distance - ring_radius).abs() > ring_half_width {
                        continue;
                    }

                    stroke_samples += 1;
                    let active = match remaining {
                        None => true,
                        Some(0) => false,
                        Some(value) if value >= 100 => true,
                        Some(_) => {
                            let angle = (dy.atan2(dx) + std::f32::consts::FRAC_PI_2)
                                .rem_euclid(std::f32::consts::TAU);
                            let near_start =
                                dx * dx + (dy + ring_radius).powi(2) <= ring_half_width.powi(2);
                            let end_dx = px - end_x;
                            let end_dy = py - end_y;
                            let near_end =
                                end_dx * end_dx + end_dy * end_dy <= ring_half_width.powi(2);
                            angle <= sweep || near_start || near_end
                        }
                    };
                    if active {
                        progress_samples += 1;
                    }
                }
            }

            if stroke_samples == 0 {
                continue;
            }

            let track_samples = stroke_samples - progress_samples;
            let color = if remaining.is_none() {
                UNKNOWN
            } else {
                [
                    ((progress[0] as u32 * progress_samples + TRACK[0] as u32 * track_samples)
                        / stroke_samples) as u8,
                    ((progress[1] as u32 * progress_samples + TRACK[1] as u32 * track_samples)
                        / stroke_samples) as u8,
                    ((progress[2] as u32 * progress_samples + TRACK[2] as u32 * track_samples)
                        / stroke_samples) as u8,
                ]
            };
            let alpha = ((stroke_samples * 255 + total_samples / 2) / total_samples) as u8;
            let offset = (y * size + x) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[color[0], color[1], color[2], alpha]);
        }
    }

    Image::new_owned(pixels, ICON_SIZE, ICON_SIZE)
}

fn tray_remaining_percent(snapshot: &UsageSnapshot) -> Option<u8> {
    if snapshot.status != "online" {
        return None;
    }

    snapshot
        .five_hour
        .as_ref()
        .map(|window| window.remaining_percent.min(100))
}

fn refresh_menu_icon() -> Image<'static> {
    menu_icon_from_segments(&[
        (3.5, 7.1, 4.0, 5.4),
        (4.0, 5.4, 5.1, 4.0),
        (5.1, 4.0, 6.8, 3.2),
        (6.8, 3.2, 8.7, 3.0),
        (8.7, 3.0, 10.5, 3.5),
        (10.5, 3.5, 12.0, 4.7),
        (12.0, 4.7, 12.0, 2.4),
        (12.0, 4.7, 9.7, 4.7),
        (12.5, 8.9, 12.0, 10.4),
        (12.0, 10.4, 10.7, 11.9),
        (10.7, 11.9, 8.9, 12.7),
        (8.9, 12.7, 6.9, 12.4),
        (6.9, 12.4, 5.1, 11.4),
        (5.1, 11.4, 3.5, 9.9),
        (3.5, 9.9, 3.5, 12.2),
        (3.5, 9.9, 5.8, 9.9),
    ])
}

fn exit_menu_icon() -> Image<'static> {
    menu_icon_from_segments(&[
        (9.0, 3.0, 5.0, 3.0),
        (5.0, 3.0, 5.0, 13.0),
        (5.0, 13.0, 9.0, 13.0),
        (7.5, 8.0, 14.0, 8.0),
        (11.0, 5.0, 14.0, 8.0),
        (14.0, 8.0, 11.0, 11.0),
    ])
}

fn menu_icon_from_segments(segments: &[(f32, f32, f32, f32)]) -> Image<'static> {
    const SIZE: usize = 16;
    const COLOR: [u8; 3] = [126, 136, 147];
    let mut pixels = vec![0_u8; SIZE * SIZE * 4];

    for &(x1, y1, x2, y2) in segments {
        let dx = x2 - x1;
        let dy = y2 - y1;
        let length_squared = dx * dx + dy * dy;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                let projection = if length_squared == 0.0 {
                    0.0
                } else {
                    (((px - x1) * dx + (py - y1) * dy) / length_squared).clamp(0.0, 1.0)
                };
                let closest_x = x1 + projection * dx;
                let closest_y = y1 + projection * dy;
                let distance = ((px - closest_x).powi(2) + (py - closest_y).powi(2)).sqrt();
                let coverage = (1.25 - distance).clamp(0.0, 1.0);
                let offset = (y * SIZE + x) * 4;
                let alpha = (coverage * 255.0).round() as u8;
                if alpha > pixels[offset + 3] {
                    pixels[offset..offset + 4]
                        .copy_from_slice(&[COLOR[0], COLOR[1], COLOR[2], alpha]);
                }
            }
        }
    }

    Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

fn publish_usage(app: &AppHandle, snapshot: UsageSnapshot) {
    let mut update_tray_icon = true;
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut current) = state.usage.lock() {
            update_tray_icon =
                tray_remaining_percent(&current) != tray_remaining_percent(&snapshot);
            *current = snapshot.clone();
        }
    }

    if update_tray_icon {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_icon(Some(usage_icon(&snapshot)));
        }
    }

    let _ = app.emit("usage-updated", snapshot);
}

fn codex_executable(app: &AppHandle) -> Option<PathBuf> {
    std::env::var_os("CODEX_CLI_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            let binary = if cfg!(windows) {
                "codex/bin/codex.exe"
            } else {
                "codex/bin/codex"
            };
            app.path()
                .resolve(binary, BaseDirectory::Resource)
                .ok()
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            #[cfg(windows)]
            {
                let native_package = if cfg!(target_arch = "aarch64") {
                    "codex-win32-arm64"
                } else {
                    "codex-win32-x64"
                };
                let target = if cfg!(target_arch = "aarch64") {
                    "aarch64-pc-windows-msvc"
                } else {
                    "x86_64-pc-windows-msvc"
                };
                let mut package_roots = Vec::new();
                if let Some(app_data) = std::env::var_os("APPDATA") {
                    package_roots.push(
                        PathBuf::from(app_data)
                            .join("npm")
                            .join("node_modules")
                            .join("@openai"),
                    );
                }
                if let Some(path) = std::env::var_os("PATH") {
                    for bin_dir in std::env::split_paths(&path) {
                        let executable = bin_dir.join("codex.exe");
                        if executable.is_file() {
                            return Some(executable);
                        }
                        package_roots.push(bin_dir.join("node_modules").join("@openai"));
                    }
                }
                for package_root in package_roots {
                    let native_roots = [
                        package_root.join(native_package),
                        package_root
                            .join("codex")
                            .join("node_modules")
                            .join("@openai")
                            .join(native_package),
                    ];
                    for native_root in native_roots {
                        let vendor = native_root.join("vendor").join(target);
                        for relative in ["bin/codex.exe", "codex/codex.exe"] {
                            let path = vendor.join(relative);
                            if path.is_file() {
                                return Some(path);
                            }
                        }
                    }
                }
            }
            let local_app_data = std::env::var_os("LOCALAPPDATA")?;
            let path = PathBuf::from(local_app_data)
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("codex.exe");
            path.is_file().then_some(path)
        })
}

#[cfg(windows)]
fn codex_shim_directory() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(app_data).join("npm"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path));
    }
    candidates.into_iter().find(|directory| {
        directory.join("codex.cmd").is_file() || directory.join("codex.bat").is_file()
    })
}

fn codex_command(app: &AppHandle) -> Command {
    let mut command = if let Some(executable) = codex_executable(app) {
        let mut command = Command::new(executable);
        command.args(["app-server", "--listen", "stdio://"]);
        command
    } else {
        #[cfg(windows)]
        {
            if let Some(shim_directory) = codex_shim_directory() {
                let command_processor = std::env::var_os("COMSPEC")
                    .map(PathBuf::from)
                    .filter(|path| path.is_file())
                    .unwrap_or_else(|| PathBuf::from("cmd.exe"));
                let mut command = Command::new(command_processor);
                command.args(["/D", "/S", "/C", "codex app-server --listen stdio://"]);
                let mut search_paths = vec![shim_directory];
                if let Some(path) = std::env::var_os("PATH") {
                    search_paths.extend(std::env::split_paths(&path));
                }
                if let Ok(path) = std::env::join_paths(search_paths) {
                    command.env("PATH", path);
                }
                command
            } else {
                let mut command = Command::new("codex");
                command.args(["app-server", "--listen", "stdio://"]);
                command
            }
        }
        #[cfg(not(windows))]
        {
            let mut command = Command::new("codex");
            command.args(["app-server", "--listen", "stdio://"]);
            command
        }
    };

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    command
}

fn send_rpc(
    writer: &mut BufWriter<ChildStdin>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    serde_json::to_writer(
        &mut *writer,
        &json!({ "id": id, "method": method, "params": params }),
    )
    .map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn send_notification(writer: &mut BufWriter<ChildStdin>, method: &str) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, &json!({ "method": method }))
        .map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn spawn_server_reader(stdout: std::process::ChildStdout) -> Receiver<Result<Value, String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Err("Codex App Server closed its output".into()));
                    break;
                }
                Ok(_) => match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        if tx.send(Ok(message)).is_err() {
                            break;
                        }
                    }
                    Err(_) if line.trim().is_empty() => {}
                    Err(error) => eprintln!("Ignoring invalid App Server message: {error}"),
                },
                Err(error) => {
                    let _ = tx.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    rx
}

fn wait_for_response(
    messages: &Receiver<Result<Value, String>>,
    expected_id: u64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Timed out waiting for Codex App Server".into());
        }
        let message = messages
            .recv_timeout(remaining)
            .map_err(|error| -> String {
                match error {
                    RecvTimeoutError::Timeout => "Timed out waiting for Codex App Server".into(),
                    RecvTimeoutError::Disconnected => "Codex App Server disconnected".into(),
                }
            })??;

        if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex App Server request failed")
                .to_owned());
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex App Server returned no result".into());
    }
}

fn rpc(
    writer: &mut BufWriter<ChildStdin>,
    messages: &Receiver<Result<Value, String>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send_rpc(writer, id, method, params)?;
    wait_for_response(messages, id, Duration::from_secs(30))
}

fn window_from_value(
    value: &Value,
    fallback_duration: u64,
    id: &str,
    label: &str,
) -> Option<UsageWindow> {
    let used = value.get("usedPercent")?.as_f64()?;
    let used_percent = used.round().clamp(0.0, 100.0) as u8;
    let duration = value
        .get("windowDurationMins")
        .and_then(Value::as_u64)
        .unwrap_or(fallback_duration);

    Some(UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent,
        remaining_percent: 100 - used_percent,
        window_duration_mins: duration,
        resets_at: value.get("resetsAt").and_then(Value::as_i64),
    })
}

fn parse_rate_limits(result: &Value, plan_name: &str) -> UsageSnapshot {
    let by_codex_id = result
        .get("rateLimitsByLimitId")
        .and_then(|limits| limits.get("codex"));
    let legacy_codex = result
        .get("rateLimits")
        .filter(|limits| limits.get("limitId").and_then(Value::as_str) == Some("codex"));
    let selected = by_codex_id.or(legacy_codex);

    let mut five_hour = None;
    let mut weekly = None;
    if let Some(limits) = selected {
        for (key, fallback_duration, id, label) in [
            ("primary", 300_u64, "5h", "5 小时"),
            ("secondary", 10_080_u64, "week", "本周"),
        ] {
            let Some(value) = limits.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            let Some(window) = window_from_value(value, fallback_duration, id, label) else {
                continue;
            };
            match window.window_duration_mins {
                300 => five_hour = Some(window),
                10_080 => weekly = Some(window),
                _ => {}
            }
        }
    }

    let (
        reset_cards_available,
        reset_cards,
        next_reset_card_expires_at,
        reset_card_expiry_details_available,
        reset_cards_never_expire,
    ) = reset_card_data(result);

    UsageSnapshot {
        status: "online".into(),
        connection_error: None,
        plan_name: plan_name.into(),
        five_hour,
        weekly,
        reset_cards_available,
        reset_cards,
        next_reset_card_expires_at,
        reset_card_expiry_details_available,
        reset_cards_never_expire,
        fast_mode_enabled: None,
    }
}

fn reset_card_data(result: &Value) -> (Option<u64>, Vec<ResetCardExpiry>, Option<i64>, bool, bool) {
    let summary = result
        .get("rateLimitResetCredits")
        .or_else(|| result.get("rate_limit_reset_credits"));
    let Some(summary) = summary else {
        return (None, Vec::new(), None, false, false);
    };

    let count = summary
        .get("availableCount")
        .or_else(|| summary.get("available_count"))
        .and_then(Value::as_u64);
    let Some(credits) = summary.get("credits").and_then(Value::as_array) else {
        return (count, Vec::new(), None, false, false);
    };

    let available: Vec<_> = credits
        .iter()
        .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
        .collect();
    if available.is_empty() {
        return (count, Vec::new(), None, false, false);
    }

    let mut reset_cards: Vec<_> = available
        .iter()
        .map(|credit| {
            let expiry_value = credit.get("expiresAt").or_else(|| credit.get("expires_at"));
            let expires_at = expiry_value.and_then(Value::as_i64);
            ResetCardExpiry {
                id: credit.get("id").and_then(Value::as_str).map(str::to_owned),
                reset_type: credit
                    .get("resetType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                status: credit
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                expires_at,
                expiry_details_available: expiry_value
                    .is_some_and(|value| value.is_null() || expires_at.is_some()),
            }
        })
        .collect();
    reset_cards.sort_by_key(
        |card| match (card.expiry_details_available, card.expires_at) {
            (true, Some(expires_at)) => (0_u8, expires_at),
            (true, None) => (1, i64::MAX),
            (false, _) => (2, i64::MAX),
        },
    );

    let expiry_details_available = reset_cards.iter().any(|card| card.expiry_details_available);
    let earliest_expiry = reset_cards.iter().filter_map(|card| card.expires_at).min();
    let never_expire = expiry_details_available
        && earliest_expiry.is_none()
        && reset_cards
            .iter()
            .all(|card| card.expiry_details_available && card.expires_at.is_none());

    (
        count,
        reset_cards,
        earliest_expiry,
        expiry_details_available,
        never_expire,
    )
}

fn plan_name_from_account(account: &Value) -> Option<String> {
    let plan = account
        .get("account")
        .and_then(|account| account.get("planType"))
        .or_else(|| account.get("planType"))
        .and_then(Value::as_str)?;
    let normalized_plan = plan.to_ascii_lowercase();
    let normalized = match normalized_plan.as_str() {
        "free" => "Free".to_owned(),
        "plus" => "Plus".to_owned(),
        "pro" => "Pro".to_owned(),
        "team" | "business" => "Team".to_owned(),
        "enterprise" => "Enterprise".to_owned(),
        other => other.to_owned(),
    };
    Some(format!("ChatGPT {normalized}"))
}

fn fast_mode_enabled_from_config(result: &Value) -> Option<bool> {
    let config = result.get("config")?;
    let service_tier = config
        .get("service_tier")
        .or_else(|| config.get("serviceTier"))
        .and_then(Value::as_str);
    Some(
        service_tier
            .is_some_and(|tier| matches!(tier.to_ascii_lowercase().as_str(), "fast" | "priority")),
    )
}

fn current_snapshot(app: &AppHandle) -> UsageSnapshot {
    app.try_state::<AppState>()
        .and_then(|state| state.usage.lock().ok().map(|snapshot| snapshot.clone()))
        .unwrap_or_default()
}

fn set_plan_name(app: &AppHandle, plan_name: String) {
    let mut snapshot = current_snapshot(app);
    snapshot.plan_name = plan_name;
    publish_usage(app, snapshot);
}

fn set_fast_mode(app: &AppHandle, enabled: bool) {
    let mut snapshot = current_snapshot(app);
    if snapshot.fast_mode_enabled == Some(enabled) {
        return;
    }
    snapshot.fast_mode_enabled = Some(enabled);
    publish_usage(app, snapshot);
}

fn read_rate_limits(
    writer: &mut BufWriter<ChildStdin>,
    next_id: &mut u64,
    pending_id: &mut Option<u64>,
) -> Result<(), String> {
    let id = *next_id;
    *next_id += 1;
    send_rpc(writer, id, "account/rateLimits/read", json!({}))?;
    *pending_id = Some(id);
    Ok(())
}

fn read_token_usage(
    writer: &mut BufWriter<ChildStdin>,
    next_id: &mut u64,
    pending_id: &mut Option<u64>,
) -> Result<(), String> {
    let id = *next_id;
    *next_id += 1;
    send_rpc(writer, id, "account/usage/read", json!({}))?;
    *pending_id = Some(id);
    Ok(())
}

fn terminate_child(child: &Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn connect_app_server(
    app: &AppHandle,
    refresh: &Receiver<()>,
    token_refresh: &Receiver<()>,
    consume_reset: &Receiver<ConsumeResetCardRequest>,
) -> Result<(), String> {
    let mut spawned: Child = codex_command(app)
        .spawn()
        .map_err(|error| format!("Could not start Codex App Server: {error}"))?;
    let Some(stdin) = spawned.stdin.take() else {
        let _ = spawned.kill();
        let _ = spawned.wait();
        return Err("Codex App Server did not provide stdin".into());
    };
    let Some(stdout) = spawned.stdout.take() else {
        let _ = spawned.kill();
        let _ = spawned.wait();
        return Err("Codex App Server did not provide stdout".into());
    };
    let child = Arc::new(Mutex::new(spawned));
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut running) = state.server_child.lock() {
            *running = Some(Arc::clone(&child));
        }
    }

    let messages = spawn_server_reader(stdout);
    let mut writer = BufWriter::new(stdin);
    let initialize = json!({
        "clientInfo": {
            "name": "CapsuleMeterX",
            "title": "CapsuleMeterX",
            "version": env!("CARGO_PKG_VERSION")
        }
    });

    let result = (|| {
        let _ = rpc(&mut writer, &messages, 1, "initialize", initialize)?;
        send_notification(&mut writer, "initialized")?;
        let usage = rpc(
            &mut writer,
            &messages,
            2,
            "account/rateLimits/read",
            json!({}),
        )?;
        let account = rpc(
            &mut writer,
            &messages,
            3,
            "account/read",
            json!({ "refreshToken": false }),
        )?;

        let mut snapshot = parse_rate_limits(&usage, "ChatGPT");
        if let Some(plan_name) = plan_name_from_account(&account) {
            snapshot.plan_name = plan_name;
        }
        publish_usage(app, snapshot.clone());
        record_quota_sample(app, &snapshot);

        let mut next_id = 4_u64;
        let mut pending_config = Some(next_id);
        send_rpc(&mut writer, next_id, "config/read", json!({}))?;
        next_id += 1;
        let mut config_read_supported = true;
        let mut pending_usage = None;
        let mut pending_token_usage = None;
        let mut pending_reset_consumptions: HashMap<
            u64,
            (Sender<Result<String, String>>, ActiveResetCardGuard),
        > = HashMap::new();
        let mut last_poll = Instant::now();
        let mut last_config_poll = Instant::now();
        loop {
            while let Ok(request) = consume_reset.try_recv() {
                let id = next_id;
                next_id += 1;
                if let Err(error) = send_rpc(
                    &mut writer,
                    id,
                    "account/rateLimitResetCredit/consume",
                    json!({
                        "creditId": request.credit_id,
                        "idempotencyKey": request.idempotency_key
                    }),
                ) {
                    let _ = request.response.send(Err(error.clone()));
                    return Err(error);
                }
                pending_reset_consumptions.insert(id, (request.response, request._guard));
            }

            while refresh.try_recv().is_ok() {
                if pending_usage.is_none() {
                    read_rate_limits(&mut writer, &mut next_id, &mut pending_usage)?;
                }
            }

            let mut should_read_token_usage = false;
            while token_refresh.try_recv().is_ok() {
                should_read_token_usage = true;
            }
            if should_read_token_usage && pending_token_usage.is_none() {
                read_token_usage(&mut writer, &mut next_id, &mut pending_token_usage)?;
            }

            match messages.recv_timeout(Duration::from_millis(250)) {
                Ok(Err(error)) => return Err(error),
                Ok(Ok(message)) => {
                    if message.get("method").and_then(Value::as_str)
                        == Some("account/rateLimits/updated")
                    {
                        if pending_usage.is_none() {
                            read_rate_limits(&mut writer, &mut next_id, &mut pending_usage)?;
                        }
                        continue;
                    }

                    if message.get("method").and_then(Value::as_str) == Some("account/updated") {
                        let id = next_id;
                        next_id += 1;
                        send_rpc(
                            &mut writer,
                            id,
                            "account/read",
                            json!({ "refreshToken": false }),
                        )?;
                        continue;
                    }

                    let Some(id) = message.get("id").and_then(Value::as_u64) else {
                        continue;
                    };

                    if let Some((response, guard)) = pending_reset_consumptions.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex 拒绝了重置卡操作")
                                .to_owned())
                        } else {
                            match message
                                .get("result")
                                .and_then(|result| result.get("outcome"))
                                .and_then(Value::as_str)
                            {
                                Some("reset") => Ok("reset".to_owned()),
                                Some("alreadyRedeemed") => Ok("alreadyRedeemed".to_owned()),
                                Some("nothingToReset") => Ok("nothingToReset".to_owned()),
                                Some("noCredit") => Ok("noCredit".to_owned()),
                                Some(outcome) => {
                                    Err(format!("Codex 返回了无法识别的重置结果：{outcome}"))
                                }
                                None => Err("Codex 没有返回重置结果。".to_owned()),
                            }
                        };
                        drop(guard);
                        if matches!(result.as_deref(), Ok("reset" | "alreadyRedeemed")) {
                            if let Some(state) = app.try_state::<AppState>() {
                                let _ = state.refresh_tx.send(());
                            }
                        }
                        let _ = response.send(result);
                        continue;
                    }

                    if pending_usage == Some(id) {
                        pending_usage = None;
                        last_poll = Instant::now();
                        if let Some(result) = message.get("result") {
                            let current = current_snapshot(app);
                            let mut snapshot = parse_rate_limits(result, &current.plan_name);
                            snapshot.fast_mode_enabled = current.fast_mode_enabled;
                            publish_usage(app, snapshot.clone());
                            record_quota_sample(app, &snapshot);
                        } else if let Some(error) = message.get("error") {
                            eprintln!("Codex rate limit read failed: {error}");
                        }
                    } else if pending_token_usage == Some(id) {
                        pending_token_usage = None;
                        if let Some(result) = message.get("result") {
                            update_token_usage(app, result);
                        } else if let Some(error) = message.get("error") {
                            set_token_fetch_error(
                                app,
                                error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex could not read account Token usage")
                                    .to_owned(),
                            );
                        } else {
                            set_token_fetch_error(
                                app,
                                "Codex returned no Token usage response".into(),
                            );
                        }
                    } else if pending_config == Some(id) {
                        pending_config = None;
                        if let Some(result) = message.get("result") {
                            if let Some(enabled) = fast_mode_enabled_from_config(result) {
                                set_fast_mode(app, enabled);
                            } else {
                                config_read_supported = false;
                            }
                        } else {
                            config_read_supported = false;
                        }
                    } else if message.get("result").is_some() {
                        if let Some(plan_name) =
                            plan_name_from_account(message.get("result").unwrap_or(&Value::Null))
                        {
                            set_plan_name(app, plan_name);
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if pending_usage.is_none()
                        && last_poll.elapsed() >= configured_poll_interval(app)
                    {
                        read_rate_limits(&mut writer, &mut next_id, &mut pending_usage)?;
                        last_poll = Instant::now();
                    }
                    if config_read_supported
                        && pending_config.is_none()
                        && last_config_poll.elapsed() >= FAST_MODE_POLL_INTERVAL
                    {
                        let id = next_id;
                        next_id += 1;
                        send_rpc(&mut writer, id, "config/read", json!({}))?;
                        pending_config = Some(id);
                        last_config_poll = Instant::now();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("Codex App Server disconnected".into());
                }
            }

            if child
                .lock()
                .map_err(|error| error.to_string())?
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                return Err("Codex App Server exited".into());
            }
        }
    })();

    terminate_child(&child);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut running) = state.server_child.lock() {
            if running
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &child))
            {
                *running = None;
            }
        }
    }
    result
}

fn run_usage_worker(
    app: AppHandle,
    refresh: Receiver<()>,
    token_refresh: Receiver<()>,
    consume_reset: Receiver<ConsumeResetCardRequest>,
) {
    loop {
        match connect_app_server(&app, &refresh, &token_refresh, &consume_reset) {
            Ok(()) => {}
            Err(error) => {
                eprintln!("CapsuleMeterX App Server connection: {error}");
                if app
                    .try_state::<AppState>()
                    .and_then(|state| {
                        state
                            .statistics
                            .lock()
                            .ok()
                            .map(|stats| stats.token_fetch_pending)
                    })
                    .unwrap_or(false)
                {
                    set_token_fetch_error(&app, error.clone());
                }
                let mut snapshot = current_snapshot(&app);
                snapshot.status = "offline".into();
                snapshot.connection_error = Some(error.clone());
                publish_usage(&app, snapshot);
            }
        }

        match refresh.recv_timeout(Duration::from_secs(5)) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let refresh = IconMenuItem::with_id(
        app,
        "refresh",
        "立即刷新",
        true,
        Some(refresh_menu_icon()),
        None::<&str>,
    )?;
    let quit = IconMenuItem::with_id(
        app,
        "quit",
        "退出 CapsuleMeterX",
        true,
        Some(exit_menu_icon()),
        None::<&str>,
    )?;
    let statistics = MenuItem::with_id(app, "statistics", "使用统计", true, None::<&str>)?;
    let cancel_shutdown =
        MenuItem::with_id(app, "cancel-shutdown", "取消定时关机", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &statistics, &cancel_shutdown, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(usage_icon(&UsageSnapshot::default()))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "refresh" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.refresh_tx.send(());
                }
            }
            "quit" => app.exit(0),
            "cancel-shutdown" => {
                let _ = cancel_auto_shutdown_inner(app);
            }
            "statistics" => {
                hide_tooltip_window(app);
                if let Some(window) = app.get_webview_window(STATISTICS_LABEL) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = request_token_usage_refresh(app, &state);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Enter { rect, .. } => {
                    let state = app.state::<AppState>();
                    let epoch = state.tooltip_epoch.fetch_add(1, Ordering::SeqCst) + 1;
                    let guard = Arc::clone(&state.tooltip_epoch);
                    let app = app.clone();
                    let anchor = tray_anchor_from_rect(rect);
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(300));
                        if guard.load(Ordering::SeqCst) == epoch {
                            let state = app.state::<AppState>();
                            let _ = show_tray_tooltip_window(&app, &state, anchor, "details", None);
                        }
                    });
                }
                TrayIconEvent::Leave { .. } => {
                    let state = app.state::<AppState>();
                    let epoch = state.tooltip_epoch.fetch_add(1, Ordering::SeqCst) + 1;
                    let guard = Arc::clone(&state.tooltip_epoch);
                    let app = app.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(180));
                        if guard.load(Ordering::SeqCst) == epoch {
                            hide_tooltip_window(&app);
                        }
                    });
                }
                TrayIconEvent::Click {
                    rect,
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let state = app.state::<AppState>();
                    let _ = show_tray_tooltip_window(
                        &app,
                        &state,
                        tray_anchor_from_rect(rect),
                        "details",
                        None,
                    );
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let (refresh_tx, refresh_rx) = mpsc::channel();
    let (token_refresh_tx, token_refresh_rx) = mpsc::channel();
    let (consume_reset_tx, consume_reset_rx) = mpsc::channel();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::new(
            refresh_tx,
            token_refresh_tx,
            consume_reset_tx,
        ))
        .invoke_handler(tauri::generate_handler![
            get_usage_snapshot,
            get_statistics_data,
            show_statistics_window,
            hide_statistics_window,
            refresh_statistics_token_usage,
            save_statistics_csv,
            get_startup_settings,
            set_startup_settings,
            cancel_auto_shutdown,
            consume_reset_card,
            show_usage_tooltip,
            show_tray_usage_details,
            resize_usage_tooltip,
            keep_usage_tooltip,
            hide_usage_tooltip,
            finish_capsule_drag,
            resize_capsule
        ])
        .setup(move |app| {
            create_tray(app)?;
            let startup_settings = load_startup_settings(app.handle());
            if startup_settings.auto_shutdown_on_codex_complete {
                if let Err(error) = configure_codex_task_monitor(app.handle(), true) {
                    eprintln!("Could not install Codex task monitor hooks: {error}");
                }
            }
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut statistics) = state.statistics.lock() {
                    *statistics = load_statistics(app.handle());
                }
                if let Ok(mut settings) = state.startup_settings.lock() {
                    *settings = startup_settings.clone();
                }
            }

            let autostart = app.autolaunch();
            let should_launch_at_login = startup_settings.start_with_windows;
            if should_launch_at_login {
                if let Err(error) = autostart.enable() {
                    eprintln!("Could not sync startup registration: {error}");
                }
            } else if autostart.is_enabled().unwrap_or(false) {
                if let Err(error) = autostart.disable() {
                    eprintln!("Could not sync startup registration: {error}");
                }
            }

            let app_handle = app.handle().clone();
            if let Some(capsule) = app.get_webview_window(CAPSULE_LABEL) {
                capsule.set_always_on_top(startup_settings.capsule_always_on_top)?;
                place_capsule(&app_handle, &capsule);
                capsule.show()?;
            }

            thread::spawn(move || {
                run_usage_worker(app_handle, refresh_rx, token_refresh_rx, consume_reset_rx)
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == CAPSULE_LABEL {
                if let WindowEvent::Moved(position) = event {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<AppState>() {
                        start_drag_release_watcher(&app, &state.drag_watch_active);
                    }
                    save_capsule_position(&app, *position);
                }
            } else if window.label() == STATISTICS_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("CapsuleMeterX failed to start");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<AppState>() {
                let child = state
                    .server_child
                    .lock()
                    .ok()
                    .and_then(|mut running| running.take());
                if let Some(child) = child {
                    terminate_child(&child);
                }
            }
        }
    });
}
