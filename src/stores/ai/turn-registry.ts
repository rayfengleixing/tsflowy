// 一轮问答的「轮次登记」：哪一轮在流、轮到几了、哪些轮被用户停过。
//
// 这三件原本是 `create` 闭包里的 `let streamingAssistantId` / `let turnSeq` / `const cancelledTurns`。
// agent 循环与 `stop` 一直搬不出去，卡的就是前两个 `let` 标量：闭包变量被别的模块接走后，
// 那边重新赋值这边读不到。收进一个对象以后，共享的是引用（字段写、`Set` 增删），两边看的是同一份。
//
// 语义与原来逐字对齐：`assistantId` 只在「有一轮正在流」时非空，轮次收尾时清空；
// `seq` 每发起一轮自增一次，`seq === 本轮轮号` 就是「本轮仍是当前轮」；
// `cancelled` 装被用户点过「停止」的轮号，那一轮的 done 帧迟到也不得自动落地编辑。

export interface TurnRegistry {
  /** 当前流式中的助手消息 id：`stop()` 据此标记「用户主动中止的这一轮」 */
  assistantId: string | null;
  /** 轮次序号：每发起一轮自增一次，取到的值即该轮的轮号 */
  seq: number;
  /**
   * 被用户停止的轮号集合。必须是每轮独立 token 而不是单个布尔——旧实现里 stop() 后置 true、
   * 下一次发消息重置 false，被停那轮迟到的 done 会绕过取消判定自动写数据。
   */
  cancelled: Set<number>;
}

/** 每份 store 一份登记：由 store 工厂在 create 时调用一次，按引用注入 run 切片与流式切片 */
export function createTurnRegistry(): TurnRegistry {
  return { assistantId: null, seq: 0, cancelled: new Set<number>() };
}
