import { BrowserError, NOT_DISPATCHED } from '../src/shared';

// 不同窗口可并行，同一窗口的视觉任务排队：最小化窗口的恢复和还原按窗口做，两个动作交错会把窗口留在错的状态。
// （0.3.24 起视觉动作不再切换当前标签页，原先“同一窗口只有一个活动标签”的理由不在了，排队先保留。）
// 排队等待的拒绝都发生在 action 运行之前，因此是明确的“未派发”（NOT_DISPATCHED），不会让服务端隔离标签页。
export class WindowLocks {
  private tails = new Map<number, Promise<void>>();

  async run<T>(windowId: number, deadline: number, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(windowId) || Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(windowId, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserError('WINDOW_BUSY', '同一窗口的其他视觉任务未结束；此次操作尚未执行。', NOT_DISPATCHED)), Math.max(0, deadline - Date.now()));
      })]);
      if (timer) clearTimeout(timer);
      if (Date.now() >= deadline) throw new BrowserError('WINDOW_BUSY', '等待窗口时截止时间已到，此次操作尚未执行。', NOT_DISPATCHED);
      return await action();
    } finally {
      if (timer) clearTimeout(timer);
      release();
      void tail.then(() => { if (this.tails.get(windowId) === tail) this.tails.delete(windowId); });
    }
  }
}
