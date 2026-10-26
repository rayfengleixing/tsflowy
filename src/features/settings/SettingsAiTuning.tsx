// AI 设置里「采样参数 / 思考模式 / 上下文范围 / 网络与 agent 调优 / 系统提示」这一整块。
// 从 SettingsAi.tsx 的 JSX 边界原样搬出（逐行零改动）：ai_save_config 是整份覆盖式保存，
// 表单值与落库都留在父级，这里只接 aiForm 加两个保存回调，避免配置状态出现两份真值。
import type { Dispatch, SetStateAction } from "react";

import { t } from "@/lib/i18n";
import { AI_NUM_INPUT, Row, type AiFormState } from "./settings-parts";

interface Props {
  aiForm: AiFormState;
  setAiForm: Dispatch<SetStateAction<AiFormState>>;
  saveAi: (partial?: Partial<AiFormState>) => void;
  saveAiQuietly: (partial?: Partial<AiFormState>) => void;
}

/** 采样/上下文/网络调优与系统提示：数值离开输入框后交回父级整份落库 */
export function SettingsAiTuning({ aiForm, setAiForm, saveAi, saveAiQuietly }: Props) {
  return (
    <>
      {/* 采样参数 */}
      <div className="grid gap-2 sm:grid-cols-2">
        <Row label={t("settings.aiTemperature")}>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={aiForm.temperature}
            onChange={(e) => setAiForm((f) => ({ ...f, temperature: Number(e.target.value) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiMaxTokens")}>
          <input
            type="number"
            min={0}
            max={200000}
            step={100}
            value={aiForm.maxTokens}
            onChange={(e) => setAiForm((f) => ({ ...f, maxTokens: Number(e.target.value) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiCtxBudget")}>
          <input
            type="number"
            min={100}
            max={200000}
            step={100}
            value={aiForm.ctxTokenBudget}
            onChange={(e) => setAiForm((f) => ({ ...f, ctxTokenBudget: Number(e.target.value) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiCtxMaxMessages")}>
          <input
            type="number"
            min={1}
            max={500}
            step={1}
            value={aiForm.ctxMaxMessages}
            onChange={(e) => setAiForm((f) => ({ ...f, ctxMaxMessages: Number(e.target.value) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiPriceIn")}>
          <input
            type="number"
            min={0}
            max={100000}
            step={0.1}
            value={aiForm.priceInput}
            onChange={(e) => setAiForm((f) => ({ ...f, priceInput: Math.max(0, Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiPriceOut")}>
          <input
            type="number"
            min={0}
            max={100000}
            step={0.1}
            value={aiForm.priceOutput}
            onChange={(e) => setAiForm((f) => ({ ...f, priceOutput: Math.max(0, Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
      </div>
      <p className="-mt-2 text-[11px] text-neutral-400">{t("settings.aiPriceDesc")}</p>
      <p className="-mt-2 text-[11px] text-neutral-400">
        {t("settings.aiCtxDesc", { budget: aiForm.ctxTokenBudget, messages: aiForm.ctxMaxMessages })}
      </p>

      {/* 思考模式 */}
      <Row label={t("settings.aiThinking")}>
        <div className="flex flex-col gap-1">
          <select
            value={aiForm.thinking === "off" ? "off" : "auto"}
            onChange={(e) => saveAi({ thinking: e.target.value })}
            className="w-fit rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
          >
            <option value="auto">{t("settings.aiThinkingAuto")}</option>
            <option value="off">{t("settings.aiThinkingOff")}</option>
          </select>
          <p className="max-w-80 text-[11px] text-neutral-500">{t("settings.aiThinkingDesc")}</p>
        </div>
      </Row>

      {/* 上下文范围 */}
      <Row label={t("settings.aiCtxScope")}>
        <div className="flex flex-col gap-1">
          <select
            value={["page_only", "off"].includes(aiForm.ctxScope) ? aiForm.ctxScope : "full"}
            onChange={(e) => saveAi({ ctxScope: e.target.value })}
            className="w-fit rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
          >
            <option value="full">{t("settings.aiCtxScopeFull")}</option>
            <option value="page_only">{t("settings.aiCtxScopePageOnly")}</option>
            <option value="off">{t("settings.aiCtxScopeOff")}</option>
          </select>
          <p className="max-w-80 text-[11px] text-neutral-500">{t("settings.aiCtxScopeDesc")}</p>
        </div>
      </Row>

      {/* 网络与 agent 循环参数：本地模型 / 自建网关慢时唯一的自救口子 */}
      <div className="grid gap-2 sm:grid-cols-2">
        <Row label={t("settings.aiAgentRounds")}>
          <input
            type="number"
            min={0}
            max={12}
            step={1}
            value={aiForm.agentRounds}
            onChange={(e) => setAiForm((f) => ({ ...f, agentRounds: Math.trunc(Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiStreamRetries")}>
          <input
            type="number"
            min={0}
            max={5}
            step={1}
            value={aiForm.streamRetries}
            onChange={(e) => setAiForm((f) => ({ ...f, streamRetries: Math.trunc(Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiFirstByteTimeout")}>
          <input
            type="number"
            min={0}
            max={600}
            step={5}
            value={aiForm.firstByteTimeout}
            onChange={(e) => setAiForm((f) => ({ ...f, firstByteTimeout: Math.trunc(Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
        <Row label={t("settings.aiIdleTimeout")}>
          <input
            type="number"
            min={0}
            max={1800}
            step={10}
            value={aiForm.idleTimeout}
            onChange={(e) => setAiForm((f) => ({ ...f, idleTimeout: Math.trunc(Number(e.target.value)) }))}
            onBlur={() => saveAiQuietly()}
            className={AI_NUM_INPUT}
          />
        </Row>
      </div>
      <p className="-mt-2 text-[11px] text-neutral-400">{t("settings.aiTuningDesc")}</p>

      {/* 自定义系统提示 */}
      <div>
        <p className="mb-1 text-sm font-medium text-neutral-800">{t("settings.aiSystemPrompt")}</p>
        <textarea
          rows={3}
          value={aiForm.systemPrompt}
          onChange={(e) => setAiForm((f) => ({ ...f, systemPrompt: e.target.value }))}
          onBlur={() => saveAiQuietly()}
          placeholder={t("settings.aiSystemPromptPlaceholder")}
          className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
      </div>
    </>
  );
}
