import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

await mkdir('dist/extension', { recursive: true });
const runtime=await build({entryPoints:['extension/page-runtime.ts'],bundle:true,format:'iife',globalName:'FengPage',target:'chrome125',write:false,minify:true});
const runtimeSource=runtime.outputFiles[0].text;
await build({ entryPoints: ['extension/background.ts', 'extension/options.ts'], outdir: 'dist/extension', bundle: true, format: 'esm', target: 'chrome125', sourcemap: true,
  plugins:[{name:'page-runtime-source',setup(build){build.onResolve({filter:/^virtual:page-runtime$/},()=>({path:'page-runtime',namespace:'page-source'}));build.onLoad({filter:/.*/,namespace:'page-source'},()=>({contents:`export default ${JSON.stringify(runtimeSource)}`,loader:'js'}));}}] });
// 一键更新把包里的文件平铺写进扩展目录，所以图标不能放子目录。
for (const file of ['manifest.json', 'options.html', 'options.css', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) await copyFile(`extension/${file}`, `dist/extension/${file}`);
await writeFile('dist/extension/pairing.json', JSON.stringify({ port: 17422, token: '' }));
console.log('扩展已构建到 dist/extension；npm run setup 会生成本机已配对版本。');
