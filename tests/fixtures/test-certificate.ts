import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// 测试专用：在内存里生成一次性自签证书（P-256），不依赖 openssl；私钥不进入版本库，.gitignore 的 *.pem / *.key 保持生效。
// 证书和私钥只写进各测试自己的临时目录，不得用于任何真实用途。
export interface TestCertificateOptions {
  commonName?: string;
  dnsNames?: string[];
  // 仅支持 IPv4 字面量；测试需要时再扩展。
  ipAddresses?: string[];
  notBefore?: Date;
  notAfter?: Date;
  // 复用已有私钥，例如构造“同一把私钥、已过期的旧证书”。
  privateKey?: KeyObject;
}

const length = (size: number) => size < 0x80 ? Buffer.from([size]) : size < 0x100 ? Buffer.from([0x81, size]) : Buffer.from([0x82, size >> 8, size & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const oid = (dotted: string) => {
  const [first, second, ...arcs] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [first * 40 + second];
  for (const arc of arcs) { const chunk = [arc & 0x7f]; for (let high = arc >> 7; high; high >>= 7) chunk.unshift((high & 0x7f) | 0x80); bytes.push(...chunk); }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = (value: Buffer) => tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const boolean = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const time = (date: Date) => {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14), year = date.getUTCFullYear();
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
};
const subject = (commonName: string) => sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
const ecdsaSha256 = () => sequence(oid('1.2.840.10045.4.3.2'));
const ipv4 = (address: string) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error(`测试证书只支持 IPv4 字面量：${address}`);
  return Buffer.from(parts);
};

export function createTestCertificate(options: TestCertificateOptions = {}) {
  const now = Date.now(), commonName = options.commonName ?? 'saltedfish-test';
  const privateKey = options.privateKey ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) || 1;
  const alternativeNames = [...(options.dnsNames ?? []).map(dns => tlv(0x82, Buffer.from(dns, 'ascii'))), ...(options.ipAddresses ?? []).map(address => tlv(0x87, ipv4(address)))];
  const extensions = [
    // CA:TRUE：自签证书同时作为配对 Token 里的信任锚。
    sequence(oid('2.5.29.19'), boolean(true), tlv(0x04, sequence(boolean(true)))),
    ...(alternativeNames.length ? [sequence(oid('2.5.29.17'), tlv(0x04, sequence(...alternativeNames)))] : []),
  ];
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), integer(serial), ecdsaSha256(), subject(commonName),
    sequence(time(options.notBefore ?? new Date(now - 24 * 3600_000)), time(options.notAfter ?? new Date(now + 30 * 24 * 3600_000))),
    subject(commonName), Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), tlv(0xa3, sequence(...extensions)));
  const der = sequence(tbs, ecdsaSha256(), tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKey,
  };
}
