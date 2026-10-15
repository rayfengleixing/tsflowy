// 跨语言契约测试：Rust 建字段时写入的默认 options（db::database::default_options_json）
// 与 TS 侧字段类型全集/注册表读法必须对齐。同一份契约文件也被 Rust 测试读
// （src-tauri/src/db/database.rs 的 *_match_shared_contract），所以「加类型只改一边」
// 「改默认值没同步语义」都会有一条测试红。
import { describe, expect, it } from "vitest";
import contractJson from "../../contracts/field_type_contract.json";
import { FIELD_TYPES, type FieldType } from "@/types/database";
import {
  defaultValue,
  formatCellValue,
  isOptionBearing,
  parseFieldOptions,
  validateCellValue,
} from "./database-values";
import { fieldKind, isDateKind } from "./field-kinds";

interface Contract {
  types: { type: string; defaultOptions: unknown }[];
  triggerManagedTimestampTypes: string[];
}

const contract = contractJson as unknown as Contract;
const defaultOptionsByType = new Map(contract.types.map((e) => [e.type as FieldType, e.defaultOptions]));

describe("字段类型跨语言契约", () => {
  it("契约覆盖的类型集合与 FieldType 全集一致（新增类型要先补契约）", () => {
    expect([...defaultOptionsByType.keys()].sort()).toEqual([...FIELD_TYPES].sort());
  });

  it("默认 options 写成 select 分支的类型，正好是注册表声明的 optionBearing 类型", () => {
    const selectDefaulted = contract.types
      .filter((e) => parseFieldOptions(JSON.stringify(e.defaultOptions)).kind === "select")
      .map((e) => e.type)
      .sort();
    expect(selectDefaulted).toEqual([...FIELD_TYPES].filter(isOptionBearing).sort());
  });

  it("Rust 写出的默认 options 能被前端解析，且该类型默认值在其中合法", () => {
    for (const type of FIELD_TYPES) {
      const raw = defaultOptionsByType.get(type);
      expect(raw, `${type} 缺契约条目`).toBeDefined();
      // 走真实解析路径：Rust 写的是 JSON 串，前端只会 parseFieldOptions 一次
      const parsed = parseFieldOptions(JSON.stringify(raw));
      const rawKind = (raw as { kind?: unknown }).kind;
      expect(typeof rawKind, `${type} 契约条目缺 kind`).toBe("string");
      expect(parsed.kind, `${type} 的默认 options 解析不出 kind`).toBe(rawKind);
      const value = defaultValue(type);
      expect(validateCellValue(type, value), `${type} 默认值与自身类型不符`).toBe(true);
      // 默认值在默认配置下应展示为空串（空格子不该冒出 "null"/"0" 之类噪音）
      expect(formatCellValue(type, value, parsed), `${type} 默认值展示非空`).toBe("");
    }
  });

  it("Rust 复制视图时跳过的触发器时间戳列，前端也按日期语义看待", () => {
    for (const type of contract.triggerManagedTimestampTypes) {
      const fieldType = type as FieldType;
      expect(FIELD_TYPES.includes(fieldType), `${type} 不在 FieldType 全集里`).toBe(true);
      expect(isDateKind(fieldType), `${type} 前端不认它是日期语义`).toBe(true);
    }
    // last_edited_at 由触发器刷新，前端任何写入都会被覆盖：粘贴必须给不出值
    expect(fieldKind("last_edited_at").paste("2026-01-01").kind).toBe("skip");
  });
});
