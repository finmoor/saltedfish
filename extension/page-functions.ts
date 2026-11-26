import type { JsonObject } from '../src/shared';
// 运行时只在隔离上下文首次使用时注入，热路径仅传本次调用参数。
const runtime = (body: string) => `(() => { ${body} })()`;
export function inspectExpression(args: JsonObject) { return runtime(`return FengPage.pageDom(${JSON.stringify({...args,mode:'inspect'})});`); }
export function findExpression(args: JsonObject) { return runtime(`return FengPage.pageDom(${JSON.stringify({...args,mode:'find'})});`); }
export function watchExpression() { return runtime('return FengPage.watchPage();'); }
type Point = { x: number; y: number } | undefined;
export function activityExpression(point?: Point) { return runtime(`return FengPage.pageActivity(${point ? JSON.stringify(point) : ''});`); }
export function changesExpression(point?: Point) { return runtime(`return FengPage.pageChanges(${point ? JSON.stringify(point) : ''});`); }
export function documentExpression() { return runtime('return FengPage.documentId();'); }
export function conditionExpression(args:JsonObject){return runtime(`return FengPage.matchesCondition(${JSON.stringify(args)});`);}
export function waitContextExpression(args:JsonObject){return runtime(`return FengPage.waitContext(${JSON.stringify(args)});`);}
export function elementExpression(args: JsonObject, body: string) {
  return runtime(`const element=FengPage.pageDom(${JSON.stringify({selector:args.selector,ref:args.ref,locator:args.locator,mode:'resolve'})}); const state=FengPage.elementState(element); ${body}`);
}
