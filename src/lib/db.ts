import Database from "@tauri-apps/plugin-sql";

// 所有 SQL 集中在本模块（项目说明书 9.3 节），组件不直接拼 SQL。
let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:appflowy.db");
  }
  return db;
}
