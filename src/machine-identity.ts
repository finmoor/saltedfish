import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { encodeRemoteMachineReport, parseRemoteMachineReport, type RemoteMachineReportValue } from './remote-protocol.js';

export const MACHINE_IDENTITY_HEADER = 'X-SaltedFish-Client-Machine';
export function collectMachineIdentity(input: { hostname?: string; interfaces?: ReturnType<typeof os.networkInterfaces>; now?: Date } = {}): RemoteMachineReportValue {
  const hostname = (input.hostname ?? os.hostname()).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 128);
  const loopback = new BlockList(); loopback.addSubnet('127.0.0.0', 8, 'ipv4'); loopback.addAddress('::1', 'ipv6');
  const reportedAddresses = [...new Set(Object.values(input.interfaces ?? os.networkInterfaces()).flatMap(items => items ?? [])
    .filter(item => !item.internal && !item.address.includes('%') && isIP(item.address) !== 0 && !loopback.check(item.address, isIP(item.address) === 4 ? 'ipv4' : 'ipv6'))
    .map(item => item.address))].sort((a, b) => isIP(a) - isIP(b) || a.localeCompare(b)).slice(0, 8);
  return { ...(hostname ? { hostname } : {}), reportedAddresses, reportId: randomUUID(), reportedAt: (input.now ?? new Date()).toISOString(), reportSource: 'setup_report' };
}
export function machineIdentityHeaders(report = collectMachineIdentity()): Record<string, string> {
  return { [MACHINE_IDENTITY_HEADER]: encodeRemoteMachineReport(report) };
}
export function preserveMachineIdentity(headers: Record<string, string>, previous: unknown): Record<string, string> {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return headers;
  const named = (value: Record<string, unknown>) => Object.entries(value).filter(([key]) => key.toLowerCase() === MACHINE_IDENTITY_HEADER.toLowerCase());
  const nextEntries = named(headers), oldEntries = named(previous as Record<string, unknown>);
  if (nextEntries.length !== 1 || oldEntries.length !== 1) return headers;
  const next = parseRemoteMachineReport(nextEntries[0]![1]), old = parseRemoteMachineReport(oldEntries[0]![1]);
  const addresses = (report: RemoteMachineReportValue) => JSON.stringify([...new Set(report.reportedAddresses)].sort());
  if (!next || !old || next.hostname !== old.hostname || next.reportSource !== old.reportSource || addresses(next) !== addresses(old)) return headers;
  // 普通接入保留未变化的登记事件；随机编号和采集时间本身不是配置变化。
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => key.toLowerCase() === MACHINE_IDENTITY_HEADER.toLowerCase() ? [oldEntries[0]![0], oldEntries[0]![1] as string] : [key, value]));
}
