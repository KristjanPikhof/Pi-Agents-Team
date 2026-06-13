import { createDefaultTeamState } from './src/config';
import { createTeamDashboardOverlayComponent } from './src/ui/overlay';

function makeWorker(overrides: any): any { return { workerId: overrides.workerId, profileName: overrides.profileName ?? 'reviewer', sessionMode: 'worker', status: overrides.status, requestedThinkingLevel: 'medium', effectiveThinkingLevel: 'medium', startedAt: Date.now(), lastEventAt: Date.now(), pendingRelayQuestions: [], usage: { turns:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0 }, ...overrides }; }

const state = createDefaultTeamState();
state.activeWorkers.w1 = makeWorker({ workerId:'w1', status:'running', profileName:'reviewer', currentTask:{ taskId:'t1', title:'Task', goal:'Goal', requestedBy:'orchestrator', profileName:'reviewer', cwd:process.cwd(), contextHints:[], createdAt:Date.now() }};
const manager: any = { snapshot:()=>state, pingWorkers:async()=>{}, getWorkerTranscript:()=>undefined, getWorkerConsole:()=>[], getAssistantTail:()=>[], onAssistantChunk:()=>()=>{}, messageWorker:async()=>({}), closeWorker:async()=>({}), cancelWorker:async()=>({}), pruneTerminalWorkers:async()=>[], delegateTask:async()=>({}), routingMode:'team', displayCost:true, config:{profiles:[{name:'reviewer'}]} };
const tui = { terminal:{ rows:28, columns:100 }, requestRender:()=>{} };
const component = createTeamDashboardOverlayComponent(tui, manager, state, ()=>{});
component.handleInput('s');
for (const ch of 'abc') component.handleInput(ch);
const rawLines = component.render(100);
const modalLine = rawLines.find((l:string) => l.includes('Steer w1:'));
const m = modalLine!;
// Is there a BEL char anywhere?
for (let i=0;i<m.length;i++) { if (m.charCodeAt(i)===7) console.log('BEL at', i); }
