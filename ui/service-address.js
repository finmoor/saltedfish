// 地址规则同时供服务、插件和管理页使用。
export function loopbackAddress(host) {
  return ['127.0.0.1','localhost','::1','[::1]'].includes(host);
}
export function privateAddress(host) {
  if(typeof host!=='string')return false;
  const value=host.replace(/^\[|\]$/g,'').toLowerCase();
  if(/^f[cd][0-9a-f]{2}:[0-9a-f:]+$/.test(value))return true;
  const parts=value.split('.');
  if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return false;
  const [a,b]=parts.map(Number);
  return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}
export function serviceAddress(value) {
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value))throw new Error('服务地址格式无效。');
  let url;try{url=new URL(value);}catch{throw new Error('服务地址格式无效。');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('填写服务根地址，不要包含账号、路径或查询参数。');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&(loopbackAddress(url.hostname)||privateAddress(url.hostname))))throw new Error('HTTP仅支持本机回环或私网IP；其他地址需要HTTPS。');
  return url.origin;
}
export function bridgeAddress(value) {
  const url=new URL(serviceAddress(value));url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/bridge';return url.href;
}
export function extensionOrigin(value) {
  return typeof value==='string'&&value.length===51&&/^chrome-extension:\/\/[a-p]{32}$/.test(value);
}
export function serviceTransportLabel(value) {
  const url=new URL(serviceAddress(value));return url.protocol==='https:'?'HTTPS · 已加密':loopbackAddress(url.hostname)?'本机 HTTP':'内网 HTTP · 未加密';
}
