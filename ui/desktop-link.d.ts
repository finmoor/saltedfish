export function settingsTarget(value: unknown): string | null;
export function desktopSettingsHref(port: number, target: string): string;
export function nativeSettingsLoginUrl(value: unknown, port: number, target: string): string | null;
export function serviceSettingsLoginUrl(value:unknown,origin:string,target:string,authenticated?:boolean):string|null;
export function managementReturnTarget(search: unknown): string;
