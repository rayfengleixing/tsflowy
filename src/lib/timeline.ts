// 时间线视图的日期/刻度纯逻辑：从 TimelineView.tsx 抽出，便于单测与复用。
// 约定：所有时间戳为本地时区毫秒；"YYYY-MM-DD" 按本地零点解析，避开 Date.parse 的时区歧义。

export type Scale = "day" | "week" | "month";
export type ScaleMode = "auto" | Scale;

export const DAY_MS = 86_400_000;
/** 轴刻度上限：极端数据（如跨数十年 + 日粒度）下兜底，避免渲染爆炸 */
export const MAX_TICKS = 600;

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" → 本地零点时间戳；非法返回 null（按本地时区构造，避开 Date.parse 的时区歧义） */
export function parseDateKey(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

/** 把时间戳下取整到刻度边界（日/周一起/月初） */
export function floorToScale(ms: number, scale: Scale): number {
  const d = new Date(ms);
  if (scale === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (scale === "week") {
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 推进一个刻度单位 */
export function addUnit(scale: Scale, ms: number): number {
  const d = new Date(ms);
  if (scale === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  if (scale === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function tickLabel(scale: Scale, ms: number): string {
  const d = new Date(ms);
  return scale === "month" ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 自动分档：跨度小时日，大时周/月（粗粒度） */
export function autoScale(spanDays: number): Scale {
  if (spanDays <= 21) return "day";
  if (spanDays <= 120) return "week";
  return "month";
}

/** 计算轴的域（起止）与刻度列表；pct 为相对轴宽的百分比 */
export function buildAxis(
  range: { min: number; max: number },
  scale: Scale,
): { domainStart: number; span: number; ticks: { pct: number; label: string }[] } {
  const domainStart = floorToScale(range.min, scale);
  const domainEnd = addUnit(scale, floorToScale(range.max, scale));
  const span = domainEnd - domainStart || DAY_MS;
  const ticks: { pct: number; label: string }[] = [];
  let t0 = domainStart;
  let guard = 0;
  while (t0 <= domainEnd && guard < MAX_TICKS) {
    ticks.push({ pct: ((t0 - domainStart) / span) * 100, label: tickLabel(scale, t0) });
    t0 = addUnit(scale, t0);
    guard++;
  }
  return { domainStart, span, ticks };
}
