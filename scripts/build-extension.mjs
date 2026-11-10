import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认构建“加载已解压的扩展程序”用的版本到 dist/extension（npm 包带的就是它）。
// --store 构建 Chrome 应用商店版到 dist/extension-store：build-target.ts 换成 STORE_BUILD=true，self-update.ts 换成 self-update-store.ts，
// 商店版里没有下载、改写自己文件的代码（应用商店不允许，也由商店更新）。--outdir 换输出目录（测试用）。
const args = process.argv.slice(2), store = args.includes('--store'), at = args.indexOf('--outdir');
const outdir = at >= 0 ? path.resolve(args[at + 1]) : path.resolve(store ? 'dist/extension-store' : 'dist/extension');
const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));

await mkdir(outdir, { recursive: true });
const runtime=await build({entryPoints:['extension/page-runtime.ts'],bundle:true,format:'iife',globalName:'FengPage',target:'chrome125',write:false,minify:true});
const runtimeSource=runtime.outputFiles[0].text;
const pageRuntime = {name:'page-runtime-source',setup(build){build.onResolve({filter:/^virtual:page-runtime$/},()=>({path:'page-runtime',namespace:'page-source'}));build.onLoad({filter:/.*/,namespace:'page-source'},()=>({contents:`export default ${JSON.stringify(runtimeSource)}`,loader:'js'}));}};
const storeTarget = {name:'store-target',setup(build){
  build.onResolve({filter:/^\.\/build-target$/},args=>path.resolve(args.resolveDir)===path.resolve(extensionDir)?{path:'build-target',namespace:'store-target'}:undefined);
  build.onLoad({filter:/.*/,namespace:'store-target'},()=>({contents:'export const STORE_BUILD = true;',loader:'js'}));
  build.onResolve({filter:/^\.\/self-update$/},args=>path.resolve(args.resolveDir)===path.resolve(extensionDir)?{path:path.join(extensionDir,'self-update-store.ts')}:undefined);
}};
await build({ entryPoints: ['extension/background.ts', 'extension/options.ts'], outdir, bundle: true, format: 'esm', target: 'chrome125', sourcemap: true,
  plugins: store ? [pageRuntime, storeTarget] : [pageRuntime] });
// 一键更新把包里的文件平铺写进扩展目录，所以图标不能放子目录。
for (const file of ['manifest.json', 'options.html', 'options.css', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) await copyFile(`extension/${file}`, path.join(outdir, file));
await writeFile(path.join(outdir, 'pairing.json'), JSON.stringify({ port: 17422, token: '' }));
if (store) {
  // 商店版带英文和中文的描述（_locales）。默认版不带：一键更新只认平铺的文件，不能有子目录。
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  manifest.default_locale = 'en'; manifest.description = '__MSG_extDescription__'; manifest.action.default_title = '__MSG_actionTitle__';
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const locale of ['en', 'zh_CN']) {
    await mkdir(path.join(outdir, '_locales', locale), { recursive: true });
    await copyFile(`extension/store-locales/${locale}/messages.json`, path.join(outdir, '_locales', locale, 'messages.json'));
  }
  // 换没换成功，看产物里还有没有写文件夹的代码；有就不算商店版。
  for (const file of ['background.js', 'options.js']) {
    const code = await readFile(path.join(outdir, file), 'utf8');
    for (const word of ['showDirectoryPicker', 'createWritable', 'requestPermission']) if (code.includes(word)) throw new Error(`商店版 ${file} 里还有一键更新的代码（${word}）。`);
  }
  console.log(`应用商店版扩展已构建到 ${path.relative(process.cwd(), outdir) || outdir}；打包用 npm run package:extension-store。`);
} else console.log('扩展已构建到 dist/extension；npm run setup 会生成本机已配对版本。');
