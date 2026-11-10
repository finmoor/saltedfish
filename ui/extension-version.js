/**
 * 比较扩展版本号（manifest 的 version，点分数字）：candidate 比 current 新时为真。
 * @param {string} candidate
 * @param {string} current
 */
export function isNewerVersion(candidate, current) {
  const next = String(candidate).split('.').map(Number), now = String(current).split('.').map(Number);
  for (let index = 0; index < Math.max(next.length, now.length); index++) {
    const difference = (next[index] || 0) - (now[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

// 0.3.21 起扩展握手带 codeVersion（后台代码编译进去的版本）；没带的是 0.3.20 及更早的代码。
const LAST_WITHOUT_CODE_VERSION = '0.3.20';
const DOTTED = /^\d+(?:\.\d+)*$/;

/**
 * 扩展文件比后台在跑的代码新时给出说明，否则为空。Chrome 有时沿用旧的后台脚本：共用的扩展文件夹在这个配置关着时
 * 被另一个配置更新过，再打开时 manifest 是新的、代码还是旧的，重启也不换，重新加载才好。
 * @param {{ version?: string, codeVersion?: string }} profile
 * @returns {string}
 */
export function staleCodeHint(profile) {
  const code = profile.codeVersion || LAST_WITHOUT_CODE_VERSION;
  if (!profile.version || !DOTTED.test(profile.version) || !DOTTED.test(code) || !isNewerVersion(profile.version, code)) return '';
  return `扩展文件已是 ${profile.version}，后台还在跑${profile.codeVersion ? ` ${code} 的` : '旧'}代码。到 chrome://extensions 找到 SaltedFish 点重新加载，名称和配对都会保留。`;
}
