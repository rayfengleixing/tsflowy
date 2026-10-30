// 模型给的原始值 → 该字段类型真正能存的值：选项按名称匹配、缺了就地补建，日期走类型自己的归一。
// 单独成文件是因为表写入与写入闸门（cellWriteTypeSafe）都依赖它，而它不属于任何一个动作。

import { databaseApi } from "../backend/database";
import { newSelectOption, parseFieldOptions } from "../database/database-values";
import { fieldKind } from "../database/field-kinds";
import type { CellValue, DatabaseField } from "@/types/database";

/** 模型给的任意 JSON 值 → 文本：对象走 JSON 形式，避免 String() 得到 [object Object] */
function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** 模型给的单元格值 → 该字段类型能存的值（选项按名称匹配，缺失则补建选项） */
export async function coerceCell(field: DatabaseField, raw: unknown): Promise<CellValue> {
  const type = field.field_type;
  if (raw === null || raw === undefined || raw === "") return null;
  const text = cellText(raw);
  const opts = parseFieldOptions(field.options);
  const optionId = (name: string): string => {
    if (opts.kind !== "select") return name;
    const hit = opts.options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
    return hit ? hit.id : name;
  };
  switch (type) {
    case "number":
    case "progress":
    case "rating":
    case "currency": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const digits = text.replace(/[^\d.-]/g, "");
      // 一个数字都没有时不能走 Number("")——那是 0，会把「待定」这类文本静默写成零
      const n = digits === "" || digits === "-" ? NaN : Number(digits);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return raw === true || ["true", "1", "yes", "y", "是", "已", "完成"].includes(text.trim().toLowerCase());
    case "multi_select": {
      const names = (Array.isArray(raw) ? raw : text.split(/[,，、]/)).map((x) => cellText(x).trim()).filter(Boolean);
      if (opts.kind !== "select") return names;
      // 与单选一致：先补建缺失选项。落裸名称当 id 会让展示、筛选、对端关联全都对不上
      const known = new Set(opts.options.map((o) => o.name.toLowerCase()));
      const missing = names.filter((n) => !known.has(n.toLowerCase()));
      const created = [...new Set(missing)].map((name) => newSelectOption(name));
      if (created.length > 0) {
        await databaseApi.updateFieldOptions(field.id, { kind: "select", options: [...opts.options, ...created] });
      }
      return names
        .map((name) => {
          const hit = opts.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
          if (hit) return hit.id;
          return created.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? "";
        })
        .filter(Boolean);
    }
    case "single_select":
    case "status": {
      const name = text.trim();
      if (!name) return null;
      if (opts.kind === "select" && !opts.options.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
        // 新选项：直接补进字段配置，否则模型每次写新值都会落成一个裸 id
        const option = newSelectOption(name, type === "status" ? "todo" : undefined);
        await databaseApi.updateFieldOptions(field.id, { kind: "select", options: [...opts.options, option] });
        return option.id;
      }
      return optionId(name);
    }
    case "date": {
      // 走日期类型自己的粘贴归一：模型给「2024/1/5」「Jan 5, 2024」都收成 ISO，
      // 认不出的（如「下周三」）按空处理——落原文会让日期列的排序、筛选、日历分组全部失效
      const outcome = fieldKind("date").paste(text);
      return outcome.kind === "value" ? outcome.value : null;
    }
    case "url":
    case "phone":
    case "email":
    case "text":
      return text;
    default:
      return null;
  }
}
