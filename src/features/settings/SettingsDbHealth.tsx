import { useEffect, useState } from "react";
import { RefreshCw, Stethoscope, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { flushAllForClose } from "@/lib/close-flush";
import {
  checkDbIntegrity,
  repairDatabase,
  REPAIR_ACTION_KEY,
  type DbRepairResult,
  type IntegrityReport,
} from "@/lib/db-health";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { formatBytes, Section } from "./settings-parts";

/**
 * 修复动了文件就必须整页重载，而那会把刚打印出来的结果（尤其是「哪些文件被改名留在原地」）
 * 一起冲掉。重载前把它塞进 localStorage，回来时读一次即弃 —— 用户看得到自己该去哪改回原名。
 */
const REPAIR_FLASH_KEY = "tsflowy:lastDbRepair";

/** 检查结果一行摘要：过与不过都说清代价（用时、库大小），用户才知道深度检查值不值得点 */
function ReportSummary({ report }: { report: IntegrityReport }) {
  return (
    <div
      className={
        report.ok
          ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800"
          : "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-800"
      }
    >
      <div>
        {report.ok
          ? t("settings.dbHealthy", { ms: report.took_ms, size: formatBytes(report.db_size_bytes) })
          : t("settings.dbUnhealthy", { n: report.messages.length })}
      </div>
      {!report.ok && (
        <ul className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed">
          {report.messages.map((m, i) => (
            <li key={`${i}-${m}`}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 数据库结构健康：检查（quick/integrity）+ 只改名不删除的修复阶梯 */
export function SettingsDbHealth() {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [busy, setBusy] = useState<"quick" | "deep" | "repair" | null>(null);
  const [repair, setRepair] = useState<DbRepairResult | null>(null);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(REPAIR_FLASH_KEY);
    if (!raw) return;
    localStorage.removeItem(REPAIR_FLASH_KEY);
    try {
      setRepair(JSON.parse(raw) as DbRepairResult);
    } catch (e) {
      logger.error("last repair flash unreadable", e);
    }
  }, []);

  const runCheck = async (deep: boolean) => {
    setBusy(deep ? "deep" : "quick");
    setError(null);
    try {
      setReport(await checkDbIntegrity(deep));
    } catch (e) {
      logger.error("db integrity check failed", e);
      setError(t("error.db", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 修复会短暂关库（Windows 上连接不关就没法换文件），挂起的写入必须先冲刷；
   * 只要动过文件，前端缓存的就不是当前磁盘上的库了，沿用备份恢复的做法整页重载。
   */
  const doRepair = async () => {
    setBusy("repair");
    setError(null);
    try {
      const r = await repairDatabase();
      setRepair(r);
      if (r.action !== "none") {
        localStorage.setItem(REPAIR_FLASH_KEY, JSON.stringify(r));
        await flushAllForClose();
        window.location.reload();
      }
    } catch (e) {
      logger.error("db repair failed", e);
      setError(t("error.db", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section title={t("settings.dbHealth")}>
        <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.dbHealthDesc")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void runCheck(false)} disabled={busy !== null}>
            {busy === "quick" ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Stethoscope className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.dbCheckQuick")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void runCheck(true)} disabled={busy !== null}>
            {busy === "deep" ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Stethoscope className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.dbCheckDeep")}
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-neutral-500">{t("settings.dbCheckDeepHint")}</p>
        {error && <div className="mt-2 text-[11px] text-red-600">{error}</div>}
        {report && (
          <div className="mt-3">
            <ReportSummary report={report} />
          </div>
        )}
        {/* 查过且确认健康就收起这条：健康库没有可修的东西（没查过时 report 为 null，仍要给入口） */}
        {!report?.ok && (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-3">
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-600"
              disabled={busy !== null}
              onClick={() => setConfirmRepair(true)}
            >
              {busy === "repair" ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.dbRepair")}
            </Button>
            <span className="text-[11px] text-neutral-500">{t("settings.dbRepairHint")}</span>
          </div>
        )}
        {repair && (
          <div className="mt-3 border-t border-neutral-200 pt-3">
            <div
              className={
                repair.ok
                  ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800"
                  : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
              }
            >
              {t(REPAIR_ACTION_KEY[repair.action])}
            </div>
            {repair.kept_aside.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] text-neutral-500">{t("settings.dbKeptAside")}</div>
                <ul className="mt-1 space-y-0.5">
                  {repair.kept_aside.map((k) => (
                    <li key={k.to} className="break-all font-mono text-[10px] text-neutral-500">
                      {k.to}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={confirmRepair}
        onOpenChange={(open) => {
          if (!open) setConfirmRepair(false);
        }}
        danger
        title={t("settings.dbRepair")}
        description={t("settings.dbRepairConfirm")}
        confirmLabel={t("settings.dbRepair")}
        onConfirm={() => {
          setConfirmRepair(false);
          void doRepair();
        }}
      />
    </>
  );
}
