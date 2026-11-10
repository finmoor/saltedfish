import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

export const packagedDocs = ['npm.md', 'branding.md', 'interaction.md', 'product-features.md', 'once-trust.md', 'supported-clients.md', 'client-compatibility.md', 'beta-limitations.md'].map(name => `docs/${name}`);

export async function packageReadme(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const extension = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  return (await readFile(path.join(root, 'packaging/npm-README.md'), 'utf8')).replaceAll('{{version}}', pkg.version).replaceAll('{{extensionVersion}}', extension.version);
}

export async function checkPackagedDocs(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const source of ['README.md', ...packagedDocs]) {
    const content = await readFile(path.join(root, source), 'utf8');
    assert.ok(!/\{\{(?:version|extensionVersion)\}\}/.test(content), `${source} 的发行变量未渲染`);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!href || /^[a-z][\w+.-]*:/i.test(href)) continue;
      const target = path.resolve(root, path.dirname(source), decodeURIComponent(href));
      assert.ok(target.startsWith(path.resolve(root) + path.sep), `${source} 的帮助链接越界`);
      await access(target).catch(() => { throw new Error(`${source} 的包内帮助不可达：${href}`); });
    }
    if (source === 'README.md' || source === 'docs/npm.md') {
      for (const match of content.matchAll(/saltedfish-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz/g)) assert.equal(match[1], pkg.version, `${source} 的安装命令版本过时`);
    }
  }
}
