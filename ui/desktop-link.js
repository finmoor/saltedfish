import {serviceAddress} from './service-address.js';
const routes = new Set(['overview', 'setup', 'remote', 'agents']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parametersFromText(text) {
  if (!text) return new URLSearchParams();
  if (text.split('&').some(part => !/^[a-z]+=[A-Za-z0-9-]+$/.test(part))) return null;
  return new URLSearchParams(text);
}

/** 只处理显示与导航目标；桌面启动器仍会独立检查协议与授权。 */
function targetFromParameters(route, parameters) {
  if (!routes.has(route)) return null;
  const keys = [...parameters.keys()];
  if (keys.some(key => !['profile', 'add'].includes(key)) || new Set(keys).size !== keys.length) return null;
  if (route !== 'agents' && keys.length) return null;
  const profile = parameters.get('profile'), add = parameters.get('add');
  if (profile !== null && !uuid.test(profile) || add !== null && add !== '1') return null;
  const query = new URLSearchParams();
  if (profile !== null) query.set('profile', profile);
  if (add !== null) query.set('add', add);
  return route + (query.size ? '?' + query.toString() : '');
}

export function settingsTarget(value) {
  if (typeof value !== 'string' || value.length > 200 || value.includes('#')) return null;
  const parts = value.split('?');
  if (parts.length > 2 || parts.length === 2 && !parts[1]) return null;
  const parameters = parametersFromText(parts[1] || '');
  return parameters ? targetFromParameters(parts[0], parameters) : null;
}

export function desktopSettingsHref(port, target) {
  const safe = settingsTarget(target);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && safe !== null ? `saltedfish-${port}://settings/${safe}` : '';
}

/** Native Messaging 的响应只允许回到请求的本机设置页，不能变成任意导航入口。 */
export function nativeSettingsLoginUrl(value, port, target) {
  if(!Number.isInteger(port)||port<1024||port>65535)return null;
  return serviceSettingsLoginUrl(value,`http://127.0.0.1:${port}`,target,true);
}
export function serviceSettingsLoginUrl(value, origin, target, authenticated=true) {
  const safe = settingsTarget(target);
  if (typeof value !== 'string' || value.length > 4096 || typeof origin!=='string' || safe === null) return null;
  let root;try{if(serviceAddress(origin)!==origin)return null;root=new URL(origin);}catch{return null;}
  if(!authenticated)return value===origin+'/#'+safe?value:null;
  const [route, query] = safe.split('?'), params = new URLSearchParams(query || '');
  const expected = root;
  expected.searchParams.set('target', route);
  for (const [key, item] of params) expected.searchParams.set(key, item);
  const code = value.slice(value.lastIndexOf('#') + 1);
  if (code.length!==64||!/^[a-f0-9]{64}$/.test(code)) return null;
  expected.hash = code;
  return value === expected.href ? value : null;
}

export function managementReturnTarget(search) {
  const text = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  const parameters = parametersFromText(text);
  if (!parameters) return 'overview';
  const keys = [...parameters.keys()];
  if (keys.some(key => !['target', 'profile', 'add'].includes(key)) || new Set(keys).size !== keys.length) return 'overview';
  const route = parameters.get('target');
  parameters.delete('target');
  return targetFromParameters(route, parameters) || 'overview';
}
