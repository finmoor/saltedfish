import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {interactionHarness} from './interaction-harness.js';
import {verifyTodoMvc} from './todomvc-scenario.js';
import {VERSION} from '../src/version.js';

test('S18-01 real TodoMVC through SaltedFish without coordinates',async t=>{
 const h=await interactionHarness(t,'<!doctype html><title>TodoMVC test start</title>'),{page,call}=await h.open();
 const result=await verifyTodoMvc(call);await writeFile(`.local/verification/todomvc-${VERSION}-isolated.json`,JSON.stringify({version:VERSION,time:new Date().toISOString(),chrome:await h.browser.version(),...result},null,2));await page.close();
});
