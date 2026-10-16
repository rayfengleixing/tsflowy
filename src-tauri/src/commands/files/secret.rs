//! AI 的 API Key 走系统凭据管理器（Windows 凭据管理器）读写，避免在 config.json 里落明文。
//!
//! 对外只暴露三个「不 panic、不返回 Err」的函数：任何底层错误都被吞掉并 `tracing::warn!`，
//! 由调用方按返回值决定回退策略（例如回退到 config.json 明文），保证功能可用、不丢 Key。
//! 非 Windows 平台（含 CI）统一走「不可用」分支：store=false / load=None / delete=false，
//! 使本模块始终可跨平台编译。

/// 凭据库中的服务名
const SERVICE: &str = "TsFlowy";
/// 凭据库中的账户名（全局 Key）
const ACCOUNT: &str = "ai-api-key";

/// 档位 Key 的账户名：凭据库按「服务 + 账户」寻址，档位 id 拼进账户名即可一档一条，
/// 不受「单个账户位装不下多档 Key」的限制。
pub fn profile_account(profile_id: &str) -> String {
    format!("{ACCOUNT}:profile:{profile_id}")
}

/// 把 API Key 写入系统凭据管理器；成功返回 true，任何失败返回 false（绝不 panic）。
#[cfg(target_os = "windows")]
pub fn store_key(key: &str) -> bool {
    store_key_for(ACCOUNT, key)
}

/// 按指定账户名写入；语义同 [`store_key`]，供档位等需要多个槽位的场景使用。
#[cfg(target_os = "windows")]
pub fn store_key_for(account: &str, key: &str) -> bool {
    match entry(account) {
        Some(entry) => match entry.set_password(key) {
            Ok(()) => {
                tracing::info!("api key stored in Windows Credential Manager ({account})");
                true
            }
            Err(e) => {
                tracing::warn!("store api key failed ({account}): {e}");
                false
            }
        },
        None => false,
    }
}

/// 从系统凭据管理器读取 API Key；不存在或失败返回 None（绝不 panic）。
#[cfg(target_os = "windows")]
pub fn load_key() -> Option<String> {
    load_key_for(ACCOUNT)
}

/// 按指定账户名读取；语义同 [`load_key`]。
#[cfg(target_os = "windows")]
pub fn load_key_for(account: &str) -> Option<String> {
    let entry = entry(account)?;
    match entry.get_password() {
        Ok(secret) => Some(secret),
        Err(e) => {
            // NoEntry 属正常情况（尚未保存过），debug 级别即可
            tracing::debug!("load api key failed ({account}): {e}");
            None
        }
    }
}

/// 从系统凭据管理器删除 API Key；成功返回 true，失败（含本就不存在）返回 false。
#[cfg(target_os = "windows")]
pub fn delete_key() -> bool {
    delete_key_for(ACCOUNT)
}

/// 按指定账户名删除；语义同 [`delete_key`]。
#[cfg(target_os = "windows")]
pub fn delete_key_for(account: &str) -> bool {
    let entry = match entry(account) {
        Some(entry) => entry,
        None => return false,
    };
    match entry.delete_credential() {
        Ok(()) => true,
        Err(e) => {
            tracing::debug!("delete api key failed ({account}): {e}");
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn entry(account: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new(SERVICE, account) {
        Ok(entry) => Some(entry),
        Err(e) => {
            tracing::warn!("open credential entry failed ({account}): {e}");
            None
        }
    }
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn store_key(_key: &str) -> bool {
    false
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn store_key_for(_account: &str, _key: &str) -> bool {
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
pub fn load_key_for(_account: &str) -> Option<String> {
    None
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn delete_key() -> bool {
    false
}

/// 非 Windows：无系统凭据库，统一走不可用分支。
#[cfg(not(target_os = "windows"))]
pub fn delete_key_for(_account: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::profile_account;

    #[test]
    fn profile_account_is_scoped_by_id() {
        assert_eq!(profile_account("p1"), "ai-api-key:profile:p1");
        // 与全局账户名不冲突
        assert_ne!(profile_account("p1"), "ai-api-key");
    }

    /// 逐档 Key 的前提是「同一服务名可按账户名开多个槽位」。账户名里带 `:`，
    /// 需确认凭据库真的能按不同账户名各存一份。这条会写进本机 Windows 凭据管理器，
    /// 因此默认跳过，只在需要验证底层行为时手动跑：
    /// `cargo test --lib -- --ignored profile_slots_are_independent`（结束即删除测试条目）。
    #[test]
    #[ignore]
    fn profile_slots_are_independent() {
        const ID_A: &str = "__tsflowy_selftest_a__";
        const ID_B: &str = "__tsflowy_selftest_b__";
        let a = profile_account(ID_A);
        let b = profile_account(ID_B);
        // 先清掉可能的残留，避免上一次中断留下脏数据
        super::delete_key_for(&a);
        super::delete_key_for(&b);
        assert!(super::store_key_for(&a, "key-for-a"));
        assert!(super::store_key_for(&b, "key-for-b"));
        assert_eq!(super::load_key_for(&a).as_deref(), Some("key-for-a"));
        assert_eq!(super::load_key_for(&b).as_deref(), Some("key-for-b"));
        assert!(super::delete_key_for(&a));
        assert_eq!(
            super::load_key_for(&a),
            None,
            "删除后不应影响同服务的其它账户"
        );
        assert_eq!(super::load_key_for(&b).as_deref(), Some("key-for-b"));
        super::delete_key_for(&b);
    }
}
