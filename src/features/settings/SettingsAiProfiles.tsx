// AI 设置里的「模型档位」编辑区：一行一档（名称/模型/温度/协议/独立 Key）。
// 从 SettingsAi.tsx 原样搬出（逐行零改动，含新增/删除档位两个动作）。
// Key 草稿 profileKeys 仍由父级持有并回传：persistAi 要按档位 id 判「草稿为空 = 不改该档 Key」，
// 下放给子件就把那条规则拆断了。
import type { Dispatch, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AI_PROTOCOL_OPTIONS, type AiConfig, type AiProfile } from "@/lib/ai";
import { t } from "@/lib/i18n";
import { AI_NUM_INPUT, AI_PROTOCOL_LABEL_KEY, AI_TEXT_INPUT, type AiFormState } from "./settings-parts";

interface Props {
  aiForm: AiFormState;
  setAiForm: Dispatch<SetStateAction<AiFormState>>;
  aiConfig: AiConfig | null;
  profileKeys: Record<string, string>;
  setProfileKeys: Dispatch<SetStateAction<Record<string, string>>>;
  saveAi: (partial?: Partial<AiFormState>) => void;
  saveAiQuietly: (partial?: Partial<AiFormState>) => void;
}

/** 模型档位增删改：改完仍走父级 saveAi，保证整份 AI 配置一次覆盖落库 */
export function SettingsAiProfiles({
  aiForm,
  setAiForm,
  aiConfig,
  profileKeys,
  setProfileKeys,
  saveAi,
  saveAiQuietly,
}: Props) {
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

  return (
    <>
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
    </>
  );
}
