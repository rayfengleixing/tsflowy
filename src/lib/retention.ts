import { invoke } from "@/lib/invoke";
import { logger } from "@/lib/logger";

/**
 * 数据保留策略（文档快照 + 回收站自动清空）。
 * 存 Rust 侧 config.json（与自动备份同一配置面）：换数据目录、重装前端都不会丢。
 */
export interface RetentionPolicy {
  snapshot_interval_minutes: number;
  snapshot_keep: number;
  snapshot_pre_restore_keep: number;
  trash_retention_days: number;
}

export interface RetentionLimit {
  min: number;
  max: number;
  /** 非法/缺省时的回落值（与 Rust 侧 config.json 缺字段时的默认值同口径） */
  fallback: number;
}

export const RETENTION_LIMITS: Record<keyof RetentionPolicy, RetentionLimit> = {
  snapshot_interval_minutes: { min: 1, max: 1440, fallback: 10 },
  snapshot_keep: { min: 1, max: 500, fallback: 50 },
  snapshot_pre_restore_keep: { min: 1, max: 50, fallback: 5 },
  trash_retention_days: { min: 1, max: 365, fallback: 30 },
};

export const RETENTION_DEFAULTS: RetentionPolicy = {
  snapshot_interval_minutes: RETENTION_LIMITS.snapshot_interval_minutes.fallback,
  snapshot_keep: RETENTION_LIMITS.snapshot_keep.fallback,
  snapshot_pre_restore_keep: RETENTION_LIMITS.snapshot_pre_restore_keep.fallback,
  trash_retention_days: RETENTION_LIMITS.trash_retention_days.fallback,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 空值/非数/非正数回落默认值，其余夹进 [min, max]（输入框被清空时 Number("")=0 也走回落） */
export function clampRetention(value: number | null | undefined, limit: RetentionLimit): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return limit.fallback;
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)));
}

/** 后端返回缺字段/越界都在这里兜一层，保证 UI 与写回的值始终落在合法区间 */
export function normalizeRetentionPolicy(raw: Partial<RetentionPolicy> | null | undefined): RetentionPolicy {
  return {
    snapshot_interval_minutes: clampRetention(
      raw?.snapshot_interval_minutes,
      RETENTION_LIMITS.snapshot_interval_minutes,
    ),
    snapshot_keep: clampRetention(raw?.snapshot_keep, RETENTION_LIMITS.snapshot_keep),
    snapshot_pre_restore_keep: clampRetention(
      raw?.snapshot_pre_restore_keep,
      RETENTION_LIMITS.snapshot_pre_restore_keep,
    ),
    trash_retention_days: clampRetention(raw?.trash_retention_days, RETENTION_LIMITS.trash_retention_days),
  };
}

/** 读取策略；IPC 失败返回全默认值——自动清理不该因为读配置失败而停摆 */
export async function fetchRetentionPolicy(): Promise<RetentionPolicy> {
  try {
    return normalizeRetentionPolicy(await invoke<RetentionPolicy>("get_retention_policy"));
  } catch (e) {
    logger.warn("Retention", "load retention policy failed", e);
    return RETENTION_DEFAULTS;
  }
}

/** 回收站自动清空的截止时间戳：deleted_at 早于它的条目会被彻底删除 */
export async function trashDeadlineMs(now: number = Date.now()): Promise<number> {
  const { trash_retention_days } = await fetchRetentionPolicy();
  return now - trash_retention_days * DAY_MS;
}
