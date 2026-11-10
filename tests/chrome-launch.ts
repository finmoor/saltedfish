import { chromeTestExecutable } from './local-tools.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer-core';

export const testChromePath = chromeTestExecutable();

// Windows 版 Chrome 启动后会用空密码调一次 LogonUser，看系统账户是不是没设密码（chrome/browser/password_manager/password_manager_util_win.cc），
// 结果缓存在用户数据目录的 Local State。全新目录没有缓存，每启动一次就记一次登录失败（安全日志 4625），
// 跑一轮测试就够把本机账户锁住。Chrome 只在 os_password_last_changed 早于“现在减密码年龄”时重查，
// 所以启动前把它写成当前时间：密码此后没改过就不会再试登录。os_password_blank 按非空密码写，和 Chrome 查不到密码年龄时的假设一致。
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000; // Chrome 的时间从 1601-01-01 起算，单位微秒

export async function seedChromeUserData(userDataDir: string) {
  const file = path.join(userDataDir, 'Local State');
  await mkdir(userDataDir, { recursive: true });
  let state: { password_manager?: { os_password_blank?: boolean; os_password_last_changed?: string } } = {};
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const manager = state.password_manager ??= {};
  // 同一目录再次启动时 Chrome 已经写过真实结果，保留不动。
  if (Number(manager.os_password_last_changed) > 0) return;
  manager.os_password_blank ??= false;
  manager.os_password_last_changed = String(BigInt(Date.now() + CHROME_EPOCH_OFFSET_MS) * 1000n);
  await writeFile(file, JSON.stringify(state));
}

// 测试一律经这里启动 Chrome。没给 userDataDir 时不用 puppeteer 自建的临时目录（来不及预置），自己建一个，close 后删掉。
export async function launchTestChrome(options: LaunchOptions = {}): Promise<Browser> {
  const temporary = options.userDataDir ? undefined : await mkdtemp(path.join(tmpdir(), 'saltedfish-test-chrome-'));
  const userDataDir = options.userDataDir ?? temporary!;
  const removeTemporary = () => temporary ? rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) : Promise.resolve();
  let browser: Browser;
  try {
    await seedChromeUserData(userDataDir);
    browser = await puppeteer.launch({ executablePath: testChromePath, ...options, userDataDir });
  } catch (error) { await removeTemporary(); throw error; }
  if (temporary) {
    const close = browser.close.bind(browser);
    browser.close = async () => { try { await close(); } finally { await removeTemporary(); } };
  }
  return browser;
}
