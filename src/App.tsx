import { useEffect, useState } from "react";
import { getDb } from "./lib/db";

// M1 冒烟测试：建表成功 → 插入一条记录 → 读回；已存在则直接读回（验证重启持久化）。
function App() {
  const [status, setStatus] = useState("connecting to database...");
  const [stored, setStored] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<{ value: string }[]>(
          "SELECT value FROM app_settings WHERE key = 'm1_test'",
        );
        if (rows.length > 0) {
          setStored(rows[0].value);
          setStatus("Hello from AppFlowy TS (M1) - record read back from previous run, data persisted");
        } else {
          await db.execute(
            "INSERT INTO app_settings(key, value) VALUES ('m1_test', 'hello-from-run-1')",
          );
          const back = await db.select<{ value: string }[]>(
            "SELECT value FROM app_settings WHERE key = 'm1_test'",
          );
          setStored(back[0]?.value ?? "?");
          setStatus("Hello from AppFlowy TS (M1) - inserted test record and read it back");
        }
      } catch (e) {
        console.error("M1 db smoke test failed", e);
        setStatus("DB ERROR: " + String(e));
      }
    })();
  }, []);

  return (
    <div style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1>{status}</h1>
      <p>Stored value: {stored}</p>
    </div>
  );
}

export default App;
