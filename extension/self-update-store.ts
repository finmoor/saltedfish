// 商店版构建时替换 self-update.ts（见 build-target.ts）：商店版由 Chrome 应用商店更新，
// 不下载更新包、不改写自己的文件。导出和 options.ts 用到的 self-update.ts 导出一致。
export class UpdateError extends Error{constructor(message:string,readonly wrongFolder=false){super(message);this.name='UpdateError';}}
export async function updateExtension():Promise<boolean>{throw new UpdateError('应用商店版由 Chrome 自动更新，不用在这里更新。');}
export async function filesUpdated(_version:string){return false;}
