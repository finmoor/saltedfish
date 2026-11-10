import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { GatewayConfig, startGateway } from './remote-gateway.js';
import { remoteUrl } from './remote-protocol.js';
import { VERSION } from './version.js';
import { gatewayClientSetup } from './gateway-setup.js';
import { connectClients, connectHelp } from './client-connect.js';
import { CODEX_TOOL_SCHEMA_MAX_BYTES, MCP_NAME } from './client-config.js';
import { gatewayPairing, validateGatewayTls } from './gateway-tls.js';
import { gatewayAgentsCommand, gatewayAgentsHelp, takeGatewayAgentOption } from './gateway-agents.js';
import { registerMachineCommand, machineRegistrationHelp } from './machine-registration.js';

const command = process.argv[2];
const option = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const directory = path.resolve(option('data-dir', './gateway-data')!);
try {
  if (command === 'init') {
    const host = option('host', '127.0.0.1')!, port = Number(option('port', '18443'));
    const cert = option('cert'), key = option('key'), localPort = Number(option('local-port', '18444'));
    const device = { id: randomUUID(), label: option('device-name', '我的电脑')!, token: randomBytes(32).toString('hex') };
    const agents = ['claude', 'opencode', 'codex'].map(label => ({ id: randomUUID(), label, token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*' as const, readOnly: false }));
    if(!!cert!==!!key)throw new Error('TLS 证书与私钥必须同时提供。');
    const url = option('url', `${cert ? 'https' : 'http'}://${host}:${port}`)!; remoteUrl(url);
    const config = GatewayConfig.parse({ host, port, localPort, allowedHosts:[new URL(url).host], ...(cert && key ? { tls: { cert: path.resolve(cert), key: path.resolve(key) } } : {}), devices: [device], agents });
    // 所有可预检的 TLS 失败（含证书是否覆盖 --url 主机、证书链能否放进配对 Token）发生在任何配置或凭据落盘之前。
    const ca = await validateGatewayTls(config.tls, new URL(url).hostname);
    const pairing = gatewayPairing(device.token, ca);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // wx 防止初始化覆盖已有授权或证书；失败时保留现场，必须使用新的空目录。
    await writeFile(path.join(directory, 'gateway.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'device-pairing.token'), pairing, { flag: 'wx', mode: 0o600 });
    const endpoint = `http://127.0.0.1:${localPort}/mcp`;
    for (const agent of agents) {
      await writeFile(path.join(directory, `${agent.label}.token`), agent.token, { flag: 'wx', mode: 0o600 });
      if (agent.label === 'codex') {
        await writeFile(path.join(directory, 'codex-remote.toml'), `[mcp_servers.${MCP_NAME}]\nurl = "${endpoint}"\nbearer_token_env_var = "FENG_CHROME_TOKEN"\nstartup_timeout_sec = 20\ntool_timeout_sec = 330\ntool_input_schema_max_bytes = ${CODEX_TOOL_SCHEMA_MAX_BYTES}\n`, { flag: 'wx', mode: 0o600 });
        continue;
      }
      const entry = { type: agent.label === 'claude' ? 'http' : 'remote', url: endpoint, headers: { Authorization: `Bearer ${agent.token}` } };
      const rendered = agent.label === 'claude' ? { mcpServers: { [MCP_NAME]: entry } } : { mcp: { servers: { [MCP_NAME]: { ...entry, oauth: false } } } };
      await writeFile(path.join(directory, `${agent.label}-remote.json`), JSON.stringify(rendered, null, 2), { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({ version: VERSION, directory, url, pairingFile: path.join(directory, 'device-pairing.token'), mcpUrl: endpoint, note: '凭据已写入私有文件，不在日志显示。将 device-pairing.token 填入本机工作台，agent 使用各自 remote.json。' }));
  } else if (command === 'register-machine') {
    const args = process.argv.slice(3); takeGatewayAgentOption(args, '--data-dir');
    console.log(JSON.stringify(await registerMachineCommand(directory, args), null, 2));
  } else if (command === 'connect') {
    const args = process.argv.slice(3); takeGatewayAgentOption(args, '--data-dir');
    const agent = takeGatewayAgentOption(args, '--agent');
    await connectClients(await gatewayClientSetup(directory, undefined, agent), args);
  } else if (command === 'agents') {
    const args = process.argv.slice(3); takeGatewayAgentOption(args, '--data-dir');
    const entry = path.resolve(process.argv[1]!);
    const home = process.env.SALTEDFISH_MANAGED === '1' && process.env.SALTEDFISH_HOME ? path.resolve(process.env.SALTEDFISH_HOME) : undefined;
    // npm 的核心子进程保留原安装目录；直接运行核心入口时保留实际入口和 data-dir。
    const managed = home !== undefined && directory === path.join(home, 'data', 'gateway') && entry === path.join(home, 'versions', VERSION, 'dist', 'gateway-cli.js');
    const invocation = { platform: process.platform,
      command: managed ? [process.execPath, path.join(path.dirname(entry), 'npm-cli.js'), 'gateway'] : [process.execPath, ...process.execArgv, entry],
      suffix: managed ? ['--home', home!] : ['--data-dir', directory] };
    console.log(JSON.stringify(await gatewayAgentsCommand(directory, args, invocation), null, 2));
  } else if (command === 'serve') {
    const platform = process.platform;
    const onboarding = platform === 'win32' || platform === 'linux' || platform === 'darwin'
      ? { platform, command: [process.execPath, path.resolve(process.argv[1]!)], suffix: ['--data-dir', directory] } : undefined;
    const app = await startGateway(JSON.parse(await readFile(path.join(directory, 'gateway.json'), 'utf8')), { agentConfigFile: path.join(directory, 'gateway.json'), ...(onboarding ? { onboarding } : {}) });
    console.error(`SaltedFish remote gateway ${VERSION} listening on ${app.config.host}:${app.config.port}`);
    const stop = () => void app.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else console.log(`SaltedFish Gateway: init --data-dir DIR --host IP --port 18443 --local-port 18444 [--cert PEM --key PEM] [--url https://HOST:PORT] | serve --data-dir DIR | ${gatewayAgentsHelp} --data-dir DIR | ${connectHelp} [--agent UUID] --data-dir DIR | ${machineRegistrationHelp} --data-dir BACKUP_DIR`);
} catch (error) { console.error(error instanceof Error && 'code' in error ? error.message : '网关操作失败。检查配置、证书、目录权限、客户端凭据及端口；已有文件不会被初始化覆盖。'); process.exitCode = 1; }
