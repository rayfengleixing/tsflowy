//! AI 的 API Key 走系统凭据管理器（Windows 凭据管理器）读写，避免在 config.json 里落明文。
//!
//! 对外只暴露三个「不 panic、不返回 Err」的函数：任何底层错误都被吞掉并 `tracing::warn!`，
//! 由调用方按返回值决定回退策略（例如回退到 config.json 明文），保证功能可用、不丢 Key。
//! 非 Windows 平台（含 CI）统一走「不可用」分支：store=false / load=None / delete=false，
//! 使本模块始终可跨平台编译。

/// 凭据库中的服务名
const SERVICE: &str = "TsFlowy";
/// 凭据库中的账户名
const ACCOUNT: &str = "ai-api-key";

/// 把 API Key 写入系统凭据管理器；成功返回 true，任何失败返回 false（绝不 panic）。
#[cfg(target_os = "windows")]
pub fn store_key(key: &str) -> bool {
    match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => match entry.set_password(key) {
            Ok(()) => {
                tracing::info!("api key stored in Windows Credential Manager");
                true
            }
            Err(e) => {
                tracing::warn!("store api key failed: {e}");
                false
            }
        },
        Err(e) => {
            tracing::warn!("open credential entry failed: {e}");
            false
        }
    }
}

/// 从系统凭据管理器读取 API Key；不存在或失败返回 None（绝不 panic）。
#[cfg(target_os = "windows")]
pub fn load_key() -> Option<String> {
    let entry = match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => entry,
        Err(e) => {
            tracing::warn!("open credential entry failed: {e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(secret) => Some(secret),
        Err(e) => {
            // NoEntry 属正常情况（尚未保存过），debug 级别即可
            tracing::warn!("load api key failed: {e}");
            None
        }
    }
}

/// 从系统凭据管理器删除 API Key；成功返回 true，失败（含本就不存在）返回 false。
#[cfg(target_os = "windows")]
pub fn delete_key() -> bool {
    let entry = match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => entry,
        Err(e) => {
            tracing::warn!("open credential entry failed: {e}");
            return false;
        }
    };
    match entry.delete_credential() {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("delete api key failed: {e}");
            false
        }
    }
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn store_key(_key: &str) -> bool {
    tracing::warn!("credential store unavailable on this platform");
    false
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn load_key() -> Option<String> {
    None
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn delete_key() -> bool {
    false
}
