import { randomUUID,createHmac } from 'node:crypto';
import type { z } from 'zod';
import { taskPlan, taskStep, workflowDefinition } from './tools.js';
import { compileProgram, TaskVariables, valueCondition, type Program, type ProgramStep } from './task-program.js';
import { BrowserError, errorInfo, unknownResult, pageItems, SENSITIVE_FIELD, type JsonObject, type ErrorDetails } from './shared.js';
import { adminPrincipal, allowsProfile, type Principal } from './auth.js';
import type { StateStore } from './state-store.js';
import type { ResultEnvelope } from './service.js';
import type { Connection } from './broker.js';
import type { StoredWorkflow } from './workflow-store.js';
import { recoveryAdvice } from './recovery.js';
import { VERSION } from './version.js';
import { expandWorkflow, TASK_PLAN_BYTES, TOTAL_PLAN_BYTES } from './task-limits.js';

type Plan = z.infer<typeof taskPlan>;
type Status = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'needs_review' | 'interrupted';
interface StepRecord extends ErrorDetails { operation: string; action?: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'skipped'; startedAt?: string; finishedAt?: string; operationId?: string; artifactId?:string;artifactType?:'png'|'json'; code?: string; executions?:number; verification?:'pending'|'matched'|'unconfirmed' }
export interface TaskRecord { id: string; profileId: string; tabId: number; initialTabId: number; principalId: string; name: string; status: Status; nextStep: number; steps: StepRecord[]; createdAt: string; updatedAt: string; visible: boolean; reason?: string; screenshotArtifactId?: string; screenshotCode?: string; connectionInstanceId?: string; workflowId?: string; workflowRevision?: string;submissionId?:string; quotaScope?: string }
interface Active { record: TaskRecord; plan: Plan; planBytes: number; principal: Principal; program:Program; variables:TaskVariables; iterations:Map<number,number>; executed:number; binding?: Connection; control?: 'pause' | 'cancel'; baseline?: number[];submission?:{principalId:string;id:string;fingerprint:string} }
type Workflow = StoredWorkflow;
type Invoke = (name: string, args: JsonObject, owner: string, principal: Principal, expectedConnection?: Connection) => Promise<ResultEnvelope>;
const now = () => new Date().toISOString();
// 任务结果的 owner 前缀：远程主体每次连接的 principalId 都会变，配额按跨重连稳定的 quotaScope（submissionScope）累计；本地主体和旧记录仍用 principalId。
const taskOwner = (record: Pick<TaskRecord, 'id' | 'principalId' | 'quotaScope'>) => `${record.quotaScope ?? record.principalId}:task:${record.id}`;
const terminal = new Set<Status>(['succeeded', 'failed', 'cancelled', 'needs_review', 'interrupted']);
// 新增任务分支时，编译器要求同时提供工具路由。
const taskToolNames = {
  'page.action': 'chrome_action', 'page.wait': 'chrome_wait', 'page.navigate': 'chrome_navigate',
  'page.evaluate': 'chrome_evaluate', 'page.upload': 'chrome_upload', 'page.dialog': 'chrome_dialog', 'tabs.wait': 'chrome_wait_tab',
  'page.screenshot':'chrome_screenshot', 'page.inspect':'chrome_inspect', 'page.cdp':'chrome_cdp',
  'network.start':'chrome_network_start', 'network.stop':'chrome_network_stop', 'network.body':'chrome_network_body', 'network.wait':'chrome_wait_response',
  'downloads.start':'chrome_download', 'downloads.wait':'chrome_wait_download',
} satisfies Record<Exclude<Plan['steps'][number]['operation'],`flow.${string}`>, string>;

