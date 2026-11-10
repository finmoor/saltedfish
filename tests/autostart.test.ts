import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { autostartState, autostartUnit, disableAutostart, enableAutostart, runAutostart, type AutostartHost } from '../src/autostart.js';
import { stopPath } from '../src/npm-runtime.js';
import { testDirectory } from './helpers.js';

const UNIT = 'saltedfish.service';
async function host(run: (context: { fake: AutostartHost; calls: string[]; home: string; unit: string }) => Promise<void>, options: Partial<AutostartHost> = {}) {
  const temp = await testDirectory(), calls: string[] = [], home = path.join(temp.directory, 'install');
  const fake: AutostartHost = {
    system: true, directory: path.join(temp.directory, 'units'), userHome: '/root', node: '/opt/node 24/bin/node',
    supported: async () => true,
    systemctl: async (...args) => { calls.push(args.join(' ')); if (args[0] === 'is-enabled') throw new Error('not-found'); return ''; },
    linger: async () => { calls.push('linger'); },
    ...options,
  };
  try { await run({ fake, calls, home, unit: path.join(fake.directory, UNIT) }); } finally { await temp.cleanup(); }
}

test('系统服务等网络就绪，只在开机时拉一次，不接管进程', () => {
  const unit = autostartUnit('/root/.local/share/saltedfish', { system: true, node: '/root/.nvm/node', userHome: '/root' });
  for (const line of ['After=network-online.target', 'Type=oneshot', 'RemainAfterExit=yes', 'KillMode=process', 'Environment="HOME=/root"', 'WantedBy=multi-user.target']) assert.ok(unit.split('\n').includes(line), line);
  assert.match(unit, /ExecStart="\/root\/\.nvm\/node" ".*launcher\.mjs" autostart run/);
  assert.ok(!unit.includes('ExecStop'), '关机不能记成用户停了服务');
});

test('用户服务没有 network-online，靠 default.target 启动', () => {
  const unit = autostartUnit('/home/a/sf', { system: false, node: '/usr/bin/node', userHome: '/home/a' });
  assert.ok(!unit.includes('network-online')); assert.ok(unit.includes('WantedBy=default.target'));
});

test('路径里的空格和 % 按 systemd 的写法转义', () => {
  const unit = autostartUnit('/home/a/50%', { system: false, node: '/opt/node 24/node', userHome: '/home/a' });
  assert.ok(unit.includes('ExecStart="/opt/node 24/node"')); assert.ok(unit.includes('50%%'));
});

test('开启写入单元并启用，内容没变不重新加载', () => host(async ({ fake, calls, home, unit }) => {
  assert.equal(await autostartState(fake), 'off');
  await enableAutostart(home, fake);
  assert.equal(await readFile(unit, 'utf8'), autostartUnit(home, fake));
  assert.deepEqual(calls.splice(0).filter(call => !call.startsWith('is-enabled')), ['daemon-reload', `enable --now ${UNIT}`]);
  await enableAutostart(home, fake);
  assert.deepEqual(calls, [`enable --now ${UNIT}`], '已经一样就不 daemon-reload');
}));

test('换了 Node 再开启：改写入口', () => host(async ({ fake, calls, home, unit }) => {
  await enableAutostart(home, fake); calls.length = 0;
  await enableAutostart(home, { ...fake, node: '/opt/node 26/bin/node' });
  assert.ok((await readFile(unit, 'utf8')).includes('/opt/node 26/bin/node')); assert.deepEqual(calls, ['daemon-reload', `enable --now ${UNIT}`]);
}));

test('普通用户要 linger；开不了时告诉用户怎么办，不算失败', async () => {
  await host(async ({ fake, calls, home }) => { assert.equal(await enableAutostart(home, fake), undefined); assert.ok(calls.includes('linger')); }, { system: false });
  await host(async ({ fake, home }) => { assert.match((await enableAutostart(home, fake))!, /enable-linger/); }, { system: false, linger: async () => { throw new Error('denied'); } });
});

test('别的安装写的单元不覆盖、不删除', () => host(async ({ fake, calls, home, unit }) => {
  await mkdir(fake.directory, { recursive: true }); await writeFile(unit, 'ExecStart="/usr/bin/node" "/other/launcher.mjs" autostart run\n');
  await assert.rejects(enableAutostart(home, fake), /另一个 SaltedFish 安装/);
  await assert.rejects(disableAutostart(home, fake), /另一个 SaltedFish 安装/);
  assert.ok((await readFile(unit, 'utf8')).includes('/other/launcher.mjs')); assert.deepEqual(calls, []);
}));

test('关闭移除单元；没开过时什么都不做', () => host(async ({ fake, calls, home, unit }) => {
  await disableAutostart(home, fake); assert.deepEqual(calls, []);
  await enableAutostart(home, fake); calls.length = 0;
  await disableAutostart(home, fake);
  assert.deepEqual(calls, [`disable --now ${UNIT}`, 'daemon-reload']); await assert.rejects(readFile(unit), { code: 'ENOENT' });
}));

test('没有 systemd 时说清楚，不写文件', () => host(async ({ fake, calls, home, unit }) => {
  assert.equal(await autostartState(fake), 'unsupported');
  await assert.rejects(enableAutostart(home, fake), /没有 systemd/);
  await disableAutostart(home, fake);
  assert.deepEqual(calls, []); await assert.rejects(readFile(unit), { code: 'ENOENT' });
}, { supported: async () => false }));

test('开机启动：用户停过就不起来，网络没好就多试', async () => {
  const temp = await testDirectory();
  try {
    const home = temp.directory; await mkdir(path.join(home, 'run'));
    let attempts = 0;
    await runAutostart(home, async () => { if (++attempts < 3) throw new Error('EADDRNOTAVAIL'); }, 1);
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(runAutostart(home, async () => { attempts++; throw new Error('EADDRNOTAVAIL'); }, 1), /EADDRNOTAVAIL/);
    assert.equal(attempts, 12, '一直失败时不无限等，单元显示失败');
    await writeFile(stopPath(home, 'local'), 'now'); attempts = 0;
    await runAutostart(home, async () => { attempts++; }, 1);
    assert.equal(attempts, 0);
  } finally { await temp.cleanup(); }
});
