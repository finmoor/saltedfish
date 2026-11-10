export interface AgentTab { profileId:string; tabId:number; operation?:string; claimed:boolean; leaseExpiresAt?:string }
export interface AgentSource { id:string;hostname?:string;reportedAddresses:string[];reportId?:string;reportedAt?:string;reportSource?:'setup_report'|'runtime_report';peerAddress?:string;observedAt:string;connected:boolean }
export interface AgentSession { id:string; client?:string; version?:string; since:string; local:boolean }
export interface AgentGroup { profileId:string; groupId:number; windowId:number; title:string; color?:string; startedAt:string; agentId:string; sessionId:string; online:boolean; working:boolean; session?:AgentSession; lastUsedAt?:string; tabs:{tabId:number;title:string;active:boolean;popup?:boolean;operation?:string}[] }
export interface AgentSummary { id:string; label:string; location:'local'|'remote'; connectionState:'connected'|'recent'|'disconnected'|'unavailable'; connectionEvidence:'heartbeat'|'mcp_session'|'recent_request'|'configuration'; sessionCount:number; lastSeenAt?:string; activeOperations:number; readOnly:boolean; tabs:AgentTab[];sources?:AgentSource[]; sessions?:AgentSession[]; lastUsedAt?:string; working?:boolean }
export function agentConnection(agent:AgentSummary): {label:string;tone:string;detail:string};
export function agentLastUsed(agent:AgentSummary):string;
export function replaceGroupCards(container:HTMLElement,cards:HTMLElement[]):void;
export function groupState(group:AgentGroup): {label:string;tone:string;detail:string};
export function groupCard(group:AgentGroup,options?:{profileName?:string;onShow?:(group:AgentGroup,button:HTMLButtonElement)=>unknown;onRelease?:(group:AgentGroup,button:HTMLButtonElement)=>unknown}):HTMLElement;
export function sortAgents(agents:AgentSummary[],unified?:boolean):AgentSummary[];
export function agentCard(agent:AgentSummary,options?:{currentProfileId?:string;profileNames?:Map<string,string>;tabTitles?:Map<string,string>;compact?:boolean;preferredAddress?:string;unified?:boolean}):HTMLElement;
