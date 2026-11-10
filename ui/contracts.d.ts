import type { OperationRecord, OperationState } from '../src/state-store.js';
import type { ProfileInfo } from '../src/shared.js';

export type ProfileIdentity = Pick<ProfileInfo, 'id' | 'label'>;
export type ProfileSummary = Pick<ProfileInfo, 'id' | 'label' | 'online'>;
/** 仪表盘 profiles[] 里的一项：离线的已知配置还带最后在线时间（服务端时钟的 ISO 字符串）。 */
export type ProfileState = ProfileIdentity & { online?: boolean; lastSeen?: string };
export type ActivityFilter = 'review' | 'all' | OperationState;
export interface ActivitySelection { profileId: string; filter: ActivityFilter; offset: number }
export interface OperationsQuery {
  profileId: string;
  offset: number;
  limit: number;
  state?: OperationState;
  acknowledged?: boolean;
}
export interface OperationsPage { items: OperationRecord[]; total: number; nextOffset: number | null }
export interface RecoverySelection { item: OperationRecord; selection: ActivitySelection; revision: number }
export type Action = () => void | Promise<unknown>;

/** /dashboard 的 protection.profiles[] 一项。online、label、lastSeen 由服务端补充（beta.22 起）；旧服务没有它们，此时一律按“在线”对待。 */
export interface ProtectionProfile { profileId: string; unknown: number; running: number; online?: boolean; label?: string; lastSeen?: string }
export interface ProtectionSummary { unknown: number; running: number; profiles: ProtectionProfile[] }

/** GET /profiles/abandon?profileId=… 的预览（仅管理员）。operations 最多 50 条、最新在前；canAbandon 为 false 时服务端会拒绝放弃。 */
export interface AbandonOperation { id: string; tabId: number | null; tool: string; state: OperationState; startedAt: string; errorCode: string | null }
export interface AbandonPreview {
  profileId: string; label: string | null; online: boolean; lastSeen: string | null;
  unknown: number; running: number; canAbandon: boolean; operations: AbandonOperation[]; note: string;
}
/** POST /profiles/abandon 的请求体必须严格是这三个字段；expectedUnknown 要等于预览里的 unknown。 */
export interface AbandonRequest { profileId: string; expectedUnknown: number; confirm: true }
export interface AbandonResult { abandoned: true; profileId: string; acknowledged: number; forgotten: boolean; replayed: false }

export interface ActivityDependencies {
  call: {
    (name: 'chrome_operations', args: OperationsQuery): Promise<OperationsPage>;
    (name: 'chrome_recover_operation', args: { operationId: string; acknowledged: true }): Promise<unknown>;
  };
  /** 管理页对本机服务的请求封装（带会话令牌、会话变化时丢弃旧响应；失败的 Error 上挂着服务端错误码）。 */
  request: {
    (route: string): Promise<AbandonPreview>;
    (route: '/profiles/abandon', method: 'POST', value: AbandonRequest): Promise<AbandonResult>;
  };
  el: <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => HTMLElementTagNameMap[K];
  button: (label: string, action: (node: HTMLButtonElement) => void | Promise<unknown>, className?: string, canEnable?: () => boolean) => HTMLButtonElement;
  run: (control: HTMLButtonElement, action: Action, canEnable?: () => boolean) => Promise<void>;
  /** 全页状态栏（#status）：对话框已经关闭之后的结果说明写在这里。 */
  status: HTMLElement;
  getProfiles: () => ProfileState[];
  /** 最近一次仪表盘读取时刻（服务端时钟）；还没读取过时为 undefined。 */
  getCheckedAt: () => string | undefined;
  onRecovered: Action;
  /** 放弃成功后刷新整页状态（提示区、浏览器列表、账号选择框）。 */
  onAbandoned: Action;
}
