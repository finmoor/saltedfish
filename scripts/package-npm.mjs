import {cp,mkdir,readFile,writeFile,lstat,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import { sourceBoundBuild } from './source-bound-build.mjs';
import { packagedDocs, packageReadme, checkPackagedDocs } from './release-docs.mjs';
import { sourceFingerprint, normalizedSourceFingerprint, sourceProvenance, previousRelease } from './release-evidence.mjs';

const run=promisify(execFile),repo=fileURLToPath(new URL('..',import.meta.url));
const candidate=process.argv.includes('--candidate');
if (!candidate) throw new Error('只能构建候选包：传 --candidate；验收通过后使用 release:npm 冻结，不能跳过发行门槛。');
const npm=process.env.npm_execpath || path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
// 与源码指纹同一时刻固定 git 提交和工作区状态。被指纹覆盖却被 .gitignore 排除的文件，干净检出里不存在，指纹无法复现，直接拒绝。
const provenance = await sourceProvenance(repo), normalizedFingerprint = await normalizedSourceFingerprint(repo);
if (provenance.ignoredCovered.length) throw new Error(`以下文件被源码指纹覆盖，却被 .gitignore 排除，干净检出里不会有它们：${provenance.ignoredCovered.join('、')}。删除它们，或调整 .gitignore 并纳入版本控制后重新构建候选。`);
const record = await sourceBoundBuild({
 fingerprint: () => sourceFingerprint(repo),
 build: async () => {
  await run(process.execPath,[npm,'run','build'],{cwd:repo,windowsHide:true,maxBuffer:4*1024*1024});
  await import('./check-release.mjs');
 },
 pack: async (fingerprint) => {
const source=JSON.parse(await readFile(path.join(repo,'package.json'),'utf8')),version=source.version;
const { STATE_VERSION } = await import(pathToFileURL(path.join(repo,'dist/version.js')).href);
const out=path.join(repo,`.local/npm-candidates/${randomUUID()}`);
await mkdir(out,{recursive:true});
const filename=`saltedfish-${version}.tgz`,target=path.join(out,filename);
// npm-package 集成测试用它做“真实上一版升级/回滚、拒绝不兼容降级”场景；没有更早的发行时才允许没有 previous。
const previous=await previousRelease(path.join(repo,'release'),version);
try{await access(target);throw new Error('已有同版本 npm 包，禁止覆盖。');}catch(e){if(e.code!=='ENOENT')throw e;}
const stage=path.join(repo,'.packaging',`npm-${version}-${randomUUID()}`);await mkdir(stage,{recursive:true});
const pkg={...source};delete pkg.devDependencies;delete pkg.scripts;
pkg.files = [...pkg.files.filter(file => !file.startsWith('docs/')), 'docs/'];
await writeFile(path.join(stage,'package.json'),JSON.stringify(pkg,null,2)+'\n');
await cp(path.join(repo,'package-lock.json'),path.join(stage,'package-lock.json'));
for(const file of ['dist','ui','LICENSE','THIRD_PARTY_NOTICES.md',...packagedDocs]){await mkdir(path.dirname(path.join(stage,file)),{recursive:true});await cp(path.join(repo,file),path.join(stage,file),{recursive:true});}
await writeFile(path.join(stage,'README.md'), await packageReadme(repo));
await checkPackagedDocs(stage);
await run(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,windowsHide:true,maxBuffer:2*1024*1024});
const listing=JSON.parse((await run(process.execPath,[npm,'pack','--dry-run','--json','--ignore-scripts'],{cwd:stage,windowsHide:true,maxBuffer:8*1024*1024})).stdout)[0];
const files={};
for(const file of listing.files){
  const relative=file.path.replaceAll('\\','/');
  if(/^(?:data|\.local|\.git|release|tests|src|packaging)\//.test(relative)||/\.(?:token|pem|key|sqlite|db)$/.test(relative)||path.isAbsolute(relative)||relative.split('/').includes('..'))throw new Error(`发行包包含不应分发的路径：${relative}`);
  const actual=path.join(stage,relative);if(!(await lstat(actual)).isFile())throw new Error(`不支持分发链接：${relative}`);
  files[relative]=createHash('sha256').update(await readFile(actual)).digest('hex');
}
const pairing=JSON.parse(await readFile(path.join(stage,'dist/extension/pairing.json'),'utf8'));if(pairing.token)throw new Error('分发扩展包含配对密钥。');
if(!Object.keys(files).some(p=>p.startsWith('node_modules/@modelcontextprotocol/sdk/')))throw new Error('npm 包没有自含生产依赖。');
await writeFile(path.join(stage,'saltedfish-release.json'),JSON.stringify({product:'saltedfish-npm',version,stateVersion:STATE_VERSION,files},null,2));
const packed=JSON.parse((await run(process.execPath,[npm,'pack','--json','--ignore-scripts','--pack-destination',out],{cwd:stage,windowsHide:true,maxBuffer:12*1024*1024})).stdout)[0];
if(packed.filename!==filename)throw new Error('npm 包名不符合发行约定。');
const sha256=createHash('sha256').update(await readFile(target)).digest('hex');
await writeFile(`${target}.sha256`,`${sha256}  ${filename}\n`);
await mkdir(path.join(repo,'.local'),{recursive:true});
return {version,target,stage,sha256,candidate,sourceFingerprint:fingerprint,normalizedSourceFingerprint:normalizedFingerprint,provenance,...(previous?{previous}:{}),files:packed.entryCount,size:packed.size,bundled:packed.bundled};
 },
 commit: record => writeFile(path.join(repo,'.local/last-npm-package.json'),JSON.stringify(record,null,2))
});
console.log(JSON.stringify(record));
