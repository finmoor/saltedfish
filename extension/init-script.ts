import { BrowserError, NOT_DISPATCHED, type JsonObject } from '../src/shared';

// 新文档加载前的脚本（chrome_navigate、chrome_new_tab 的 initScript）：导航派发前用 Page.addScriptToEvaluateOnNewDocument 登记在标签页的主会话上，
// 调用返回时撤销，只管这一次导航。Chrome 在每个新文档建好全局对象、页面脚本还没运行时执行它，主世界、主 frame 和同进程的 iframe 都会跑；
// 跨进程的 iframe 是另外的调试会话，不跑。

/**
 * 调用方的脚本按函数体执行，外面套一层函数：顶层声明留在函数里，不在页面全局作用域里建变量。
 * 非管理员主体再加一道：落到受保护的页面（本机管理页、扩展自己的页面）时整段不执行。
 * 用 self.origin 判断（about:blank 和 srcdoc 的 iframe 继承父文档的 origin，location.origin 是 "null"）；这时页面脚本还没运行，改不了它。
 * 服务在参数校验时已经确认 source 单独就是合法的函数体（tools.ts 的 isFunctionBody），所以它没法提前闭合这层函数、跑到判断外面去。
 */
export function initScriptSource(source: string, protectedOrigins: readonly string[] = []): string {
  const skip = protectedOrigins.map(origin => `self.origin===${JSON.stringify(origin)}`).join('||');
  return `${skip ? `if(!(${skip}))` : ''}(function(){\n${source}\n})();`;
}

type Send = (method: string, params?: JsonObject) => Promise<JsonObject>;

/** 一次导航期间登记的脚本。add 在派发前调用，失败就是未派发；remove 在调用返回时调用，失败只报告，不改导航本身的结果。 */
export function initScriptRegistration(send: Send) {
  let identifier: string | undefined;
  return {
    get registered() { return identifier !== undefined; },
    async add(source: string) {
      try { identifier = String((await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier); }
      catch (error) { throw new BrowserError('INIT_SCRIPT_REJECTED', `Chrome 没有接受 initScript，尚未导航：${error instanceof Error ? error.message : String(error)}`, NOT_DISPATCHED); }
    },
    /** true：已撤销，或调试连接已经断开（登记随会话一起消失）。false：撤销失败，这个标签页之后的新文档可能还会跑它，直到调试连接断开。 */
    async remove(): Promise<boolean> {
      if (identifier === undefined) return true;
      const id = identifier; identifier = undefined;
      try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }); return true; }
      catch (error) { return /not attached|detached|No tab with given id|Cannot access/i.test(error instanceof Error ? error.message : String(error)); }
    },
  };
}
