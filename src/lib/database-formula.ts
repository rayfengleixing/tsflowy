import type { CellValue, DatabaseField } from "@/types/database";
import { parseFieldOptions } from "./database-values";

// 公式字段求值（纯函数，Vitest 单测）。
// 表达式语法：数字字面量 / {字段名} 引用 / + - * / ( )，运算优先级常规。
// 任一引用字段为空或非数值 → 整个公式返回 null（显示为空，符合"数量未填时总价不显示"直觉）。

type Token =
  | { kind: "num"; value: number }
  | { kind: "ref"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "(" | ")" };

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === "{") {
      const close = expr.indexOf("}", i);
      if (close === -1) return null;
      const name = expr.slice(i + 1, close).trim();
      if (!name) return null;
      tokens.push({ kind: "ref", name });
      i = close + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push({ kind: "num", value: n });
      i = j;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push({ kind: "op", op: ch as Token extends { kind: "op"; op: infer U } ? U : never });
      i++;
      continue;
    }
    return null; // 非法字符
  }
  return tokens;
}

/** 单元格值 → 参与运算的数值（checkbox true/false → 1/0；文本尝试数值化；数组/空 → null） */
function cellToNumber(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 递归下降解析求值；引用值通过 ref 回调获取（返回 null 视为公式整体无效） */
export function evalFormula(expr: string, ref: (name: string) => number | null): number | null {
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  const parseFactor = (): number | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.kind === "num") {
      eat();
      return tok.value;
    }
    if (tok.kind === "ref") {
      eat();
      return ref(tok.name);
    }
    if (tok.kind === "op" && tok.op === "(") {
      eat();
      const v = parseExpr();
      const close = eat();
      if (!close || close.kind !== "op" || close.op !== ")") return null;
      return v;
    }
    // 一元负号
    if (tok.kind === "op" && tok.op === "-") {
      eat();
      const v = parseFactor();
      return v === null ? null : -v;
    }
    return null;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    while (left !== null) {
      const tok = peek();
      if (tok?.kind === "op" && (tok.op === "*" || tok.op === "/")) {
        eat();
        const right = parseFactor();
        if (right === null) return null;
        if (tok.op === "/" && right === 0) return null; // 除零 → 空
        left = tok.op === "*" ? left * right : left / right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseExpr = (): number | null => {
    let left = parseTerm();
    while (left !== null) {
      const tok = peek();
      if (tok?.kind === "op" && (tok.op === "+" || tok.op === "-")) {
        eat();
        const right = parseTerm();
        if (right === null) return null;
        left = tok.op === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const result = parseExpr();
  // 没消费完 → 残留非法 token（如 "1 2"）
  if (result === null || pos !== tokens.length) return null;
  return Number.isFinite(result) ? result : null;
}

/** 公式字段当前行的值：字段名 → 该行同字段值；解析失败/引用为空 → null。
 *  纯展示用途（Grid/行详情/CSV 导出），不落库。 */
export function computeFormula(
  field: DatabaseField,
  rowCells: Record<string, CellValue>,
  fields: DatabaseField[],
): number | null {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "formula" || !opts.formula.trim()) return null;
  const byName = new Map(fields.map((f) => [f.name, f]));
  return evalFormula(opts.formula, (name) => {
    const target = byName.get(name);
    if (!target || target.id === field.id) return null; // 引用自身/不存在 → 无效
    return cellToNumber(rowCells[target.id] ?? null);
  });
}

/** 字段改名时同步改写公式里的 {旧名} 引用；只动引用，数字/运算符/其它引用原样保留。
 *  引用按名字解析（computeFormula 的 byName），不改写会让公式在改名后恒为空。 */
export function renameFormulaRef(formula: string, oldName: string, newName: string): string {
  return formula.replace(/\{([^}]*)\}/g, (whole, raw: string) => (raw.trim() === oldName ? `{${newName}}` : whole));
}
