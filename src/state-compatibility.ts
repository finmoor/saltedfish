import { access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// 管理器只读取格式标记，不初始化 StateStore，也不迁移、恢复或回滚任务数据库。
export async function databaseStateVersion(file: string): Promise<number> {
  try { await access(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new Error('无法确认当前任务数据库格式，未切换版本。');
    return version;
  } finally { database.close(); }
}

export async function assertDatabaseReadable(file: string, supportedVersion: number): Promise<void> {
  const current = await databaseStateVersion(file);
  if (current > supportedVersion) throw new Error(`当前任务数据库格式 ${current} 超过目标版本支持的 ${supportedVersion}；保留当前版本与维护记录，请修复当前版或安装兼容更新，不回滚任务数据库。`);
}
