import { invoke } from "@/lib/invoke";
import { t, type MessageKey } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import { toast } from "sonner";

/**
 * 数据库结构健康。
 *
 * 「能打开」和「是好的」是两件事：网盘把主库同步成半截、写入途中被强杀，都会留下
 * 打开不报错、读到某张表才 malformed 的库——那时用户只看到某个页面打不开，
 * 完全想不到是库坏了。这里提供一条说得清坏在哪里的检查，和一条能救则救的修复；
 * 修复全程只改名不删除，被替换掉的文件都留在数据目录里。
 */

/** check_db_integrity 返回结构（与 Rust IntegrityReport 对齐） */
export interface IntegrityReport {
  ok: boolean;
  /** true = 整库深扫（integrity_check，慢）；false = quick_check（快，够巡检） */
  deep: boolean;
  took_ms: number;
  db_path: string;
  db_size_bytes: number;
  /** PRAGMA 的输出行：健康时是 ["ok"]，坏时具体到哪张表/哪个页 */
  messages: string[];
}

/** 修复过程中被改名保留的文件（原路径 → 现路径） */
export interface KeptAside {
  from: string;
  to: string;
}

/** repair_database 返回结构（与 Rust DbRepairResult 对齐） */
export interface DbRepairResult {
  action: "none" | "wal" | "rebuild" | "failed";
  ok: boolean;
  before: string[];
  after: string[];
  kept_aside: KeptAside[];
}

export const REPAIR_ACTION_KEY: Record<DbRepairResult["action"], MessageKey> = {
  none: "settings.dbRepairNone",
  wal: "settings.dbRepairWal",
  rebuild: "settings.dbRepairRebuild",
  failed: "settings.dbRepairFailed",
};

/** 检查用的库文件是否被占用等硬失败：命令本身报错，而不是报告里带报错行 */
export function checkDbIntegrity(deep: boolean): Promise<IntegrityReport> {
  return invoke<IntegrityReport>("check_db_integrity", { deep });
}

export function repairDatabase(): Promise<DbRepairResult> {
  return invoke<DbRepairResult>("repair_database");
}

/**
 * 启动后的静默巡检：延迟一点再跑，别跟首屏渲染和自动同步抢磁盘 I/O。
 * 只在查出问题时打扰用户（一句话 + 跳到设置页的按钮）；一切正常时不出声。
 * 巡检本身失败（库都没打开时命令会报错）交给兜底页，这里只记日志。
 */
export const PROBE_DELAY_MS = 20_000;

let probed = false;

export async function probeDbHealthOnStartup(delayMs: number = PROBE_DELAY_MS): Promise<IntegrityReport | null> {
  if (probed) return null; // StrictMode/热重载会重复挂载：一次启动只查一遍
  probed = true;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  try {
    const report = await checkDbIntegrity(false);
    if (report.ok) return report;
    toast.warning(t("settings.dbHealthToast"), {
      description: report.messages[0] ?? "",
      duration: 12_000,
      action: {
        label: t("settings.dbHealthGoSettings"),
        onClick: () => useWorkspaceStore.getState().setRoute("settings"),
      },
    });
    return report;
  } catch (e) {
    logger.error("startup db health probe failed", e);
    return null;
  }
}
