import { createSocket } from 'node:dgram';
import { loopbackAddress, privateAddress } from './service-address.js';

export const LAN_PORT = '18445';

// UDP connect 只选路由、不发包，得到默认路由使用的本机地址，不会选到 Docker 网桥这类没有默认路由的网卡。
export function defaultRouteAddress(target = '1.1.1.1') {
  return new Promise<string | undefined>(resolve => {
    const socket = createSocket('udp4');
    const finish = (address?: string) => { socket.close(); resolve(address); };
    socket.once('error', () => finish());
    socket.connect(53, target, () => { try { finish(socket.address().address); } catch { finish(); } });
  });
}

export interface InstallNetworkOptions {
  platform: NodeJS.Platform; firstInstall: boolean; local: boolean; allowInsecureLan: boolean;
  port?: string; host?: string; url?: string; cert?: string; key?: string; localPort?: string;
  detect: () => Promise<string | undefined>;
  // 已有安装 config.json 里的监听主机和端口；--local 靠它发现要收回的内网监听。
  current?: { host?: string | undefined; port?: number | undefined };
}
const lan = (host: string, port: string | undefined, url?: string, localPort?: string) => {
  const chosen = port ?? LAN_PORT, serviceUrl = url ?? `http://${host}:${chosen}`;
  return { port: chosen, serviceUrl, networkArgs: ['--host', host, '--url', serviceUrl, '--allow-insecure-lan', ...(localPort ? ['--local-port', localPort] : [])] };
};
const provided = (options: InstallNetworkOptions) => ['--host', options.host, '--url', options.url, '--cert', options.cert, '--key', options.key, '--local-port', options.localPort].reduce<string[]>((args, value, index, all) => index % 2 === 1 && value !== undefined ? [...args, all[index - 1]!, value] : args, []);

// 决定 install 的端口与监听方式。结果里的 networkArgs 交给 configure-server，服务端原有的私网、地址一致和 TLS 校验不变。
export async function resolveInstallNetwork(options: InstallNetworkOptions): Promise<{ port?: string; networkArgs: string[]; serviceUrl?: string; note?: string }> {
  const explicit = provided(options);
  if (options.local) {
    if (explicit.length || options.allowInsecureLan) throw new Error('--local 不能和 --host、--url、--cert、--key、--local-port、--allow-insecure-lan 同时使用。');
    // 已有安装在监听内网 IP 时，--local 必须真的收回，不能返回空参数让原配置原样保留。
    const { host, port } = options.current ?? {};
    if (host && !loopbackAddress(host)) {
      if (!port) throw new Error(`已有安装监听 ${host}，但读不到它的端口，无法改成只监听本机。未改动；请先 saltedfish stop，再用 configure-server --host 127.0.0.1 --url http://127.0.0.1:<端口> 设置。`);
      return { port: options.port, networkArgs: ['--host', '127.0.0.1', '--url', `http://127.0.0.1:${port}`], note: `已把服务从 ${host} 改为只监听本机（127.0.0.1:${port}）；其他电脑上的 Chrome 扩展需要重新配置服务地址。` };
    }
    return { port: options.port, networkArgs: [] };
  }
  if (options.cert || options.key) return { port: options.port, networkArgs: [...explicit, ...(options.allowInsecureLan ? ['--allow-insecure-lan'] : [])] };
  if (options.host && privateAddress(options.host)) return lan(options.host, options.port, options.url, options.localPort);
  if (options.host && !options.url && !loopbackAddress(options.host)) throw new Error(`${options.host} 不是私网 IP，不能使用明文 HTTP。内网部署直接运行 saltedfish install，或用 --host 指定私网 IP；公网部署用 --host --url --cert --key。`);
  if (explicit.length || options.allowInsecureLan) return { port: options.port, networkArgs: [...explicit, ...(options.allowInsecureLan ? ['--allow-insecure-lan'] : [])] };
  // 已有安装不改监听方式，重复运行 install 保持原配置。Windows 和 macOS 上 Chrome 通常与服务同机，默认不对外监听。
  if (!options.firstInstall || options.platform !== 'linux') return { port: options.port, networkArgs: [] };
  const address = await options.detect();
  if (!address) throw new Error('没有找到默认路由使用的内网 IP。用 --host 指定内网 IP，或加 --local 只监听本机。');
  if (!privateAddress(address)) throw new Error(`默认路由地址 ${address} 不是私网 IP，不能使用明文 HTTP。公网部署用 --host --url --cert --key；只在本机使用加 --local。`);
  return lan(address, options.port);
}
