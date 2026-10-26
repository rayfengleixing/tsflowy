import { useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAiStore } from "@/stores/ai";
import {
  aiGetConfig,
  aiListModels,
  aiProfileKeyInput,
  aiSaveConfig,
  aiTestConnection,
  AI_PROVIDER_PRESETS,
  AI_PROTOCOL_OPTIONS,
  type AiConfig,
} from "@/lib/ai";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { AI_PROVIDER_LABEL_KEY, AI_PROTOCOL_LABEL_KEY, Section, Row, type AiFormState } from "./settings-parts";
import { SettingsAiProfiles } from "./SettingsAiProfiles";
import { SettingsAiQuickActions } from "./SettingsAiQuickActions";
import { SettingsAiTuning } from "./SettingsAiTuning";

/** AI 助手配置：服务商/协议/模型/Key/采样参数/档位/快捷指令 */
export function SettingsAi() {
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [aiForm, setAiForm] = useState<AiFormState>({
    enabled: false,
    provider: "custom",
    protocol: "",
    baseUrl: "",
    model: "",
    maxChars: 8000,
    confirmEdit: true,
    temperature: 0.7,
    thinking: "auto",
    ctxTokenBudget: 3000,
    ctxMaxMessages: 40,
    ctxScope: "full",
    maxTokens: 0,
    systemPrompt: "",
    profiles: [],
    activeProfile: "",
    quickActions: [],
    useTools: false,
    priceInput: 0,
    priceOutput: 0,
    agentRounds: 4,
    firstByteTimeout: 30,
    idleTimeout: 120,
    streamRetries: 2,
  });
  const [aiApiKey, setAiApiKey] = useState("");
  // 档位专用 Key 草稿（按档位 id）：保存成功后清空，留空的草稿表示「不修改该档 Key」
  const [profileKeys, setProfileKeys] = useState<Record<string, string>>({});
  const [busyAiTest, setBusyAiTest] = useState(false);
  // 从服务端拉取到的模型列表（为空表示未拉取或服务商不支持，此时模型名仍手填）
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [busyModels, setBusyModels] = useState(false);

  useEffect(() => {
    // AI 配置（内联拉取：避免把 applyAiConfig 引入 effect 依赖）
    aiGetConfig()
      .then((c) => {
        applyAiConfig(c);
        useAiStore.getState().setConfig(c);
      })
      .catch((e: unknown) => logger.error("failed to get ai config", e));
  }, []);

  const applyAiConfig = (c: AiConfig) => {
    setAiConfig(c);
    setAiForm({
      enabled: c.enabled,
      provider: AI_PROVIDER_PRESETS.some((p) => p.id === c.provider) ? c.provider : "custom",
      protocol: c.protocol,
      baseUrl: c.base_url,
      model: c.model,
      maxChars: c.max_chars,
      confirmEdit: c.confirm_edit,
      temperature: c.temperature,
      thinking: c.thinking,
      ctxTokenBudget: c.ctx_token_budget,
      ctxMaxMessages: c.ctx_max_messages,
      ctxScope: c.ctx_scope,
      maxTokens: c.max_tokens,
      systemPrompt: c.system_prompt,
      profiles: c.profiles,
      activeProfile: c.active_profile,
      quickActions: c.quick_actions,
      useTools: c.use_tools,
      priceInput: c.price_input,
      priceOutput: c.price_output,
      agentRounds: c.agent_rounds,
      firstByteTimeout: c.first_byte_timeout,
      idleTimeout: c.idle_timeout,
      streamRetries: c.stream_retries,
    });
  };

  /** 保存（可选局部更新）；apiKey 留空表示不修改（传 null），保存后清空输入框 */
  const persistAi = async (partial?: Partial<AiFormState>, apiKey = aiApiKey): Promise<void> => {
    const next = { ...aiForm, ...partial };
    setAiForm(next);
    await aiSaveConfig({
      enabled: next.enabled,
      provider: next.provider,
      protocol: next.protocol,
      baseUrl: next.baseUrl,
      model: next.model,
      maxChars: next.maxChars,
      confirmEdit: next.confirmEdit,
      temperature: next.temperature,
      thinking: next.thinking,
      ctxTokenBudget: next.ctxTokenBudget,
      ctxMaxMessages: next.ctxMaxMessages,
      ctxScope: next.ctxScope,
      maxTokens: next.maxTokens,
      systemPrompt: next.systemPrompt,
      // 档位 Key 走草稿：留空的草稿 → api_key=null（Rust 侧按 id 保留原 Key）
      profiles: next.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        base_url: p.base_url,
        model: p.model,
        temperature: p.temperature,
        protocol: p.protocol ?? "",
        api_key: aiProfileKeyInput(profileKeys[p.id] ?? ""),
      })),
      activeProfile: next.activeProfile,
      quickActions: next.quickActions,
      useTools: next.useTools,
      priceInput: next.priceInput,
      priceOutput: next.priceOutput,
      agentRounds: next.agentRounds,
      firstByteTimeout: next.firstByteTimeout,
      idleTimeout: next.idleTimeout,
      streamRetries: next.streamRetries,
      apiKey: apiKey.trim() === "" ? null : apiKey,
    });
    const c = await aiGetConfig();
    applyAiConfig(c);
    useAiStore.getState().setConfig(c);
    setAiApiKey("");
    setProfileKeys({});
  };

  const saveAi = (partial?: Partial<AiFormState>) => {
    persistAi(partial).then(
      () => toast.success(t("settings.aiSaved")),
      (e: unknown) => toast.error(t("settings.aiSaveFailed", { message: String(e) })),
    );
  };

  const saveAiQuietly = (partial?: Partial<AiFormState>) => {
    persistAi(partial).catch((e: unknown) => toast.error(t("settings.aiSaveFailed", { message: String(e) })));
  };

  /** 测试连接：先保存当前配置（Rust 侧读持久化配置）再测试 */
  const testAi = async () => {
    setBusyAiTest(true);
    try {
      await persistAi();
      const msg = await aiTestConnection();
      toast.success(t("settings.aiTestOk", { message: msg }));
    } catch (e) {
      logger.error("ai test connection failed", e);
      toast.error(t("settings.aiTestFailed", { message: String(e) }));
    } finally {
      setBusyAiTest(false);
    }
  };

  /** 拉取服务端可用模型列表：需先填好 Base URL 与 Key（Rust 侧读持久化配置） */
  const fetchModels = async () => {
    setBusyModels(true);
    try {
      await persistAi();
      const list = await aiListModels();
      setModelOptions(list);
      toast.success(t("settings.aiModelsFetched", { count: list.length }));
    } catch (e) {
      logger.error("ai list models failed", e);
      toast.error(t("settings.aiFetchModelsFailed", { message: String(e) }));
    } finally {
      setBusyModels(false);
    }
  };

  return (
    <Section title={t("settings.ai")}>
      <p className="max-w-lg text-xs text-neutral-500">{t("settings.aiDesc")}</p>
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input type="checkbox" checked={aiForm.enabled} onChange={(e) => saveAi({ enabled: e.target.checked })} />
        {t("settings.aiEnable")}
      </label>
      <Row label={t("settings.aiProvider")}>
        <select
          value={aiForm.provider}
          onChange={(e) => {
            const preset = AI_PROVIDER_PRESETS.find((p) => p.id === e.target.value);
            if (preset)
              saveAi({
                provider: preset.id,
                baseUrl: preset.baseUrl,
                model: preset.model,
                // 预设里标了原生协议就一并切过去；OpenAI 兼容的预设回到自动识别
                protocol: preset.protocol ?? "",
              });
          }}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
        >
          {AI_PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(AI_PROVIDER_LABEL_KEY[p.id])}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.aiBaseUrl")}>
        <input
          value={aiForm.baseUrl}
          onChange={(e) => setAiForm((f) => ({ ...f, baseUrl: e.target.value }))}
          onBlur={() => saveAiQuietly()}
          placeholder={t("settings.aiBaseUrlPlaceholder")}
          className="h-7 w-80 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
      </Row>
      <Row label={t("settings.aiProtocol")}>
        <div className="flex flex-col gap-1">
          <select
            value={aiForm.protocol}
            onChange={(e) => saveAi({ protocol: e.target.value })}
            className="w-fit rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
          >
            {AI_PROTOCOL_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {t(AI_PROTOCOL_LABEL_KEY[p])}
              </option>
            ))}
          </select>
          <p className="max-w-80 text-[11px] text-neutral-500">{t("settings.aiProtocolDesc")}</p>
        </div>
      </Row>
      <Row label={t("settings.aiModel")}>
        <div className="flex items-center gap-1.5">
          {modelOptions.length > 0 ? (
            // 拉取到列表后改走下拉，避免手抄模型名出错（本地 Ollama 尤其容易记错）
            <select
              value={aiForm.model}
              onChange={(e) => saveAi({ model: e.target.value })}
              className="h-7 w-64 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            >
              {(modelOptions.includes(aiForm.model) ? modelOptions : [aiForm.model, ...modelOptions])
                .filter((m) => m !== "")
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          ) : (
            <input
              value={aiForm.model}
              onChange={(e) => setAiForm((f) => ({ ...f, model: e.target.value }))}
              onBlur={() => saveAiQuietly()}
              placeholder={t("settings.aiModelPlaceholder")}
              className="h-7 w-64 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            />
          )}
          <Button size="sm" variant="outline" onClick={fetchModels} disabled={busyModels}>
            {busyModels ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            {busyModels ? t("settings.aiFetchingModels") : t("settings.aiFetchModels")}
          </Button>
        </div>
      </Row>
      <Row label={t("settings.aiApiKey")}>
        <input
          type="password"
          value={aiApiKey}
          onChange={(e) => setAiApiKey(e.target.value)}
          onBlur={() => saveAiQuietly()}
          autoComplete="off"
          placeholder={
            aiConfig?.has_api_key ? t("settings.aiApiKeyPlaceholderSaved") : t("settings.aiApiKeyPlaceholderEmpty")
          }
          className="h-7 w-80 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
      </Row>
      {aiConfig?.has_api_key && aiConfig.api_key_masked && (
        <p className="-mt-2 text-right text-[11px] text-neutral-400">
          {`${t("settings.aiApiKeySaved")}：${aiConfig.api_key_masked}`}
        </p>
      )}
      {/* 凭据库不可用时 Key 明文存在 config.json：必须让用户知情 */}
      {aiConfig?.has_api_key && aiConfig.api_key_plaintext && (
        <p className="-mt-2 text-right text-[11px] text-amber-600">{t("settings.aiApiKeyPlaintextWarn")}</p>
      )}
      <p className="-mt-2 text-[11px] text-neutral-400">{t("settings.aiApiKeyOptional")}</p>
      <Row label={t("settings.aiMaxChars")}>
        <input
          type="number"
          min={500}
          max={200000}
          value={aiForm.maxChars}
          onChange={(e) => setAiForm((f) => ({ ...f, maxChars: Number(e.target.value) }))}
          onBlur={() => saveAiQuietly()}
          className="h-7 w-28 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
      </Row>
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input
          type="checkbox"
          checked={aiForm.confirmEdit}
          onChange={(e) => saveAi({ confirmEdit: e.target.checked })}
        />
        {t("settings.aiConfirmEdit")}
      </label>
      <p className="-mt-2 text-[11px] text-neutral-500">{t("settings.aiConfirmEditDesc")}</p>

      <SettingsAiTuning aiForm={aiForm} setAiForm={setAiForm} saveAi={saveAi} saveAiQuietly={saveAiQuietly} />

      <SettingsAiProfiles
        aiForm={aiForm}
        setAiForm={setAiForm}
        aiConfig={aiConfig}
        profileKeys={profileKeys}
        setProfileKeys={setProfileKeys}
        saveAi={saveAi}
        saveAiQuietly={saveAiQuietly}
      />

      <SettingsAiQuickActions aiForm={aiForm} setAiForm={setAiForm} saveAi={saveAi} saveAiQuietly={saveAiQuietly} />

      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input type="checkbox" checked={aiForm.useTools} onChange={(e) => saveAi({ useTools: e.target.checked })} />
        {t("settings.aiUseTools")}
      </label>
      <p className="-mt-2 text-[11px] text-neutral-500">{t("settings.aiUseToolsDesc")}</p>
      <Row label="">
        <Button size="sm" variant="outline" onClick={testAi} disabled={busyAiTest}>
          {busyAiTest ? (
            <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-3.5 w-3.5" />
          )}
          {busyAiTest ? t("settings.aiTesting") : t("settings.aiTest")}
        </Button>
      </Row>
      <p className="text-[11px] text-amber-600">{t("settings.aiPrivacy")}</p>
    </Section>
  );
}
