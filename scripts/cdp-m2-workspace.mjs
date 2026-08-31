// M2 workspace ops verification: create/rename/switch/delete space via UI (idempotent).
(async () => {
const clickEl = (el) => {
  const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.click();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getTrigger = () =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.includes("我的工作区") ||
      b.textContent.includes("第一个空间") ||
      b.textContent.includes("第二个空间"),
  );
const openMenu = async () => {
  clickEl(getTrigger());
  await sleep(400);
};
const setInputValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

// back to workspace route if on trash
let trashBtn = document.querySelector('[data-testid="trash-button"]');
if (trashBtn && !document.body.innerText.includes("欢迎使用")) {
  clickEl(trashBtn);
  await sleep(300);
}

// 1. open workspace switcher
await openMenu();
const items0 = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent.trim());
const hasSecond = items0.includes("第二个空间");
const hasFirst = items0.includes("第一个空间");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(300);

// 2. create a new space (skip if exists)
if (!hasSecond) {
  const newSpaceItem = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim() === "新建空间");
  clickEl(newSpaceItem);
  await sleep(400);
  setInputValue(document.querySelector('[role="dialog"] input'), "第二个空间");
  await sleep(100);
  clickEl([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "确认"));
  await sleep(500);
}
const afterCreate = document.body.innerText;

// 3. rename current space (my workspace -> first space)
await openMenu();
const renameItem = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim() === "重命名空间");
if (!renameItem) return "RENAME_ITEM_NOT_FOUND: " + document.body.innerText;
clickEl(renameItem);
await sleep(400);
setInputValue(document.querySelector('[role="dialog"] input'), "第一个空间");
await sleep(100);
clickEl([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "确认"));
await sleep(500);
const afterRename = document.body.innerText;

// 4. switch to the second space
await openMenu();
const wsItem = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes("第二个空间"));
clickEl(wsItem);
await sleep(600);
const afterSwitch = document.body.innerText;

// 5. delete the second space (current space now)
await openMenu();
const delBtn = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim() === "删除空间");
if (!delBtn) return "DELETE_ITEM_NOT_FOUND: " + document.body.innerText;
clickEl(delBtn);
await sleep(400);
const dlg = document.querySelector('[role="dialog"]');
const dbtn = [...dlg.querySelectorAll("button")].find((b) => b.textContent.trim() === "删除");
if (!dbtn) return "DIALOG_DELETE_NOT_FOUND";
clickEl(dbtn);
await sleep(600);
const afterDelete = document.body.innerText;

return JSON.stringify({
  items0,
  created: hasSecond || afterCreate.includes("第二个空间"),
  renamed: afterRename.includes("第一个空间"),
  switched: afterSwitch.includes("暂无页面") || afterSwitch.includes("新建页面"),
  deleted: !afterDelete.includes("第二个空间"),
  final: afterDelete,
});
})();
