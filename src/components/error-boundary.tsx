import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

interface Props {
  /** 子树的重挂载键：一般是当前视图 id / 路由，切换即自动清除错误态 */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 路由级错误边界：页面切换/新建时子树渲染崩溃（如懒加载 chunk 失败、
 * 编辑器初始化异常）不再卸载整棵 React 树（白屏），而是就地显示兜底 UI + 重试。
 * resetKey 变化（切页/换路由）自动重置错误态。
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("RouteErrorBoundary", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-50 px-6 text-center dark:bg-neutral-900">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{t("app.errorTitle")}</h2>
          <p className="mt-1 max-w-sm text-xs text-neutral-500 dark:text-neutral-400">
            {t("app.errorDesc")}
            <span className="mt-1 block font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {this.state.error.message}
            </span>
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("app.errorRetry")}
        </Button>
      </div>
    );
  }
}
