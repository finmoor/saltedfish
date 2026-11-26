import { BrowserError, NOT_DISPATCHED, type JsonObject } from '../src/shared';

interface Dialog { dialogId: string; type: string; message: string; messageTruncated: boolean; frameId?: string; sessionId?: string; commandId?: string }
interface Job { commandId: string; deadline: number; valid: () => boolean; reject: (error: Error) => void; interrupted: boolean; policy?: JsonObject; policyArmed?:boolean; handled?: JsonObject; response?: Promise<unknown>; progress?: {index:number;results:unknown[]}; leaving?: boolean }

// 每个标签一个已观察弹窗；只响应明确声明的下一次弹窗，永不全局自动接受。
export class Dialogs {
  private open = new Map<number, Dialog>();
  private jobs = new Map<number, Job>();
  // chrome_action 带了 beforeUnload:"accept"：动作期间和结束后一小段时间里，这个标签页的下一个“确定离开吗”直接答离开，只认 beforeunload，用一次就作废。
  // 页面常在动作返回之后才弹（先发请求、回来再跳转或关窗口），只管动作期间就接不住。
  private leaveUntil = new Map<number, number>();
  private leftAt = new Map<number, number>();
  constructor(private handle: (tabId: number, args: JsonObject, sessionId?: string) => Promise<unknown>) {}
  has(tabId: number) { return this.open.has(tabId); }
  current(tabId: number): Readonly<Dialog> | undefined { return this.open.get(tabId); }
  allowLeave(tabId: number, until: number) { if (until > Date.now()) this.leaveUntil.set(tabId, until); else this.leaveUntil.delete(tabId); }
  // 动作结束：还没用掉的授权只再留一小段，接住随后才弹的框。
  narrowLeave(tabId: number, graceMs: number) { if (this.leaveUntil.has(tabId)) this.allowLeave(tabId, Date.now() + graceMs); }
  // 最近一次按 allowLeave 答“离开”的时间；动作结果据此写 beforeUnload:"accepted"。
  leftSince(tabId: number, since: number) { return (this.leftAt.get(tabId) ?? 0) >= since; }
  arm(tabId:number) {const job=this.jobs.get(tabId);if(job?.policy)job.policyArmed=true;}
  progress(tabId:number,index:number,results:unknown[]) {const job=this.jobs.get(tabId);if(job)job.progress={index,results};}
  interrupted(tabId:number) {return !!this.jobs.get(tabId)?.interrupted;}
  interruptedBatch(tabId:number,error:BrowserError) {const p=this.jobs.get(tabId)?.progress;return {completed:false,failedIndex:p?.index??0,results:p?.results.slice()??[],error:{code:error.code,message:error.message},note:'弹窗已打开，后续步骤停止；用 chrome_dialog 响应，不重复执行已完成步骤。'};}
  assert(tabId: number) { if (this.jobs.get(tabId)?.interrupted) throw new BrowserError('DIALOG_OPEN', '本次操作因弹窗停止，后续步骤未执行。'); }
  // 关标签页时（答了“离开”或者根本没弹框）标签页随即关掉、调试连接断开，这是预期的结果，不算中断。
  forget(tabId: number) { const hadDialog=this.open.has(tabId);this.open.delete(tabId);this.leaveUntil.delete(tabId); const job=this.jobs.get(tabId); if(job && !(job.leaving && (job.handled || !hadDialog)) && (hadDialog || job.policy)){job.interrupted=true;job.reject(new BrowserError('CONNECTION_CHANGED','弹窗所属调试连接已变化。'));} }
  closed(tabId: number) { this.open.delete(tabId); }
  opening(tabId: number, params: JsonObject, sessionId?: string): JsonObject {
    if (this.open.has(tabId)) return { ...params, ...this.open.get(tabId) };
    const job=this.jobs.get(tabId), message=String(params.message || '');
    const dialog: Dialog={dialogId:crypto.randomUUID(),type:String(params.type),message:message.slice(0,2001),messageTruncated:message.length>2001,frameId:typeof params.frameId==='string'?params.frameId:undefined,sessionId,commandId:job?.commandId};
    this.open.set(tabId,dialog);
    // allowLeave 的授权只认 beforeunload；作业自己声明过的策略优先。
    const leave=dialog.type==='beforeunload'&&(this.leaveUntil.get(tabId)??0)>Date.now();
    if (job) {
      const declared=job.policyArmed?job.policy:undefined; job.policy=undefined;job.policyArmed=false; // 只在目标输入即将派发时启用，等待阶段的弹窗不得提前消费授权。
      // 决定答“离开”时就记下：关窗口时答框的调用可能等不到返回，动作已经收尾，结果里照样写 beforeUnload:"accepted"。
      if (!declared && leave) { this.leaveUntil.delete(tabId); this.leftAt.set(tabId, Date.now()); }
      const policy=declared??(leave?{accept:true,expectedType:'beforeunload'}:undefined);
      if (policy && job.valid() && Date.now()<job.deadline && this.matches(dialog,policy)) {
        job.response=Promise.resolve().then(()=>{if(!job.valid() || Date.now()>=job.deadline)throw new BrowserError('CANCELLED','控制已失效，未响应弹窗。');return this.respond(tabId,{...policy,dialogId:dialog.dialogId});}).then(result=>{job.handled={dialogId:dialog.dialogId,type:dialog.type,accept:policy.accept};return result;});
        void job.response.catch(()=>{job.interrupted=true;job.reject(new BrowserError('DIALOG_RESPONSE_FAILED','弹窗响应未确认，停止后续步骤；检查当前弹窗，不重放触发动作。'));});
      } else { job.interrupted=true;job.reject(new BrowserError(policy?'DIALOG_MISMATCH':'DIALOG_OPEN',`页面打开 ${dialog.type} 弹窗（dialogId=${dialog.dialogId}，内容 ${JSON.stringify(dialog.message.slice(0,200))}）。用 chrome_dialog 响应；触发动作不会重试。`)); }
    } else if (leave) {
      // 动作已经返回、页面这时才问“确定离开吗”：调用方事先说过直接离开，照答。答不上就留着，chrome_dialog 还能答。
      this.leaveUntil.delete(tabId); this.leftAt.set(tabId, Date.now());
      void this.respond(tabId,{accept:true,expectedType:'beforeunload',dialogId:dialog.dialogId}).catch(()=>{});
    }
    return { ...params, ...dialog };
  }
  private matches(dialog: Dialog, args: JsonObject) { return (args.dialogId===undefined || args.dialogId===dialog.dialogId) && (!args.expectedFrameId || args.expectedFrameId===dialog.frameId) && (!args.expectedType || args.expectedType===dialog.type) && (args.expectedMessage===undefined || !dialog.messageTruncated && args.expectedMessage===dialog.message); }
  async respond(tabId: number, args: JsonObject) {
    const dialog=this.open.get(tabId);
    // 仅这两个同步校验能证明响应未派发；handle 之后的异常仍保留未知结果。
    if (!dialog) throw new BrowserError('DIALOG_NOT_OPEN','没有已观察到的弹窗，不会发送响应。',{phase:'precondition',outcome:'not_dispatched'});
    if (args.dialogId!==dialog.dialogId || !this.matches(dialog,args)) throw new BrowserError('DIALOG_MISMATCH','弹窗已变化或与声明不符，未发送响应。',{phase:'precondition',outcome:'not_dispatched'});
    await this.handle(tabId,{accept:args.accept,...(args.promptText!==undefined?{promptText:args.promptText}:{})},dialog.sessionId);
    // handle 成功就是这个弹窗已答完；不等 javascriptDialogClosed 事件，免得紧随的命令误报 DIALOG_OPEN。只清同一个弹窗，不误删事件先到后新开的那个。
    if (this.open.get(tabId)===dialog) this.open.delete(tabId);
    return { handled:true,dialogId:dialog.dialogId,type:dialog.type,accept:args.accept };
  }
  private requireHandledDialog(job: Job): JsonObject {
    // handled 由异步 CDP 事件写入；在新的读取边界核对，避免沿用赋空时的类型收窄。
    const dialog = job.handled;
    if (!dialog) throw new BrowserError('DIALOG_EXPECTATION_NOT_MET','触发动作已执行，但没有出现预声明弹窗；停止后续步骤，不重复触发。');
    return dialog;
  }
  async expected<T>(tabId: number, policy: JsonObject, action: () => Promise<T>): Promise<{ result: T; dialog: JsonObject }> {
    if (policy.accept === true && (!policy.expectedType || typeof policy.expectedMessage !== 'string')) throw new BrowserError('DIALOG_POLICY_REQUIRED','预声明接受弹窗必须指定 expectedType 和 expectedMessage；未执行触发动作。', NOT_DISPATCHED);
    const job=this.jobs.get(tabId);
    // 这里的 DIALOG_OPEN 发生在触发动作运行之前，是明确的未派发；触发动作运行期间弹窗打开的 DIALOG_OPEN（opening/assert）仍按未知处理。
    if (!job || this.open.has(tabId)) throw new BrowserError('DIALOG_OPEN','已有弹窗，未触发新的动作。', NOT_DISPATCHED);
    job.policy=policy;job.policyArmed=false;job.handled=undefined;job.response=undefined;
    try {
      const result=await action(); await job.response; this.assert(tabId);
      return { result, dialog: this.requireHandledDialog(job) };
    } finally { job.policy=undefined;job.policyArmed=false; }
  }
  // 导航、关标签页时调用方事先说了 beforeUnload:"accept"：页面弹出“确定离开吗”就直接答离开，不打断。只认 beforeunload，别的弹窗照旧打断。
  // 没弹框也算成功（页面没挂 beforeunload）。已经有弹窗开着时不预授权，照旧执行。
  async leaving<T>(tabId: number, action: () => Promise<T>): Promise<{ result: T; accepted: boolean }> {
    const job=this.jobs.get(tabId);
    if (!job || this.open.has(tabId)) return { result: await action(), accepted: false };
    job.policy={accept:true,expectedType:'beforeunload'};job.policyArmed=true;job.leaving=true;job.handled=undefined;job.response=undefined;
    try {
      const result=await action(); await job.response; this.assert(tabId);
      return { result, accepted: !!job.handled };
    } finally { job.policy=undefined;job.policyArmed=false; }
  }
  async run<T>(tabId: number, commandId: string, deadline: number, valid: () => boolean, action: () => Promise<T>, finished: (interrupted: boolean) => Promise<void>) {
    let reject!: (error:Error)=>void;const interrupted=new Promise<never>((_,r)=>{reject=r;});
    const job: Job={commandId,deadline,valid,reject,interrupted:false};this.jobs.set(tabId,job);
    const physical=Promise.resolve().then(action).finally(async()=>{try{await finished(job.interrupted);}finally{if(this.jobs.get(tabId)===job)this.jobs.delete(tabId);}});
    return Promise.race([physical,interrupted]);
  }
}
