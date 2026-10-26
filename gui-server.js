const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PHONE_AUTOMATION_GUI_PORT || 17321);
const DEFAULT_PROJECT = '其他_调研_服务类调研_服务类调研_1';
const REPORT_MODE = 'airforce-report';
const TASK_QUERY_MODE = 'task-query';
const clients = new Set();
let running = false;
let activeChild = null;

function sendEvent(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const response of clients) response.write(payload);
}

function startAutomation(mode, project, amount, startPage) {
  if (running) return false;
  running = true;
  sendEvent({ type: 'status', running: true });
  const childEnv = {
    ...process.env,
    PHONE_AUTOMATION_MODE: mode,
    PHONE_AUTOMATION_PROJECT: mode === REPORT_MODE || mode === TASK_QUERY_MODE ? '' : project,
    PHONE_AUTOMATION_PROJECT_ID: mode === REPORT_MODE ? project : '',
    PHONE_AUTOMATION_AMOUNT: String(amount || 0),
    PHONE_AUTOMATION_START_PAGE: String(startPage || 1),
  };
  const child = spawn(process.execPath, ['run.js'], { cwd: __dirname, env: childEnv });
  activeChild = child;
  child.stdout.on('data', (chunk) => sendEvent({ type: 'log', text: chunk.toString() }));
  child.stderr.on('data', (chunk) => sendEvent({ type: 'log', text: chunk.toString() }));
  child.on('close', (code) => {
    running = false;
    activeChild = null;
    sendEvent({ type: 'done', code, running: false });
  });
  return true;
}

function stopAutomation() {
  if (!running || !activeChild) return false;
  const child = activeChild;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
  sendEvent({ type: 'log', text: '\\n已直接结束自动化进程。\\n' });
  return true;
}


