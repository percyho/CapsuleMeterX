use reqwest::blocking::Client;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ANALYTICS_URL: &str =
    "https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts";

fn codex_home() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }

    let profile = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_default();
    PathBuf::from(profile).join(".codex")
}

fn load_credentials() -> Result<(String, Option<String>), String> {
    let path = codex_home().join("auth.json");
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 Codex 登录凭据 {}：{error}", path.display()))?;
    let auth: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("无法解析 Codex 登录凭据：{error}"))?;
    let tokens = auth
        .get("tokens")
        .ok_or_else(|| "Codex 登录凭据缺少 tokens，请先在本机登录 Codex CLI。".to_owned())?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "Codex 登录凭据缺少 access_token，请重新登录 Codex CLI。".to_owned())?;
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|account| !account.is_empty())
        .map(str::to_owned);

    Ok((access_token.to_owned(), account_id))
}

#[cfg(windows)]
fn system_proxy_url() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled != 1 {
        return None;
    }

    let server: String = settings.get_value("ProxyServer").ok()?;
    let address = if server.contains('=') {
        server
            .split(';')
            .find_map(|entry| {
                entry
                    .strip_prefix("https=")
                    .or_else(|| entry.strip_prefix("http="))
            })
            .unwrap_or_default()
            .to_owned()
    } else {
        server
    };

    (!address.is_empty()).then(|| format!("http://{}", address.trim_end_matches('/')))
}

#[cfg(not(windows))]
fn system_proxy_url() -> Option<String> {
    None
}

fn build_client() -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("codex-cli");

    if let Some(proxy) = system_proxy_url() {
        let proxy =
            reqwest::Proxy::all(proxy).map_err(|_| "Windows 系统代理配置无效。".to_owned())?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|error| format!("初始化用量请求失败：{error}"))
}

pub fn fetch_usage() -> Result<Value, String> {
    let (access_token, account_id) = load_credentials()?;
    let client = build_client()?;
    let mut request = client.get(USAGE_URL).bearer_auth(access_token);
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request
        .send()
        .map_err(|error| format!("请求 Codex 用量失败：{error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Codex 登录已过期，请重新登录 Codex CLI 后刷新用量。".into());
    }
    if !status.is_success() {
        return Err(format!("Codex 用量接口返回 HTTP {status}"));
    }

    response
        .json::<Value>()
        .map_err(|error| format!("解析 Codex 用量响应失败：{error}"))
}

pub fn fetch_token_usage(days: u32) -> Result<Value, String> {
    let (access_token, account_id) = load_credentials()?;
    let client = build_client()?;
    let url = format!("{TOKEN_ANALYTICS_URL}?days={}", days.clamp(1, 3650));
    let mut request = client.get(url).bearer_auth(access_token);
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request
        .send()
        .map_err(|error| format!("请求 Codex Token 历史失败：{error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Codex 登录已过期，请重新登录 Codex CLI 后刷新 Token 历史。".into());
    }
    if !status.is_success() {
        return Err(format!("Codex Token 历史接口返回 HTTP {status}"));
    }

    response
        .json::<Value>()
        .map_err(|error| format!("解析 Codex Token 历史响应失败：{error}"))
}