export class TaskManager {
  private jobs = new Map<string, Active>();
  private workers = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout;
  private closing = false;
  private storageFault = false;
  private unpersisted = new Map<string, TaskRecord>();
  constructor(private state: StateStore, private invoke: Invoke, private connection: (profileId: string) => Connection | undefined, private tabDirectory: (profileId: string, connection: Connection) => Promise<number[]>,private fingerprintSecret='') {
    for (const item of state.tasks() as TaskRecord[]) if (!terminal.has(item.status)) {
      item.status = 'interrupted'; item.reason = 'SERVICE_RESTARTED'; item.updatedAt = now();
      for (const step of item.steps) if (step.state === 'running') { step.state = 'unknown'; step.code = 'SERVICE_RESTARTED'; }
      state.saveTask(item);
    }
    this.timer = setInterval(() => this.pump(), 200); this.timer.unref();
  }
  stats() { return { queuedTasks: [...this.jobs.values()].filter(job => job.record.status === 'queued').length, activeTaskProfiles: this.workers.size, queuedPlanBytes: [...this.jobs.values()].reduce((sum, job) => sum + job.planBytes, 0), taskStorageFault: this.storageFault ? 'TASK_JOURNAL_FAILED' : null, unpersistedTasks: this.unpersisted.size }; }
  private assertHealthy() { if (this.storageFault) throw new BrowserError('TASK_JOURNAL_FAILED', '任务记录未能可靠保存，队列已停止。先核查页面和已完成步骤，修复存储并重启服务；不会自动续跑。'); }
  private tripStorage(job: Active) {
    this.storageFault = true;
    for (const waiting of this.jobs.values()) if (['queued','paused'].includes(waiting.record.status)) {
      waiting.record.status = 'paused'; waiting.record.reason = 'TASK_JOURNAL_FAILED'; waiting.record.updatedAt = now();
      this.unpersisted.set(waiting.record.id, structuredClone(waiting.record));
    }
    this.unpersisted.set(job.record.id, structuredClone(job.record));
  }
  private bind(job: Active) {
    const connection = this.connection(job.record.profileId);
    if (!connection) throw new BrowserError('PROFILE_OFFLINE', '原账号连接已断开，后续步骤未派发。');
    if (job.binding && job.binding !== connection) throw new BrowserError('CONNECTION_CHANGED', '浏览器连接已变化，旧任务不能继续操作新会话的同号标签页。先核查页面，再编辑剩余步骤建立新任务。');
    job.binding ||= connection; job.record.connectionInstanceId = connection.info.instanceId; return connection;
  }
  private persist(job: Active) {
    job.record.updatedAt = now();
    try { if(job.submission){this.state.saveNewTask(job.record,job.submission);job.submission=undefined;}else this.state.saveTask(job.record); this.unpersisted.delete(job.record.id); }
    catch { this.tripStorage(job); this.assertHealthy(); }
  }
  private currentPrincipal(job: Active) {
    const principal = job.principal.admin ? adminPrincipal : this.state.principal(job.principal.id);
    if (!principal || principal.readOnly || !allowsProfile(principal, job.record.profileId)) throw new BrowserError('CLIENT_AUTHORIZATION_FAILED', '任务创建者的授权已失效，后续步骤未执行。');
    return principal;
  }
  private fingerprint(tabId: number, plan: Plan, source?: { workflowId: string; workflowRevision: string }) { return createHmac('sha256',this.fingerprintSecret).update(JSON.stringify({tabId,plan,source})).digest('hex'); }
  // 同一个提交身份已有收据：内容一致返回原任务（deduplicated），内容不同拒绝，原任务详情已过期则明确说明。没有收据返回 undefined。
  private duplicate(profileId: string, principal: Principal, submissionId: string, fingerprint: string) {
    const existing=this.state.taskSubmission(profileId,principal.submissionScope ?? principal.id,submissionId);
    if(!existing)return undefined;
    if(existing.fingerprint!==fingerprint)throw new BrowserError('TASK_SUBMISSION_CONFLICT','同一 submissionId 已用于不同内容或标签页，未重复执行。',{phase:'precondition',outcome:'not_dispatched'});
    const record=this.state.task(existing.task_id) as TaskRecord|undefined;
    if(!record)throw new BrowserError('TASK_SUBMISSION_EXPIRED',`任务 ${existing.task_id} 已受理，详细历史已过期；保留去重记录，未重复执行。`,{phase:'precondition',outcome:'not_dispatched'});
    return {...this.get(profileId,existing.task_id),deduplicated:true};
  }
  submit(profileId: string, tabId: number, input: unknown, principal: Principal, source?: { workflowId: string; workflowRevision: string },submissionId?:string) {
    this.assertHealthy();
    const plan = taskPlan.parse(input);
    const program = compileProgram(plan.steps);
    let submission:Active['submission'];
    if(submissionId){
      const fingerprint=this.fingerprint(tabId,plan,source);
      const receiptOwner = principal.submissionScope ?? principal.id;
      const duplicate=this.duplicate(profileId,principal,submissionId,fingerprint);
      if(duplicate)return duplicate;
      if (principal.remoteAgentId && this.state.hasLegacyRemoteSubmission(profileId, principal.remoteAgentId, submissionId)) {
        throw new BrowserError('TASK_SUBMISSION_LEGACY', '此提交身份已存在于旧版远程收据中，无法可靠关联原配对域；未重新执行。请在本机核查原任务，不要自动生成新身份重试。', { phase: 'precondition', outcome: 'not_dispatched' });
      }
      this.state.assertSubmissionCapacity();submission={principalId:receiptOwner,id:submissionId,fingerprint};
    }
    const planBytes = Buffer.byteLength(JSON.stringify(plan));
    if (planBytes > TASK_PLAN_BYTES) throw new BrowserError('TASK_PLAN_TOO_LARGE', '单个任务计划超过 2 MiB，请拆分任务。');
    if (this.stats().queuedPlanBytes + planBytes > TOTAL_PLAN_BYTES) throw new BrowserError('TASK_MEMORY_CAPACITY', '任务计划内存预算已满，请等待现有任务结束或取消不再需要的任务。');
    if (this.closing) throw new BrowserError('SERVICE_CLOSING', '服务正在停止，未接受新任务。');
    if (this.jobs.size >= 100 || [...this.jobs.values()].filter(job => job.record.profileId === profileId).length >= 20) throw new BrowserError('TASK_CAPACITY', '任务队列已满：每个配置最多 20 项，总计最多 100 项。');
    const record: TaskRecord = { id: randomUUID(), profileId, tabId, initialTabId: tabId, principalId: principal.id, ...(principal.submissionScope && principal.submissionScope !== principal.id ? { quotaScope: principal.submissionScope } : {}), name: plan.name, status: 'queued', nextStep: 0,
      steps: plan.steps.map(step => ({ operation: step.operation, ...('action' in step.args ? { action: step.args.action } : {}), state: 'pending',...('postcondition' in step&&step.postcondition?{verification:'pending' as const}:{}) })), createdAt: now(), updatedAt: now(), visible: plan.visible, ...source,...(submissionId?{submissionId}:{}) };
    const binding = this.connection(profileId); record.connectionInstanceId = binding?.info.instanceId;
    const job:Active = { record, plan, planBytes, principal, binding,submission,program,variables:new TaskVariables(),iterations:new Map(),executed:0 };
    try { this.persist(job); } catch (error) { record.status = 'failed'; record.reason = 'TASK_JOURNAL_FAILED'; this.unpersisted.set(record.id, structuredClone(record)); throw error; }
    this.jobs.set(record.id, job);
    setImmediate(() => this.pump()); return structuredClone(record);
  }
  get(profileId: string, id: string): TaskRecord {
    const record = this.jobs.get(id)?.record || this.unpersisted.get(id) || this.state.task(id) as TaskRecord | undefined;
    if (!record || record.profileId !== profileId) throw new BrowserError('TASK_NOT_FOUND', '此账号没有该任务。');
    return structuredClone(record);
  }
  // 列表只读 SQLite 触发器维护的摘要（不含 steps），管理页每 2 秒轮询也不会再解析最多 600 条完整任务 JSON；运行中和未落盘的记录用内存里的最新版本覆盖。
  list(profileId: string, offset: number, limit: number, status?: string, query = '') {
    const summarize = ({ steps, ...task }: TaskRecord) => ({ ...task, totalSteps: steps.length });
    const records = new Map((this.state.taskSummaries(profileId) as ReturnType<typeof summarize>[]).map(task => [task.id, task]));
    for (const task of this.unpersisted.values()) records.set(task.id, summarize(task));
    for (const job of this.jobs.values()) records.set(job.record.id, summarize(job.record));
    const needle = query.toLocaleLowerCase();
    return pageItems([...records.values()].filter(task => task.profileId === profileId && (!status || task.status === status) && `${task.name} ${task.id}`.toLocaleLowerCase().includes(needle)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)), offset, limit);
  }
  control(profileId: string, id: string, action: string, principal: Principal) {
    const record = this.get(profileId, id);
    if (!principal.admin && record.principalId !== principal.id) throw new BrowserError('TASK_NOT_OWNED', '只能控制自己创建的任务。');
    const job = this.jobs.get(id);
    if (!job || terminal.has(record.status)) throw new BrowserError('TASK_FINISHED', '任务已结束或因重启中断，不能自动重跑。先核查已完成步骤，再明确创建新的剩余任务。');
    if (action === 'resume') {
      this.assertHealthy();
      if (job.record.status !== 'paused') throw new BrowserError('TASK_NOT_PAUSED', '只有已暂停任务可以继续。');
      this.currentPrincipal(job);
      try { this.bind(job); }
      catch (error) {
        if (error instanceof BrowserError && error.code === 'CONNECTION_CHANGED') { job.record.status = 'interrupted'; job.record.reason = error.code; this.persist(job); this.jobs.delete(id); this.pauseProfile(profileId, error.code); }
        throw error;
      }
      job.control = undefined; job.record.status = 'queued'; delete job.record.reason;
    } else {
      job.control = action === 'cancel' ? 'cancel' : 'pause';
      const executing = ['running', 'pausing', 'cancelling'].includes(job.record.status);
      job.record.status = executing ? (action === 'cancel' ? 'cancelling' : 'pausing') : (action === 'cancel' ? 'cancelled' : 'paused');
      if (!executing && action === 'cancel') this.jobs.delete(id);
    }
    this.persist(job); return structuredClone(job.record);
  }
  pauseProfile(profileId: string, reason: string) {
    for (const job of this.jobs.values()) if (job.record.profileId === profileId && job.record.status === 'queued') { job.record.status = 'paused'; job.record.reason = reason; this.persist(job); }
  }
  private pump() {
    if (this.closing || this.storageFault) return;
    for (const job of this.jobs.values()) {
      if (this.workers.size >= 4 || this.storageFault) break;
      if (job.record.status !== 'queued' || this.workers.has(job.record.profileId)) continue;
      if (!this.connection(job.record.profileId)) { try { this.pauseProfile(job.record.profileId, 'PROFILE_OFFLINE'); } catch { return; } continue; }
      const promise = this.run(job).catch(() => { /* 数据存储故障时不继续调度该任务，页面操作不重试。 */ }).finally(() => {
        this.workers.delete(job.record.profileId);
        if (terminal.has(job.record.status)) this.jobs.delete(job.record.id);
      });
      this.workers.set(job.record.profileId, promise);
    }
  }
  private async run(job: Active) {
    const record = job.record, owner = taskOwner(record);
    const leases = new Set<number>();
    const call = async (name: string, args: JsonObject) => { this.assertHealthy(); return this.invoke(name, { profileId: record.profileId, ...args }, owner, this.currentPrincipal(job), this.bind(job)); };
    const required = async (name: string, args: JsonObject) => { const result = await call(name, args); if (!result.ok) throw new BrowserError(result.error?.code || 'TASK_STEP_FAILED', '操作未完成，先核查页面。',{phase:result.error?.phase,outcome:result.error?.outcome}); return result; };
    try {
      record.status = 'running'; this.persist(job);
      if (!job.baseline && job.plan.steps.some(step => step.operation === 'tabs.wait')) {
        this.assertHealthy(); this.currentPrincipal(job);
        job.baseline = await this.tabDirectory(record.profileId, this.bind(job));
        if (job.baseline.length > 5000 || job.baseline.some(id => !Number.isInteger(id) || id < 0)) throw new BrowserError('TASK_TAB_DIRECTORY_TOO_LARGE', '标签页基线无效或超过 5000 项，未执行任务；请减少标签页后重新提交。');
      }
      while (record.nextStep < job.plan.steps.length) {
        this.assertHealthy();
        if (this.closing || job.control) { record.status = job.control === 'cancel' ? 'cancelled' : 'paused'; this.persist(job); return; }
        this.currentPrincipal(job); this.bind(job);
        if (job.executed >= job.plan.maxExecutedSteps) throw new BrowserError('TASK_EXECUTION_LIMIT','任务达到总步骤执行上限，后续动作未派发；先核查已完成步骤。',{phase:'precondition',outcome:'not_dispatched'});
        const index = record.nextStep, original = job.plan.steps[index]!, evidence = record.steps[index]!;
        // 先绑定并重新验证，失败发生在写入步骤意图和页面输入之前。
        const prepare=(item:Plan['steps'][number])=>{
          const parsed=taskStep.safeParse({...item,args:job.variables.bind(item as ProgramStep)});
          if(!parsed.success)throw new BrowserError('INVALID_ARGUMENT','结果绑定后的步骤参数不符合工具要求，未向浏览器派发；请检查绑定字段和变量类型。',{phase:'precondition',outcome:'not_dispatched'});
          return parsed.data;
        };
        const step = prepare(original);
        if (step.operation.startsWith('flow.')) {
          job.executed++;
          evidence.state='running';evidence.startedAt=now();evidence.executions=(evidence.executions??0)+1;this.persist(job);
          const args=step.args as JsonObject;
          let next=index+1;
          if(step.operation==='flow.set')this.saveVariable(job,String(args.name),args.value);
          else if(step.operation==='flow.if') {
            const block=job.program.blocks.get(index)!;
            if(!job.variables.condition(valueCondition.parse(args)))next=(block.otherwise??block.end)+1;
          } else if(step.operation==='flow.else')next=job.program.alternatives.get(index)!.end+1;
          else if(step.operation==='flow.repeat') {
            const block=job.program.blocks.get(index)!;
            if((job.iterations.get(index)??0)>=Number(args.count)||args.while&&!job.variables.condition(valueCondition.parse(args.while))) {job.iterations.delete(index);next=block.end+1;}
          } else if(step.operation==='flow.end') {
            const block=job.program.ends.get(index)!;
            if(block.kind==='flow.repeat'){job.iterations.set(block.start,(job.iterations.get(block.start)??0)+1);next=block.start;}
          }
          if(next>index+1)for(let i=index+1;i<next;i++)if(['pending','skipped'].includes(record.steps[i]!.state))record.steps[i]!.state='skipped';
          evidence.state='succeeded';evidence.finishedAt=now();record.nextStep=next;this.persist(job);
          // 纯控制流也必须交还事件循环，否则嵌套循环会阻止暂停/撤销请求进入服务。
          await new Promise<void>(resolve=>setImmediate(resolve));continue;
        }
        const followingOriginal = job.plan.steps[index+1];
        const pairedDialog = followingOriginal?.operation === 'page.dialog' && ['page.action','page.evaluate'].includes(step.operation);
        // 配对弹窗与触发动作是一次派发；两步的变量与schema都先验证，不能先把步骤记成running才发现参数无效。
        const following = pairedDialog?prepare(followingOriginal!):undefined;
        if(pairedDialog&&job.executed+2>job.plan.maxExecutedSteps)throw new BrowserError('TASK_EXECUTION_LIMIT','配对弹窗需要两个步骤额度，尚未派发触发动作。',{phase:'precondition',outcome:'not_dispatched'});
        await required('chrome_claim_tab', { tabId: record.tabId, seconds: 600 }); leases.add(record.tabId);
        if (job.plan.visible) await required('chrome_focus_tab', { tabId: record.tabId });
        if (this.closing || job.control) { record.status = job.control === 'cancel' ? 'cancelled' : 'paused'; this.persist(job); return; }
        job.executed++;evidence.state = 'running'; evidence.startedAt = now();evidence.executions=(evidence.executions??0)+1;delete evidence.artifactId;delete evidence.artifactType; this.persist(job); // 持久化步骤意图后才发出。
        const args = step.operation === 'tabs.wait' ? { ...step.args, openerTabId: record.tabId, excludeTabIds: job.baseline, timeoutMs: job.plan.stepTimeoutMs }
          : { ...step.args, ...(!step.operation.startsWith('downloads.')?{tabId:record.tabId}:{}), ...(['page.action','page.navigate','page.evaluate','page.wait','page.upload','page.cdp','network.wait','downloads.wait'].includes(step.operation)?{timeoutMs:job.plan.stepTimeoutMs}:{}),...(step.operation==='page.action'?{observe:false}:{}) };
        const browserStep=(item:Plan['steps'][number])=>({operation:item.operation,args:item.args,...('postcondition' in item&&item.postcondition?{postcondition:item.postcondition}:{})});
        if (pairedDialog) {job.executed++;const paired=record.steps[index+1]!;paired.state='running';paired.startedAt=now();paired.executions=(paired.executions??0)+1;delete paired.artifactId;delete paired.artifactType;this.persist(job); }
        const result = pairedDialog||'postcondition' in step&&step.postcondition ? await call('chrome_batch', {tabId:record.tabId,steps:pairedDialog?[browserStep(step),browserStep(following!)]:[browserStep(step)],timeoutMs:job.plan.stepTimeoutMs,observe:false}) : await call(taskToolNames[step.operation as keyof typeof taskToolNames], args);
        evidence.operationId = result.operationId; evidence.finishedAt = now();
        // 只消费服务在本次落盘成功后提供的顶层元数据，网页正文里的同名字段不可信。
        if(result.artifact){
          // 引用校验失败只能省略引用，不能把已完成网页动作误判成unknown而诱导重放。
          try{const stored=this.state.artifact(result.artifact.artifactId);
            if(stored?.profileId===record.profileId&&stored.owner===owner&&stored.extension===result.artifact.type){
              const artifact={artifactId:result.artifact.artifactId,artifactType:result.artifact.type};Object.assign(evidence,artifact);if(pairedDialog)Object.assign(record.steps[index+1]!,artifact);
            }
          }catch{/* 后续任务日志写入仍按现有存储故障规则处理。 */}
        }
        if (!result.ok || result.warnings?.some(warning => warning.code === 'OPERATION_JOURNAL_FAILED')) {
          const failure=result.batch?.error||pairedDialog&&(result.data as any)?.error||(result.error||{code:'OPERATION_JOURNAL_FAILED',outcome:'unknown'});
          // 后置条件没满足在批次里是 dispatched（照常可写）；队列任务无人值守，仍按待核查停下这个配置。
          const uncertain=result.warnings?.some(w=>w.code==='OPERATION_JOURNAL_FAILED')||unknownResult(failure)||failure.code==='RESULT_UNKNOWN'||failure.outcome==='dispatched';
          evidence.state = uncertain?'unknown':'failed'; evidence.code = failure.code; evidence.phase=failure.phase;evidence.outcome=uncertain?'unknown':'not_dispatched';
          if(evidence.verification&&failure.phase==='postcondition')evidence.verification='unconfirmed';
          if (pairedDialog) { const following=record.steps[index+1]!;following.state=uncertain?'unknown':'pending';following.code=uncertain?evidence.code:undefined;following.operationId=uncertain?result.operationId:undefined; }
          record.status = uncertain?'needs_review':'failed'; record.reason = evidence.code; this.persist(job);
          this.pauseProfile(record.profileId, uncertain?'PREVIOUS_TASK_NEEDS_REVIEW':'PREVIOUS_TASK_FAILED');
          if (job.plan.captureOnFailure && this.connection(record.profileId) === job.binding) {
            const shot = await call('chrome_screenshot', { tabId: record.tabId }).catch(() => undefined);
            record.screenshotArtifactId = (shot?.data as any)?.artifactId;
            record.screenshotCode = shot?.error?.code || (record.screenshotArtifactId ? undefined : 'CAPTURE_UNAVAILABLE'); this.persist(job);
          }
          return;
        }
        evidence.state = 'succeeded';if(evidence.verification)evidence.verification='matched'; record.nextStep++;
        if (pairedDialog) { Object.assign(record.steps[index+1]!,{state:'succeeded',finishedAt:now(),operationId:result.operationId,...(record.steps[index+1]!.verification?{verification:'matched'}:{})});record.nextStep++; }
        // 先保留所有已完成动作的证据；变量超限等本地故障不能把成功的配对动作误改为unknown。
        const savedResult=(part:number)=>{
          if(!pairedDialog&&!('postcondition' in step&&step.postcondition))return result.data;
          const data=result.data as {results?:{result?:unknown}[];artifactId?:string}|undefined;
          if(data?.results&&part<data.results.length)return data.results[part]?.result;
          if(data?.artifactId)return {artifactId:data.artifactId,resultIndex:part};
          throw new BrowserError('TASK_RESULT_UNAVAILABLE','步骤已完成，但批次结果缺少对应子结果，后续步骤未派发；先核查已完成动作。',{phase:'precondition',outcome:'not_dispatched'});
        };
        if('saveAs' in step&&step.saveAs)this.saveVariable(job,step.saveAs,savedResult(0));
        if(pairedDialog&&following&&'saveAs' in following&&following.saveAs)this.saveVariable(job,following.saveAs,savedResult(1));
        if (step.operation === 'tabs.wait') {
          const opened = result.data as { tabId?: number };
          if (!Number.isInteger(opened?.tabId)) throw new BrowserError('INVALID_POPUP_RESULT', '新标签页结果无效，未切换目标。');
          record.tabId = opened.tabId!;
          await required('chrome_claim_tab', { tabId: record.tabId, seconds: 600 }); leases.add(record.tabId);
        }
        this.persist(job);
      }
      record.status = job.control === 'cancel' ? 'cancelled' : 'succeeded'; this.persist(job);
    } catch (error) {
      const info=errorInfo(error),code = info.code;
      const uncertain=info.outcome!=='not_dispatched'&&record.steps.some(step => step.state === 'running'&&!step.operation.startsWith('flow.'));
      record.status = code === 'CONNECTION_CHANGED' ? 'interrupted' : code === 'TASK_JOURNAL_FAILED' || uncertain ? 'needs_review' : 'failed'; record.reason = code;
      for (const step of record.steps) if (step.state === 'running') { step.state = uncertain?'unknown':'failed'; step.code = code;step.phase=info.phase;step.outcome=uncertain?'unknown':info.outcome; }
      try { this.persist(job); } catch { /* 存储保护已生效，详情保留在有界内存记录中。 */ }
      // 变量缺失、绑定后参数无效、执行预算等本地异常同样停下这个配置的后续排队任务：前面成功的步骤可能已经改了页面，不能让下一个任务接着往下派发。
      if (!this.storageFault) this.pauseProfile(record.profileId, record.status === 'needs_review' || ['PROFILE_OFFLINE', 'CONNECTION_CHANGED'].includes(code) ? code : 'PREVIOUS_TASK_FAILED');
    } finally {
      // 释放是本机协调清理，即使创建者被撤销，也只释放此 task owner 的租约。
      for (const tabId of leases) await this.invoke('chrome_release_tab', { profileId: record.profileId, tabId }, owner, adminPrincipal);
    }
  }
  private saveVariable(job:Active,name:string,value:unknown){
    const bytes=[...this.jobs.values()].reduce((total,item)=>total+item.variables.bytes,0);
    job.variables.set(name,value,16*1024*1024-bytes);
  }
  saveWorkflow(profileId: string, input: unknown, workflowId?: string, expectedRevision?: string) {
    const definition = workflowDefinition.parse(input), encoded = JSON.stringify(definition);
    compileProgram(definition.steps);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new BrowserError('WORKFLOW_TOO_LARGE', '流程定义超过 2 MiB。');
    const parameters = new Set(definition.parameters.map(item => item.name));
    if (parameters.size !== definition.parameters.length) throw new BrowserError('DUPLICATE_PARAMETER', '参数名不能重复。');
    const checkReferences=(input:unknown):void=>{if(!input||typeof input!=='object')return;for(const [key,value]of Object.entries(input)){if(['ref','contextId','sessionId','dialogId'].includes(key))throw new BrowserError('EPHEMERAL_LOCATOR','保存流程及其后置条件请使用 selector/语义定位；包括拖拽终点在内的 ref、弹窗 ID 和 iframe 会话只对当前页面有效。');checkReferences(value);}};
    for(const step of definition.steps){if(!step.operation.startsWith('flow.'))checkReferences(step.args);if('postcondition' in step&&step.postcondition)checkReferences(step.postcondition);}
    // 定义会长期保存，密码和令牌只能走 {{参数}}，参数不写入任务审计。这里只认得出目标写明了敏感字段的情况。
    for(const step of definition.steps)if(step.operation==='page.action'&&['fill','type'].includes(step.args.action)&&step.args.text&&!step.args.text.includes('{{')&&!step.bindings?.text&&SENSITIVE_FIELD.test(JSON.stringify([step.args.selector,step.args.locator])))throw new BrowserError('WORKFLOW_SECRET_LITERAL','这个字段看起来是密码或令牌，流程不能保存它的值。改用 {{参数名}}，运行时再填。');
    for (const step of definition.steps) if ('expression' in step.args && step.args.expression?.includes('{{')) throw new BrowserError('UNSAFE_INTERPOLATION', '禁止在 JavaScript 表达式里插值；请使用文字、URL 或语义定位参数。');
    for(const step of definition.steps)if(step.operation==='page.cdp'&&JSON.stringify(step.args).includes('{{'))throw new BrowserError('UNSAFE_INTERPOLATION','禁止在原始 CDP 方法或参数里插值，包括嵌套 JavaScript；请用专用文字、URL 或语义定位步骤。');
    for (const match of encoded.matchAll(/\{\{([\p{L}_][\p{L}\p{N}_]*)\}\}/gu)) if (!parameters.has(match[1]!)) throw new BrowserError('UNDECLARED_PARAMETER', `参数 ${match[1]} 未声明。`);
    const old = workflowId ? this.getWorkflow(profileId, workflowId) : undefined;
    if (old?.archivedAt) throw new BrowserError('WORKFLOW_ARCHIVED', '流程已归档，请先恢复或复制后编辑。');
    if (workflowId && !expectedRevision) throw new BrowserError('WORKFLOW_REVISION_REQUIRED', '编辑流程必须提供读取时的版本。');
    return this.state.saveWorkflow({ id: workflowId || randomUUID(), profileId, createdAt: old?.createdAt || now(), revision: randomUUID(), definition }, expectedRevision);
  }
  workflows(profileId: string, offset: number, limit: number, archived = false, summary = false) {
    return this.state.workflowPage(profileId, archived, offset, limit, summary);
  }
  getWorkflow(profileId: string, id: string, revision?: string) {
    const current = this.state.workflow(id, true);
    const flow = current && (revision ? this.state.workflowRevision(id, revision) : current);
    if (!flow || flow.profileId !== profileId) throw new BrowserError('WORKFLOW_NOT_FOUND', '此账号没有该流程。');
    return flow;
  }
  workflowHistory(profileId: string, id: string) { const current = this.getWorkflow(profileId, id); return { current, versions: this.state.workflowVersions(id) }; }
  copyWorkflow(profileId: string, id: string, toProfileId: string, name: string) { const flow = this.getWorkflow(profileId, id); return this.saveWorkflow(toProfileId, { ...flow.definition, name }); }
  archiveWorkflow(profileId: string, id: string, expectedRevision: string, archived: boolean) {
    return this.state.archiveWorkflow(id, profileId, expectedRevision, archived);
  }
  restoreWorkflow(profileId: string, id: string, revision: string, expectedRevision: string) { return this.saveWorkflow(profileId, this.getWorkflow(profileId, id, revision).definition, id, expectedRevision); }
  preview(profileId: string, id: string, parameters: Record<string, string>, revision?: string) {
    const flow = this.getWorkflow(profileId, id, revision);
    const names = new Set(flow.definition.parameters.map(item => item.name));
    if (Object.keys(parameters).some(key => !names.has(key)) || [...names].some(key => typeof parameters[key] !== 'string')) throw new BrowserError('WORKFLOW_PARAMETERS', '参数必须与流程声明一致。');
    const { description: _, parameters: __, ...plan } = flow.definition;
    return { workflowId: id, revision: flow.revision, version: flow.version, plan: taskPlan.parse(expandWorkflow(plan, parameters)) };
  }
  runWorkflow(profileId: string, tabId: number, id: string, revision: string, parameters: Record<string, string>, principal: Principal,submissionId?:string) {
    const source = { workflowId: id, workflowRevision: revision };
    if (submissionId) {
      // 幂等重试：响应丢失后流程可能已被编辑或归档，但重试请求指向的仍是同一个版本。先用请求里的版本复算指纹，
      // 找到内容一致的原收据就直接返回原任务，不再谈“流程现在是什么版本”；否则才做下面的归档和版本校验。
      let plan: Plan | undefined;
      try { plan = taskPlan.parse(this.preview(profileId, id, parameters, revision).plan); } catch { /* 该版本已读不到（历史被整理或流程被删除）或参数不符：无法验证内容，回到常规校验，由它给出准确的错误 */ }
      if (plan) { this.assertHealthy(); const duplicate = this.duplicate(profileId, principal, submissionId, this.fingerprint(tabId, plan, source)); if (duplicate) return duplicate; }
    }
    if (this.getWorkflow(profileId, id).archivedAt) throw new BrowserError('WORKFLOW_ARCHIVED', '流程已归档，不能运行；请先明确恢复或复制。');
    const preview = this.preview(profileId, id, parameters);
    if (preview.revision !== revision) throw new BrowserError('WORKFLOW_CHANGED', '流程版本不符，请重新预览。');
    return this.submit(profileId, tabId, preview.plan, principal, source,submissionId);
  }
  diagnostics(profileId: string, taskId: string) {
    const task = this.get(profileId, taskId);
    // 进程可能在响应返回、operationId 写入步骤之前中断；按任务 owner 找回已落盘的操作。
    const page = this.state.taskOperationPage(profileId, taskOwner(task));
    const operations = new Map(page.operations.map(operation => [operation.id, operation]));
    for (const step of task.steps) { const operation = step.operationId ? this.state.get(step.operationId) : undefined; if (operation?.profileId === profileId) operations.set(operation.id, operation); }
    return { version: VERSION, exportedAt: now(), task, advice: recoveryAdvice(task.reason), profile: this.connection(profileId)?.info ? { id: profileId, online: true, version: this.connection(profileId)!.info.version, instanceId: this.connection(profileId)!.info.instanceId } : { id: profileId, online: false },
      operations: [...operations.values()], ...(page.truncated ? { operationsTruncated: true } : {}), note: '不包含运行参数、脚本、页面正文、凭据或图片内容；截图需单独查看。' };
  }
  recoveryDraft(profileId: string, taskId: string, fromStep: number) {
    const task = this.get(profileId, taskId);
    if (!['failed', 'needs_review', 'interrupted', 'cancelled'].includes(task.status)) throw new BrowserError('TASK_NOT_RECOVERABLE', '先等待任务结束或取消；进行中、暂停中和已完成的任务不能从此入口重建。');
    if (fromStep >= task.steps.length) throw new BrowserError('NO_REMAINING_STEPS', '所选步骤超出原任务范围。');
    let source: Workflow | undefined;
    if (task.workflowId && task.workflowRevision) { try { source = this.getWorkflow(profileId, task.workflowId, task.workflowRevision); } catch { /* 原流程可能已明确删除，仍允许手工编辑空白草稿。 */ } }
    return { taskId, fromStep, advice: recoveryAdvice(task.reason), steps: task.steps.slice(fromStep), source: source ? { workflowId: source.id, revision: source.revision, parameters: source.definition.parameters } : null,
      operationsToCheck: this.diagnostics(profileId, taskId).operations.filter(operation => ['running','unknown'].includes(operation.state) && !operation.acknowledgedAt),
      note: '只生成编辑依据，不解除保护、不执行动作。原流程参数必须重新输入；普通任务需重新填写目标和内容。' };
  }
  stopScheduling() { this.closing = true; clearInterval(this.timer); }
  async drain() { await Promise.allSettled([...this.workers.values()]); }
}
