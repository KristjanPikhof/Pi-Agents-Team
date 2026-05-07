import { createDefaultTeamState } from './src/config';
import { createTeamDashboardOverlayComponent } from './src/ui/overlay';
const tm:any={snapshot:()=>createDefaultTeamState(), pingWorkers:async()=>{}, getWorkerTranscript:()=>'', getWorkerConsole:()=>[], getAssistantTail:()=>[], routingMode:'team', config:{profiles:[{name:'reviewer'}]}, delegateTask: async()=>{}};
const c=createTeamDashboardOverlayComponent({terminal:{columns:80, rows:30}},tm,createDefaultTeamState(),()=>{}, {cwd:process.cwd()});
c.handleInput('n'); c.handleInput('hello\nworld');
console.log(c.render(80).filter(l=>l.includes('hello') || l.includes('world')).map(JSON.stringify).join('\n'));
