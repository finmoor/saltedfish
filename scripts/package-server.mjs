import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './check-release.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
const target = path.join(repo, 'release', `saltedfish-${version}-server.tar.gz`);
try { await access(target); throw new Error('已有同版本服务器包，禁止覆盖；请使用新的版本号。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = path.join(repo, '.packaging', `server-${version}-${randomUUID()}`);
await mkdir(stage, { recursive: true }); await mkdir(path.dirname(target), { recursive: true });
const files = ['dist','ui','docs','package.json','package-lock.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
for (const file of files) await cp(path.join(repo, file), path.join(stage, file), { recursive: true });
const pairing = JSON.parse(await readFile(path.join(stage, 'dist/extension/pairing.json'), 'utf8'));
if (pairing.token) throw new Error('服务器包意外包含扩展配对凭据。');
await promisify(execFile)('tar', ['-czf', target, '-C', stage, ...files], { windowsHide: true });
const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
await writeFile(`${target}.sha256`, `${sha256}  ${path.basename(target)}\n`);
await mkdir(path.join(repo, '.local'), { recursive: true });
await writeFile(path.join(repo, '.local/last-server-package.json'), JSON.stringify({ version, target, stage, sha256 }, null, 2));
console.log(JSON.stringify({ version, target, sha256 }));
