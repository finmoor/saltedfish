import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopSettingsHref,managementReturnTarget,nativeSettingsLoginUrl,settingsTarget} from '../ui/desktop-link.js';

const profile='6b1f0c3e-2d4a-4f7e-9c51-8a3d2e7b4c90';
test('桌面设置链接仅包含固定路由、当前端口和有意义的Agent参数',()=>{
  assert.equal(desktopSettingsHref(17423,'remote'),'saltedfish-17423://settings/remote');
  assert.equal(desktopSettingsHref(17423,`agents?add=1&profile=${profile}`),`saltedfish-17423://settings/agents?profile=${profile}&add=1`);
  for(const port of [0,80,1023,65536,17423.5,NaN])assert.equal(desktopSettingsHref(port,'remote'),'');
  for(const target of ['tasks','https://example.test','//remote','remote/','remote?next=setup',`setup?profile=${profile}`,'agents?add=0','agents?profile=not-a-uuid',`agents?profile=${profile}&profile=${profile}`,'agents?add=1&add=1','remote#token','agents?add=1?extra','constructor','agents?add=%31','agents?add=1&','agents?add=1&&']){
    assert.equal(settingsTarget(target),null,target);assert.equal(desktopSettingsHref(17423,target),'',target);
  }
});

test('本机通信响应严格绑定端口、完整目标与一次性登录码，拒绝宽松URL规范化',()=>{
 const code='a'.repeat(64),target=`agents?profile=${profile}&add=1`,valid=`http://127.0.0.1:17423/?target=agents&profile=${profile}&add=1#${code}`;
 assert.equal(nativeSettingsLoginUrl(valid,17423,target),valid);
 for(const value of [valid.replace('127.0.0.1','localhost'),valid.replace('17423','17424'),valid.replace('http:','https:'),valid.replace('127.0.0.1','evil.test@127.0.0.1'),valid.replace('/?','/other?'),valid.replace('target=agents','target=remote'),valid.replace('&add=1',''),valid.replace('&add=1','&add=1&next=remote'),valid.replace('#','#'+code),valid.replace('#'+code,'#remote'),valid+'\n',valid.replace('target=agents','target=%61gents'),valid.replace('/?','/./?')])assert.equal(nativeSettingsLoginUrl(value,17423,target),null);
 assert.equal(nativeSettingsLoginUrl(undefined,17423,target),null);assert.equal(nativeSettingsLoginUrl(valid,80,target),null);assert.equal(nativeSettingsLoginUrl(valid,17423,'other'),null);
});

test('桌面登录返回目标严格解析，非法查询整体回概览，旧登录链接仍回概览',()=>{
  assert.equal(managementReturnTarget('?target=remote'),'remote');
  assert.equal(managementReturnTarget(`?target=agents&profile=${profile}&add=1`),`agents?profile=${profile}&add=1`);
  assert.equal(managementReturnTarget('?target=setup'),'setup');
  for(const search of ['',undefined,'?target=tasks','?target=remote&target=setup','?target=remote&next=https://example.test','?target=agents&add=0',`?target=remote&profile=${profile}`,'?target=constructor',`?target=agents&profile=${profile}&profile=${profile}`,'?target=remote%3Fadd%3D1','?target=%72emote','?target=remote&','?target=remote&&'])assert.equal(managementReturnTarget(search),'overview',String(search));
});