const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>外呼取数自动化</title>
<style>
  body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#202124;margin:0;padding:32px}
  main{max-width:680px;margin:auto;background:#fff;padding:28px;border:1px solid #ddd;border-radius:8px;box-shadow:0 3px 14px #00000012}
  h1{font-size:22px;margin:0 0 24px}label{display:block;margin:15px 0 6px;font-weight:600}
  input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #bbb;border-radius:4px;font-size:15px}
  button{margin-top:22px;padding:10px 20px;border:0;border-radius:4px;background:#1677ff;color:#fff;font-size:15px;cursor:pointer}
  button:disabled{background:#9bbcf2;cursor:wait}.hint{color:#666;font-size:13px;margin-top:5px}
  pre{min-height:180px;max-height:360px;overflow:auto;background:#111;color:#d7f9d7;padding:14px;border-radius:4px;white-space:pre-wrap;margin-top:24px}
</style>
<main><h1>智胜系统自动工具</h1>
<label for="mode">功能</label><select id="mode" style="box-sizing:border-box;width:100%;padding:10px;border:1px solid #bbb;border-radius:4px;font-size:15px"><option value="phone">外呼取数</option><option value="report">空军报表</option><option value="task-query">工单查询</option></select>
<label for="project" id="projectLabel">项目名称</label><input id="project" value="${DEFAULT_PROJECT}">
<div class="hint" id="projectHint">直接使用默认项目可保持不变。</div>
<label for="amount" id="amountLabel">本次处理数量（0-50）</label><input id="amount" type="number" min="0" max="50" step="1" value="1">
<label for="startPage" id="startPageLabel" style="display:none">起始页码（从第几页开始）</label><input id="startPage" type="number" min="1" max="10000" step="1" value="1" style="display:none"><div class="hint" id="startPageHint" style="display:none">先跳转到指定页，再从该页第一条开始查询。</div>
<span id="status" style="margin-left:12px;color:#666">未开始</span><br><button id="start">开始任务</button><button id="stop" disabled style="margin-left:10px;background:#d9363e">结束任务</button><pre id="log">等待开始...</pre></main>
<script>
const status=document.querySelector('#status'), mode=document.querySelector('#mode'), projectLabel=document.querySelector('#projectLabel'), projectHint=document.querySelector('#projectHint'), amountLabel=document.querySelector('#amountLabel'), project=document.querySelector('#project'), amountInput=document.querySelector('#amount'), startPageLabel=document.querySelector('#startPageLabel'), startPageHint=document.querySelector('#startPageHint'), startPageInput=document.querySelector('#startPage'), start=document.querySelector('#start'), stop=document.querySelector('#stop'), log=document.querySelector('#log');
mode.onchange=()=>{const report=mode.value==='report',query=mode.value==='task-query';projectLabel.textContent=report?'项目编号':'项目名称';project.placeholder=report?'请输入项目编号':'';project.value=report||query?'':'${DEFAULT_PROJECT}';projectLabel.style.display=query?'none':'block';project.style.display=query?'none':'block';projectHint.style.display=query?'none':'block';projectHint.textContent=report?'按项目编号搜索并导出详情':'直接使用默认项目可保持不变。';amountLabel.style.display=report?'none':'block';amountInput.style.display=report?'none':'block';amountLabel.textContent=query?'本次查询数量':'本次处理数量（0-50）';amountInput.min=query?'1':'0';amountInput.max=query?'10000':'50';amountInput.value=query?'50':'1';startPageLabel.style.display=query?'block':'none';startPageInput.style.display=query?'block':'none';startPageHint.style.display=query?'block':'none';};
const source=new EventSource('/events');
source.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='log'){log.textContent+=m.text;log.scrollTop=log.scrollHeight}if(m.type==='status'){start.disabled=m.running;stop.disabled=!m.running;status.textContent=m.running?'进行中':'未开始';start.textContent=m.running?'任务运行中...':'开始任务'}if(m.type==='done'){start.disabled=false;stop.disabled=true;status.textContent='未开始';start.textContent='开始任务';log.textContent+='\\n任务结束，退出码：'+m.code+'\\n'}};
start.onclick=async()=>{const projectValue=project.value.trim();const amount=Number(amountInput.value);const startPage=Number(startPageInput.value);const report=mode.value==='report',query=mode.value==='task-query';if(!query&&!projectValue){alert(report?'请输入项目编号':'请输入项目名称');return}if(!Number.isInteger(amount)||(query?(amount<1||amount>10000):(amount<0||amount>50))){alert(query?'查询数量必须是1-10000的整数':'数量必须是0-50的整数');return}if(query&&(!Number.isInteger(startPage)||startPage<1||startPage>10000)){alert('起始页码必须是1-10000的整数');return}log.textContent='正在启动...\\n';const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:mode.value,project:projectValue,amount,startPage})});const data=await r.json();if(!data.ok)log.textContent+='启动失败：'+data.error+'\\n'};
stop.onclick=async()=>{stop.disabled=true;await fetch('/api/stop',{method:'POST'});};
</script></html>`;

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (requestUrl.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  if (requestUrl.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ type: 'status', running })}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (requestUrl.pathname === '/api/start' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { mode = 'phone', project = '', amount, startPage = 1 } = JSON.parse(body);
        if (!['phone', 'report', 'task-query'].includes(mode)) throw new Error('未知的功能类型');
        if (mode !== 'task-query' && (typeof project !== 'string' || !project.trim())) throw new Error(mode === 'report' ? '项目编号不能为空' : '项目名称不能为空');
        if (mode === 'task-query' && (!Number.isInteger(amount) || amount < 1 || amount > 10000)) throw new Error('查询数量必须是1-10000的整数');
        if (mode === 'task-query' && (!Number.isInteger(startPage) || startPage < 1 || startPage > 10000)) throw new Error('起始页码必须是1-10000的整数');
        if (mode !== 'report' && mode !== 'task-query' && (!Number.isInteger(amount) || amount < 0 || amount > 50)) throw new Error('数量必须是0-50的整数');
        const automationMode = mode === 'report' ? REPORT_MODE : mode === 'task-query' ? TASK_QUERY_MODE : 'phone';
        if (!startAutomation(automationMode, project.trim(), amount, startPage)) throw new Error('已有任务正在运行');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }
  if (requestUrl.pathname === '/api/stop' && request.method === 'POST') {
    const stopped = stopAutomation();
    response.writeHead(stopped ? 200 : 400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: stopped, error: stopped ? undefined : '当前没有运行中的任务' }));
    return;
  }
  response.writeHead(404); response.end('Not Found');
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  console.log(`图形界面已启动：${address}`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [address], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
});
