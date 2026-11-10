import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import path from 'node:path';

// 操作系统在进程退出时释放 SQLite 文件锁，恢复命令本身不会再留下不可恢复的自旋锁。
// 这是安装管理专用数据库，不读取或改写浏览器任务数据库。
// lockFile、busyMessage 供安装管理以外的互斥使用（例如 upgrade 下载全局包的下载锁）；默认值就是原来的管理锁。
export async function withManagementMutex<T>(home: string, work: () => Promise<T>, lockFile = 'management-lock.sqlite', busyMessage = '另一个安装或恢复操作仍在进行，请稍后重试；不会抢占或杀死进程。'): Promise<T> {
  const file = path.join(home, lockFile);
  const db = new DatabaseSync(file);
  let locked = false;
  try {
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); locked = true; }
    catch { throw new Error(busyMessage); }
    await chmod(file, 0o600);
    return await work();
  } finally {
    if (locked) db.exec('ROLLBACK');
    db.close();
  }
}
