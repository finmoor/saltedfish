import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// 命令行经管理接口、服务进程直接读写状态库，两边建出来的凭据和记录文件一样。
export interface CredentialStore {
  list(): Promise<{ id: string; revoked: boolean }[]>;
  create(label: string, profiles: '*' | string[], readOnly: boolean): Promise<{ id: string; token: string }>;
  remove(id: string): Promise<unknown>;
}
export interface SavedCredential { id: string; tokenFile: string }
const recordPath = (dataDir: string, label: string) => path.join(dataDir, 'clients', `${/^[a-zA-Z0-9_-]+$/.test(label) ? label : createHash('sha256').update(label).digest('hex').slice(0, 20)}.json`);

export async function savedCredential(dataDir: string, label: string): Promise<SavedCredential | undefined> {
  try { return JSON.parse(await readFile(recordPath(dataDir, label), 'utf8')) as SavedCredential; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
// reuseExisting 沿用这个名字已有的凭据，撤销过的也不复活；令牌文件丢了才作废重建。
export async function clientCredential(dataDir: string, store: CredentialStore, label: string, profiles: '*' | string[] = '*', readOnly = false, reuseExisting = false) {
  const folder = path.join(dataDir, 'clients'); await mkdir(folder, { recursive: true });
  const saved = reuseExisting ? await savedCredential(dataDir, label) : undefined;
  if (saved) {
    const existing = (await store.list()).find(client => client.id === saved.id);
    if (existing?.revoked) return saved;
    if (existing) {
      try { await access(saved.tokenFile); return saved; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await store.remove(saved.id); }
    }
  }
  const created = await store.create(label, profiles, readOnly);
  const tokenFile = path.join(folder, `${created.id}.token`);
  await writeFile(tokenFile, created.token, { mode: 0o600 });
  const record = { id: created.id, tokenFile };
  await writeFile(recordPath(dataDir, label), JSON.stringify(record), { mode: 0o600 }); return record;
}
