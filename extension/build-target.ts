// 构建目标。默认是“加载已解压的扩展程序”用的版本（npm 包和管理页下载的都是它），能在设置页里一键更新。
// Chrome 应用商店版由 `node scripts/build-extension.mjs --store` 构建：构建时把这个文件换成 STORE_BUILD=true，
// 再把 self-update.ts 换成 self-update-store.ts，商店版里没有下载、改写自己文件的代码，由应用商店更新。
export const STORE_BUILD: boolean = false;
