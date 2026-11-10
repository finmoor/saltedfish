// Puppeteer 会把函数序列化到页面，读值函数保持自包含；类型错误也作为夹具错误明确失败。
export function inputValue(element: Element): string {
  if (!(element instanceof HTMLInputElement)) throw new Error('Expected an input fixture');
  return element.value;
}
export function textareaValue(element: Element): string {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea fixture');
  return element.value;
}
export function checkedValue(element: Element): boolean {
  if (!(element instanceof HTMLInputElement)) throw new Error('Expected an input fixture');
  return element.checked;
}
export function innerText(element: Element): string {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML fixture');
  return element.innerText;
}
export function editableMarkup(element: Element): { html: string; text: string } {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML fixture');
  return { html: element.innerHTML, text: element.innerText };
}
