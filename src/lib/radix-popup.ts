/** Radix 的菜单 / 弹层用 portal 把内容挂到 body 下，但 React 的事件沿组件树而不是 DOM 树冒泡：
 *  写在某个元素内部的菜单，它的 click 仍会冒泡到那个元素的 onClick。
 *  行级组件（页面树的一行里塞着行菜单、新建菜单、图标选择器）要靠这个认出来「这一下来自弹层」，
 *  否则菜单项刚做完的动作会被行自己的点击覆盖掉。 */
export function isInsidePopup(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("[data-radix-popper-content-wrapper]") !== null;
}
