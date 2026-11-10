import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {migratedConnection} from '../extension/connection-migration.js';

test('浏览器迁移只匹配原ID和原配对，名称、暂停状态保留；新服务选择不被覆盖',async()=>{
  const profileId=randomUUID(),old={profileId,label:'我的浏览器',port:17423,token:'a'.repeat(64),enabled:false};
  const connection={version:1,serviceUrl:'https://service.example',profileId,pairingId:randomUUID(),token:'b'.repeat(64),managerToken:'c'.repeat(64)};
  const code='sf-connect:'+Buffer.from(JSON.stringify(connection)).toString('base64url');
  const migration={id:randomUUID(),fromServiceUrl:'http://127.0.0.1:17423',fromTokenHash:createHash('sha256').update(old.token).digest('hex'),connections:[code]};
  const next=(await migratedConnection(old,migration))!;assert.equal(next.profileId,profileId);assert.equal(next.label,old.label);assert.equal(next.enabled,false);assert.equal(next.token,connection.token);assert.equal(next.serviceUrl,connection.serviceUrl);assert.ok(next.protectedServices?.includes(migration.fromServiceUrl));
  assert.equal(await migratedConnection(next,migration),undefined);assert.equal(await migratedConnection({...old,profileId:randomUUID()},migration),undefined);assert.equal(await migratedConnection({...old,token:'d'.repeat(64)},migration),undefined);assert.equal(await migratedConnection({...old,serviceUrl:'https://chosen.example'},migration),undefined);assert.equal(await migratedConnection(old,{...migration,connections:[code,code]}),undefined);
});
