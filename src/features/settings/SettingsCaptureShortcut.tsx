import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CAPTURE_SHORTCUT_DEFAULT,
  getCaptureShortcut,
  setCaptureShortcut,
  type CaptureShortcut,
} from "@/lib/app-shell";
import { eventToCombo, formatCombo, isBindableCombo } from "@/lib/shortcuts";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";

/**
 * 系统级唤起快捷键：窗口最小化、甚至藏在托盘里时也能按出来。
 * 界面显示的必须是 Rust 那边注册成功的那条 —— 所以每次改绑都以命令返回值为准，
 * 注册失败（多半被别的软件占了）就退回原值并把原因报出来，不留一个「看着生效其实没生效」的绑定。
 */
export function SettingsCaptureShortcut() {
  const [binding, setBinding] = useState<CaptureShortcut | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    getCaptureShortcut()
      .then(setBinding)
      .catch((e: unknown) => logger.warn("settings", "capture shortcut read failed", e));
  }, []);

  const apply = useCallback(async (next: CaptureShortcut) => {
    try {
      setBinding(await setCaptureShortcut(next));
      setRecording(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn("settings", "capture shortcut write failed", next.key, e);
      toast.error(t("settings.captureFailed", { message }));
    }
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // 捕获阶段拦下：这次按键只用来录，不该同时触发应用内的同键快捷键
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // 只按着修饰键：继续等真正的按键
      if (!isBindableCombo(combo)) {
        toast.error(t("settings.shortcutNeedModifier"));
        return;
      }
      // 录制即启用：用户刚按下的那条就是要生效的绑定，不该再让他勾一次复选框
      void apply({ ...combo, enabled: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, apply]);

  // 读不到就不摆一行空控件：非 Tauri 环境（开发时开浏览器）里这条本来也没意义
  if (!binding) return null;

  return (
    <div className="rounded-lg border border-neutral-200 px-3 py-2.5">
      <label className="flex items-center gap-2 text-xs text-neutral-700">
        <input
          type="checkbox"
          data-testid="capture-enabled"
          checked={binding.enabled}
          disabled={recording}
          onChange={(e) => void apply({ ...binding, enabled: e.target.checked })}
        />
        {t("settings.capture")}
      </label>
      <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-neutral-400">{t("settings.captureDesc")}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="capture-record"
          onClick={() => setRecording((v) => !v)}
          className={
            "rounded border px-1.5 py-0.5 font-mono text-[10px] shadow-sm transition-colors " +
            (recording
              ? "border-brand-500 bg-brand-50 text-brand-600"
              : "border-neutral-300 bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
          }
        >
          {recording ? t("settings.shortcutRecording") : formatCombo(binding)}
        </button>
        <button
          type="button"
          data-testid="capture-reset"
          onClick={() => void apply({ ...CAPTURE_SHORTCUT_DEFAULT })}
          className="text-[10px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
        >
          {t("settings.captureReset")}
        </button>
        {!binding.enabled ? <span className="text-[10px] text-neutral-400">{t("settings.captureOff")}</span> : null}
      </div>
    </div>
  );
}
