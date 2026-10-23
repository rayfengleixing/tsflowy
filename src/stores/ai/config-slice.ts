import { aiErrorText, aiGetConfig, aiSaveConfig } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { configPayload } from "./ops";
import type { AiSliceCreator, AiState } from "./types";

// 配置与档位这一组动作：读写的是 store 里的 config 与 Rust 侧的 ai_save_config，
// 既不碰流式轮次变量，也不调其它切片，所以只注入 set / get。
export const createConfigSlice: AiSliceCreator<
  Pick<AiState, "loadConfig" | "setConfig" | "switchProfile" | "setCtxScope">
> = (set, get) => {
  return {
    loadConfig: async () => {
      try {
        const config = await aiGetConfig();
        set({ config, configLoaded: true });
      } catch (e) {
        set({ configLoaded: true, error: aiErrorText(e) });
      }
    },
    setConfig: (config) => set({ config, configLoaded: true }),
    // 切换档位：只改 active_profile，其余配置原样回传
    switchProfile: async (id) => {
      const c = get().config;
      if (!c) return;
      try {
        await aiSaveConfig(configPayload(c, { activeProfile: id }));
        set({ config: await aiGetConfig() });
      } catch (e) {
        logger.error("ai switch profile failed", e);
        toast.error(t("ai.errorPrefix", { message: String(e) }));
      }
    },
    // 上下文范围：面板顶部就能改，改完立即生效（下一轮请求按新范围组装）
    setCtxScope: async (scope) => {
      const c = get().config;
      if (!c || c.ctx_scope === scope) return;
      try {
        await aiSaveConfig(configPayload(c, { ctxScope: scope }));
        set({ config: await aiGetConfig() });
      } catch (e) {
        logger.error("ai set context scope failed", e);
        toast.error(t("ai.errorPrefix", { message: String(e) }));
      }
    },
  };
};
