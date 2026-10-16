import { useEffect, useState } from "react";
import { Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
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
  type AiProfile,
  type AiQuickActionDef,
} from "@/lib/ai";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { AI_PROVIDER_LABEL_KEY, AI_PROTOCOL_LABEL_KEY, Section, Row, type AiFormState } from "./settings-parts";

// AI 设置里反复用到的输入控件样式（档位与快捷指令的编辑行数较多，抽出来避免重复）
const AI_NUM_INPUT =
  "h-7 w-24 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-brand-500";
const AI_TEXT_INPUT =
  "h-7 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-brand-500";

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
    maxTokens: 0,
    systemPrompt: "",
    profiles: [],
    activeProfile: "",
    quickActions: [],
    useTools: false,
    priceInput: 0,
    priceOutput: 0,
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
      maxTokens: c.max_tokens,
      systemPrompt: c.system_prompt,
      profiles: c.profiles,
      activeProfile: c.active_profile,
      quickActions: c.quick_actions,
      useTools: c.use_tools,
      priceInput: c.price_input,
      priceOutput: c.price_output,
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

  // — 模型档位 —
  const addProfile = () => {
    const profile: AiProfile = {
      id: `p${Date.now().toString(36)}`,
      name: t("settings.aiProfileDefaultName"),
      base_url: aiForm.baseUrl,
      model: aiForm.model,
      temperature: aiForm.temperature,
    };
    saveAi({ profiles: [...aiForm.profiles, profile] });
  };
  const removeProfile = (id: string) => {
    saveAi({
      profiles: aiForm.profiles.filter((p) => p.id !== id),
      activeProfile: aiForm.activeProfile === id ? "" : aiForm.activeProfile,
    });
  };

  // — 自定义快捷指令 —
  const addQuickAction = () => {
    const action: AiQuickActionDef = {
      id: `q${Date.now().toString(36)}`,
      name: t("settings.aiActionDefaultName"),
      prompt: "",
      scope: "selection",
    };
    saveAi({ quickActions: [...aiForm.quickActions, action] });
  };
  const updateQuickAction = (id: string, patch: Partial<AiQuickActionDef>) => {
    saveAi({ quickActions: aiForm.quickActions.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };
  const removeQuickAction = (id: string) => {
    saveAi({ quickActions: aiForm.quickActions.filter((a) => a.id !== id) });
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

      {/* 模型档位 */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-sm font-medium text-neutral-800">{t("settings.aiProfiles")}</p>
          <Button size="sm" variant="outline" onClick={addProfile}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("settings.aiAddProfile")}
          </Button>
        </div>
        {aiForm.profiles.length === 0 ? (
          <p className="text-[11px] text-neutral-500">{t("settings.aiProfilesEmpty")}</p>
        ) : (
          <div className="space-y-1.5">
            {aiForm.profiles.map((p) => (
              <div key={p.id} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
                <div className="flex items-center gap-1.5">
                  <input
                    value={p.name}
                    onChange={(e) =>
                      setAiForm((f) => ({
                        ...f,
                        profiles: f.profiles.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)),
                      }))
                    }
                    onBlur={() => saveAiQuietly()}
                    placeholder={t("settings.aiProfileName")}
                    className={`${AI_TEXT_INPUT} w-24`}
                  />
                  <input
                    value={p.model}
                    onChange={(e) =>
                      setAiForm((f) => ({
                        ...f,
                        profiles: f.profiles.map((x) => (x.id === p.id ? { ...x, model: e.target.value } : x)),
                      }))
                    }
                    onBlur={() => saveAiQuietly()}
                    placeholder={t("settings.aiModelPlaceholder")}
                    className={`${AI_TEXT_INPUT} min-w-0 flex-1 font-mono`}
                  />
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={p.temperature}
                    onChange={(e) =>
                      setAiForm((f) => ({
                        ...f,
                        profiles: f.profiles.map((x) =>
                          x.id === p.id ? { ...x, temperature: Number(e.target.value) } : x,
                        ),
                      }))
                    }
                    onBlur={() => saveAiQuietly()}
                    title={t("settings.aiTemperature")}
                    className={`${AI_NUM_INPUT} w-16`}
                  />
                  <button
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-red-500"
                    title={t("settings.aiRemoveProfile")}
                    onClick={() => removeProfile(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  value={p.base_url}
                  onChange={(e) =>
                    setAiForm((f) => ({
                      ...f,
                      profiles: f.profiles.map((x) => (x.id === p.id ? { ...x, base_url: e.target.value } : x)),
                    }))
                  }
                  onBlur={() => saveAiQuietly()}
                  placeholder={t("settings.aiBaseUrlPlaceholder")}
                  className={`${AI_TEXT_INPUT} mt-1 w-full font-mono`}
                />
                <div className="mt-1 flex items-center gap-1.5">
                  <select
                    value={p.protocol ?? ""}
                    onChange={(e) =>
                      saveAi({
                        profiles: aiForm.profiles.map((x) => (x.id === p.id ? { ...x, protocol: e.target.value } : x)),
                      })
                    }
                    title={t("settings.aiProtocol")}
                    className={`${AI_TEXT_INPUT} w-36`}
                  >
                    <option value="">{t("settings.aiProfileInherit")}</option>
                    {AI_PROTOCOL_OPTIONS.filter((o) => o !== "").map((o) => (
                      <option key={o} value={o}>
                        {t(AI_PROTOCOL_LABEL_KEY[o])}
                      </option>
                    ))}
                  </select>
                  <input
                    type="password"
                    value={profileKeys[p.id] ?? ""}
                    onChange={(e) => setProfileKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                    onBlur={() => saveAiQuietly()}
                    autoComplete="off"
                    placeholder={
                      aiConfig?.profiles.some((x) => x.id === p.id && x.has_api_key)
                        ? t("settings.aiProfileKeySavedPlaceholder")
                        : t("settings.aiProfileKeyPlaceholder")
                    }
                    className={`${AI_TEXT_INPUT} min-w-0 flex-1 font-mono`}
                  />
                </div>
                {aiConfig?.profiles.some((x) => x.id === p.id && x.has_api_key && x.api_key_masked) && (
                  <p className="mt-0.5 text-[11px] text-neutral-400">
                    {`${t("settings.aiApiKeySaved")}：${aiConfig.profiles.find((x) => x.id === p.id)?.api_key_masked ?? ""}`}
                  </p>
                )}
                {/* 档位 Key 未能写进凭据库时才会明文落 config.json：与全局 Key 同样明示 */}
                {aiConfig?.profiles.some((x) => x.id === p.id && x.has_api_key && x.api_key_plaintext) && (
                  <p className="mt-0.5 text-[11px] text-amber-600">{t("settings.aiApiKeyPlaintextWarn")}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 自定义快捷指令 */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-sm font-medium text-neutral-800">{t("settings.aiActions")}</p>
          <Button size="sm" variant="outline" onClick={addQuickAction}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("settings.aiAddAction")}
          </Button>
        </div>
        {aiForm.quickActions.length === 0 ? (
          <p className="text-[11px] text-neutral-500">{t("settings.aiActionsEmpty")}</p>
        ) : (
          <div className="space-y-1.5">
            {aiForm.quickActions.map((a) => (
              <div key={a.id} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
                <div className="flex items-center gap-1.5">
                  <input
                    value={a.name}
                    onChange={(e) =>
                      setAiForm((f) => ({
                        ...f,
                        quickActions: f.quickActions.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)),
                      }))
                    }
                    onBlur={() => saveAiQuietly()}
                    placeholder={t("settings.aiActionName")}
                    className={`${AI_TEXT_INPUT} w-24`}
                  />
                  <select
                    value={a.scope}
                    onChange={(e) => updateQuickAction(a.id, { scope: e.target.value as AiQuickActionDef["scope"] })}
                    className={`${AI_TEXT_INPUT} w-28`}
                  >
                    <option value="selection">{t("settings.aiScopeSelection")}</option>
                    <option value="page">{t("settings.aiScopePage")}</option>
                    <option value="none">{t("settings.aiScopeNone")}</option>
                  </select>
                  <button
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-red-500"
                    title={t("settings.aiRemoveAction")}
                    onClick={() => removeQuickAction(a.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={a.prompt}
                  onChange={(e) =>
                    setAiForm((f) => ({
                      ...f,
                      quickActions: f.quickActions.map((x) => (x.id === a.id ? { ...x, prompt: e.target.value } : x)),
                    }))
                  }
                  onBlur={() => saveAiQuietly()}
                  placeholder={t("settings.aiActionPromptPlaceholder")}
                  className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
                />
              </div>
            ))}
          </div>
        )}
      </div>

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
