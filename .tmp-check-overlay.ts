import { createDefaultTeamState } from './src/config';
import { createTeamDashboardOverlayComponent } from './src/ui/overlay';
import { visibleWidth } from '@mariozechner/pi-tui';
const tm:any={snapshot:()=>createDefaultTeamState(), pingWorkers:async()=>{}, getWorkerTranscript:()=>'', getWorkerConsole:()=>[], getAssistantTail:()=>[], routingMode:'team', config:{profiles:[{name:'reviewer'}]}};
for (const w of [1,2,5,10,20,25,30,44]) {
 const c=createTeamDashboardOverlayComponent({terminal:{columns:w, rows:24}},tm,createDefaultTeamState(),()=>{});
 const lines=c.render(w);
 console.log('w',w,'max',Math.max(...lines.map(visibleWidth)), 'count', lines.length, 'topWidth', visibleWidth(lines[0]!));
}
