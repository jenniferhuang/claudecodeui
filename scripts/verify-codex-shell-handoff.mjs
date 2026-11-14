import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Codex } from '@openai/codex-sdk';

// Opt-in integration check: real Codex + PTY + SDK, with a local Responses
// fixture and a throwaway CODEX_HOME. No credentials or external model service.
if (process.platform === 'win32') throw new Error('This PTY signal check requires macOS or Linux.');
const cli = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-offline-history-'));
const codexHome = path.join(root, '.codex');
await mkdir(codexHome);
const localRequests = [];
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  localRequests.push({method: req.method, url: req.url});
  if (req.method !== 'POST') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({data:[]})); return; }
  const id = `resp_${localRequests.length}`;
  const message = {id:`msg_${localRequests.length}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Offline fixture preserved.',annotations:[]}]};
  const response = {id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'offline-test',output:[message],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
  res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'close'});
  const events = [
    {type:'response.created', response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added', output_index:0, item:{...message,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'Offline fixture preserved.'},
    {type:'response.output_item.done',output_index:0,item:message},
    {type:'response.completed',response},
  ];
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
model.listen(0,'127.0.0.1'); await once(model,'listening');
await writeFile(path.join(codexHome,'config.toml'),`model = "offline-test"\nmodel_provider = "offline"\ncheck_for_update_on_startup = false\n[model_providers.offline]\nname = "Offline diagnostics"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects."${root}"]\ntrust_level = "trusted"\n`);
const env = {...process.env,HOME:root,CODEX_HOME:codexHome,NO_PROXY:'127.0.0.1,localhost',TERM:'xterm-256color',PATH:process.env.PATH};
const children = new Set();
const timeout = (promise, ms, name) => Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`${name} timeout`)),ms);timer.unref();})]);
async function appServer(run) {
 const child = spawn(process.execPath,[cli,'--no-daemon','app-server'],{env,stdio:['pipe','pipe','pipe']}); children.add(child);
 let id=0, stderr=''; const pending=new Map(); const notifications=[]; const listeners=new Set();
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1500);});
 const reader=readline.createInterface({input:child.stdout});
 reader.on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return;}
   if(msg.method){notifications.push(msg);for(const listener of listeners)listener(msg);}
   else if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}
 });
 const call = async (method,params) => { const requestId=++id;const reply=new Promise(resolve=>pending.set(requestId,resolve));child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');return timeout(reply,8000,method); };
 const event = (method) => timeout(new Promise(resolve=>{const found=notifications.find(m=>m.method===method);if(found)return resolve(found);const listener=msg=>{if(msg.method===method){listeners.delete(listener);resolve(msg);}};listeners.add(listener);}),12000,method);
 try {await call('initialize',{clientInfo:{name:'cloudcli-local-fixture',version:'1'},capabilities:{}});child.stdin.write('{"method":"initialized","params":{}}\n');return await run({call,event});}
 catch(error){throw new Error(`${error.message} ${stderr}`);}
 finally {reader.close();const exited=once(child,'exit');child.kill();await timeout(exited,5000,'app-server exit');children.delete(child);}
}
let terminal;
const report = {codex_version:spawnSync(process.execPath,[cli,'--version'],{encoding:'utf8'}).stdout.trim(),external_model_calls:0};
try {
 const threadId = await appServer(async ({call,event})=>{
  const started=await call('thread/start',{cwd:root,model:'offline-test',approvalPolicy:'never',sandbox:'read-only',persistExtendedHistory:true});
  assert.ok(started.result,JSON.stringify(started)); const id=started.result.thread.id;
  const turn=await call('turn/start',{threadId:id,input:[{type:'text',text:'CloudCLI offline history marker'}]});assert.ok(turn.result,JSON.stringify(turn));
  const completed=await event('turn/completed');assert.equal(completed.params.turn.status,'completed',JSON.stringify(completed));
  return id;
 });
 const history=()=>appServer(async ({call})=>{const r=await call('thread/resume',{threadId,cwd:root,model:'offline-test',approvalPolicy:'never',sandbox:'read-only'});if(r.error)return r; const read=await call('thread/read',{threadId,includeTurns:true});return {id:r.result.thread.id,marker:JSON.stringify(read).includes('CloudCLI offline history marker'),sdkMarker:JSON.stringify(read).includes('CloudCLI SDK handoff marker')};});
 const siblingId = await appServer(async ({call,event})=>{
  const started=await call('thread/start',{cwd:root,model:'offline-test',approvalPolicy:'never',sandbox:'read-only',persistExtendedHistory:true});
  assert.ok(started.result,JSON.stringify(started));const id=started.result.thread.id;
  const turn=await call('turn/start',{threadId:id,input:[{type:'text',text:'CloudCLI independent sibling marker'}]});assert.ok(turn.result,JSON.stringify(turn));
  const completed=await event('turn/completed');assert.equal(completed.params.turn.status,'completed');return id;
 });
 async function checkCloudCliHistory(phase) {
  const child=spawn(process.execPath,['--import','tsx','scripts/verify-codex-cloudcli-history.mts',threadId,siblingId,phase],{cwd:process.cwd(),env:{...env,DATABASE_PATH:path.join(root,'cloudcli-fixture.db'),CLOUDCLI_OFFLINE_FIXTURE_ROOT:root,TSX_TSCONFIG_PATH:path.resolve('server/tsconfig.json')},stdio:['ignore','pipe','pipe']});
  children.add(child);let output='';let stderr='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const [code]=await timeout(once(child,'close'),20000,'CloudCLI discovery/history');children.delete(child);
  assert.equal(code,0,output+'\n'+stderr);
  const line=output.split('\n').find(line=>line.startsWith('CLOUDCLI_HISTORY_CHECK '));assert.ok(line,output);return JSON.parse(line.slice('CLOUDCLI_HISTORY_CHECK '.length));
 }
 report.cloudcli_before_shell=await checkCloudCliHistory('before-shell');
 const baseline=await history(); assert.equal(baseline.marker,true,JSON.stringify(baseline));report.initial_history_preserved=true;
 terminal=pty.spawn('bash',['-c',`exec ${quote(process.execPath)} ${quote(cli)} --no-daemon resume "${threadId}" --sandbox read-only --ask-for-approval never`],{env,cwd:root,cols:110,rows:34,name:'xterm-256color'});
 const terminalExit=new Promise(resolve=>terminal.onExit(resolve));
 terminal.onData(data=>{if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R');if(data.includes('\x1b]11;?'))terminal.write('\x1b]11;rgb:0000/0000/0000\x1b\\');});
 let locked=false;
 for(let attempt=0;attempt<10;attempt++){await new Promise(resolve=>setTimeout(resolve,200)); const probe=await history();if(JSON.stringify(probe).includes('already has an active writer')){locked=true;break;}}
 assert.equal(locked,true); report.shell_writer_verified=true;
 const stoppedAt=Date.now();terminal.kill();await timeout(terminalExit,8000,'Codex PTY exit');terminal=null;report.pty_exit_ms=Date.now()-stoppedAt;
 const resumed=await history();assert.equal(resumed.id,threadId);assert.equal(resumed.marker,true);report.same_thread_and_history_after_shell_exit=true;
 const codex=new Codex({env});
 const thread=codex.resumeThread(threadId,{workingDirectory:root,skipGitRepoCheck:true,sandboxMode:'read-only',approvalPolicy:'never',model:'offline-test'});
 const result=await timeout(thread.run('CloudCLI SDK handoff marker',{signal:AbortSignal.timeout(12000)}),15000,'SDK run');
 assert.match(result.finalResponse,/Offline fixture preserved/); const final=await history();assert.equal(final.marker,true);assert.equal(final.sdkMarker,true);
 report.sdk_resumed_same_history=true; report.cloudcli_after_sdk=await checkCloudCliHistory('after-sdk'); report.local_fixture_requests=localRequests; console.log(JSON.stringify(report));
} finally {
 if(terminal)terminal.kill();for(const child of children)child.kill('SIGKILL');model.close();await rm(root,{recursive:true,force:true});
}
