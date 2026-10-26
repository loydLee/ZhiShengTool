const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

const PORTAL_URL = 'https://geek.cdydwx.cn:5000/pc-index/';
const LOGIN_PAGE = `${PORTAL_URL}#/login`;
const BASE_URL = 'https://geek.cdydwx.cn:5000/pc-workflow/';
const PHONE_PAGE = `${BASE_URL}#/kyxm/usePhone2`;
const TASK_PAGE = `${BASE_URL}#/handleTask`;
const QUERY_TASK_PAGE = `${BASE_URL}#/searchTask/myHandled`;
const REPORT_PAGE = `${BASE_URL}#/kyxm/report/secondReport`;
const REPORT_MODE = 'airforce-report';
const TASK_QUERY_MODE = 'task-query';
const DEFAULT_PROJECT_NAME = '其他_调研_服务类调研_服务类调研_1';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const ACTION_DELAY = 350;
const REPORT_RETRY_DELAY = 600;

function waitForEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

function ask(message, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(message, (answer) => {
    rl.close();
    resolve(answer.trim() || defaultValue);
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function setPageSize50(page) {
  const selectors = [
    page.getByText(/^(5|10|15|20)条\/页$/, { exact: true }).last(),
    page.getByRole('combobox').last(),
  ];
  let trigger = null;
  for (const candidate of selectors) {
    if (await candidate.count().catch(() => 0)) { trigger = candidate; break; }
  }
  if (!trigger) return;
  const current = await trigger.innerText().catch(() => '');
  if (current.includes('50条/页')) return;
  await trigger.click().catch(() => {});
  await sleep(300);
  const option = page.getByText('50条/页', { exact: true }).last();
  if (await option.count()) await option.click().catch(() => {});
  await sleep(ACTION_DELAY);
}

async function gotoTaskFirst(page, { forceReload = false } = {}) {
  const currentUrl = page.url() || '';
  const alreadyOnTaskPage = currentUrl.includes('/pc-workflow/#/handleTask');
  if (!alreadyOnTaskPage) {
    await page.goto(TASK_PAGE, { waitUntil: 'domcontentloaded' });
    // A route change can retain stale list data, so refresh only after entering
    // the task page from another route.
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else if (forceReload) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await sleep(700);
  await setPageSize50(page);
  const firstPage = page.getByRole('listitem', { name: '第 1 页' });
  if (await firstPage.count()) {
    await firstPage.click().catch(() => {});
    await sleep(700);
  }
}

async function retryWithReload(page, action, label, retries = 3, recoveryUrl = TASK_PAGE, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      console.warn(`${label}失败，第 ${attempt} 次重试：${error.message}`);
      if (onRetry) await onRetry(error);
      if (recoveryUrl === TASK_PAGE) {
        await gotoTaskFirst(page, { forceReload: true });
      } else {
        await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded' });
      }
      await sleep(1500);
    }
  }
  throw lastError;
}

async function collectTaskIds(page, projectPattern) {
  const ids = new Set();
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    for (const row of await page.getByRole('row').all()) {
      const text = await row.innerText().catch(() => '');
      if (projectPattern.test(text)) {
        const id = text.match(/\b\d{15,}\b/)?.[0];
        if (id) ids.add(id);
      }
    }
    const next = page.getByRole('button', { name: '下一页' });
    if (await next.count() === 0 || !(await next.isEnabled())) break;
    await next.click();
    await sleep(700);
  }
  return ids;
}

async function waitForBatchCleared(page, projectPattern, batchIds) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await gotoTaskFirst(page);
    const visibleIds = await collectTaskIds(page, projectPattern);
    const pending = [...batchIds].filter((id) => visibleIds.has(id));
    if (pending.length === 0) return;
    console.log(`等待本批次工单从列表移除，剩余 ${pending.length} 条`);
    await sleep(1500);
  }
  throw new Error('本批次工单处理成功，但仍出现在待处理列表，已停止继续取号');
}

async function drainPendingTasks(page, projectPattern, projectName, outputFile) {
  for (let pass = 0; pass < 15; pass += 1) {
    await gotoTaskFirst(page);
    const pendingIds = await collectTaskIds(page, projectPattern);
    if (pendingIds.size === 0) return;
    console.log(`发现同项目未处理工单 ${pendingIds.size} 条，先处理完再取号`);
    for (const taskId of pendingIds) await processOneTask(page, taskId, projectName, '', outputFile);
    await waitForBatchCleared(page, projectPattern, pendingIds);
  }
  throw new Error('同项目待处理工单持续出现，已停止取号');
}

async function submitCallFailure(page, detailDialog) {
  const directFailure = detailDialog.getByRole('button', { name: '外呼失败', exact: true }).first();
  if (await directFailure.count()) {
    await directFailure.click();
    await sleep(ACTION_DELAY);
  } else {
    const feedback = detailDialog.getByRole('button', { name: '反馈外呼结果', exact: true }).first();
    if (!(await feedback.count())) throw new Error('详情弹窗中未找到“外呼失败”或“反馈外呼结果”按钮');
    await feedback.click();
    await sleep(ACTION_DELAY);
    const resultDialog = page.getByRole('dialog').last();
    await resultDialog.waitFor({ state: 'visible', timeout: 10000 });
    const failureOption = resultDialog.getByText('外呼失败', { exact: true }).last();
    if (!(await failureOption.count())) throw new Error('反馈外呼结果弹层中未找到“外呼失败”选项');
    await failureOption.click();
    await sleep(ACTION_DELAY);
  }
  const confirmDialog = page.getByRole('dialog').last();
  const confirm = confirmDialog.getByRole('button', { name: '确定', exact: true }).last();
  if (!(await confirm.count())) throw new Error('未找到外呼失败确认按钮');
  await confirm.click();
  await sleep(ACTION_DELAY);
}

async function processOneTask(page, taskId, projectName, fallbackProjectId, outputFile) {
  let phone;
  let projectId = fallbackProjectId;
  await retryWithReload(page, async () => {
    let taskRow = page.getByRole('row', { name: new RegExp(taskId) });
    if (await taskRow.count() === 0) {
      await gotoTaskFirst(page);
      for (let pageNo = 0; pageNo < 20 && await taskRow.count() === 0; pageNo += 1) {
        const next = page.getByRole('button', { name: '下一页' });
        if (await next.count() === 0 || !(await next.isEnabled())) break;
        await next.click();
        await sleep(700);
      }
    }
    await taskRow.getByRole('button', { name: '详情' }).click();
    await sleep(ACTION_DELAY);
    const detailDialog = page.getByRole('dialog', { name: '工单详情' });
    phone = await detailDialog.getByRole('textbox', { name: /客户号码/ }).first().inputValue();
    projectId = await detailDialog.getByRole('textbox', { name: /项目编号/ }).first().inputValue().catch(() => projectId);
    if (!/^1\d{10}$/.test(phone)) throw new Error(`读取到的客户号码格式异常：${phone}`);
    await submitCallFailure(page, detailDialog);
    await page.getByText('工单处理成功').last().waitFor({ state: 'visible', timeout: 10000 });
  }, `工单 ${taskId} 处理`);
  appendToExcel({ 客户号码: phone, 工单编号: taskId, 项目编号: projectId, 项目名称: projectName, 获取时间: new Date().toLocaleString('zh-CN', { hour12: false }), 处理结果: '外呼失败' }, outputFile);
  console.log(`已处理工单 ${taskId}：${phone}`);
}

function appendToExcel(record, outputFile) {
  let workbook;
  if (fs.existsSync(outputFile)) {
    workbook = XLSX.readFile(outputFile);
  } else {
    workbook = XLSX.utils.book_new();
  }

  const sheetName = '外呼号码';
  const existing = workbook.Sheets[sheetName]
    ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
    : [];
  existing.push(record);
  workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(existing);
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
  XLSX.writeFile(workbook, outputFile);
}


function appendReportToExcel(record, outputFile) {
  let workbook = fs.existsSync(outputFile) ? XLSX.readFile(outputFile) : XLSX.utils.book_new();
  const sheetName = '空军报表';
  const existing = workbook.Sheets[sheetName]
    ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }) : [];
  existing.push(record);
  workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(existing);
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
  XLSX.writeFile(workbook, outputFile);
}

function appendTaskQueryToExcel(record, outputFile) {
  let workbook = fs.existsSync(outputFile) ? XLSX.readFile(outputFile) : XLSX.utils.book_new();
  const sheetName = '工单查询';
  const existing = workbook.Sheets[sheetName]
    ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }) : [];
  existing.push(record);
  workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(existing);
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
  XLSX.writeFile(workbook, outputFile);
}

function cleanCellText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function getQueryTableRows(page) {
  const table = page.locator('.el-table').filter({ has: page.locator('.el-table__body-wrapper tbody tr') }).first();
  const headers = (await table.locator('.el-table__header-wrapper th').allInnerTexts().catch(() => []))
    .map(cleanCellText);
  const rows = await table.locator('.el-table__body-wrapper tbody tr').all().catch(() => []);
  const records = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cells = (await row.locator('td').allInnerTexts().catch(() => [])).map(cleanCellText);
    if (!cells.some(Boolean)) continue;
    const record = { 工单编号: '', 状态: '', 工单名称: '', 接单时间: '' };
    headers.forEach((header, cellIndex) => {
      if (!header || !cells[cellIndex]) return;
      const key = header.replace(/[：:]$/, '').trim();
      if (/工单编号|工单号/.test(key)) record.工单编号 = cells[cellIndex];
      else if (/状态/.test(key)) record.状态 = cells[cellIndex];
      else if (/名称/.test(key)) record.工单名称 = cells[cellIndex];
      else if (/接单时间/.test(key)) record.接单时间 = cells[cellIndex];
    });
    // Header text can vary slightly between deployments; use cell text as a
    // fallback while retaining the explicit fields requested for the export.
    const rowText = cells.join(' ');
    record.工单编号 ||= rowText.match(/\b\d{10,}\b/)?.[0] || '';
    records.push({ row, record });
  }
  return records;
}

async function extractDisplayTags(root) {
  // Match the supplied Vue/Element markup literally:
  // .el-form-item(label "3、展示标签") > .el-form-item__content >
  // .el-table > .el-table__body-wrapper > table > tbody > tr.el-table__row > td > .cell
  // Return rows from the matching item that actually contains data; this
  // avoids accidentally selecting the hidden empty dialog form-items.
  return root.locator('.el-form-item').evaluateAll((items) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const matches = [];
    for (const item of items) {
      const label = normalize(item.querySelector('.el-form-item__label')?.innerText || '');
      if (!label.includes('展示标签')) continue;
      const rows = [...item.querySelectorAll('.el-form-item__content .el-table__body-wrapper tbody tr.el-table__row')];
      const pairs = rows.map((row) => [...row.querySelectorAll('td .cell')].map((cell) => normalize(cell.innerText)))
        .filter((cells) => cells.length >= 2 && cells[0] && cells[1])
        .map((cells) => [cells[0], cells.slice(1).join(' ')]);
      if (pairs.length) matches.push({ label, pairs });
    }
    return matches.length ? matches[matches.length - 1].pairs : [];
  });
}

async function extractTaskHeaderAndHistory(page, record) {
  const visibleDialogs = page.locator('[role="dialog"]:visible');
  const detailRoot = await visibleDialogs.count() ? visibleDialogs.last() : page;
  const projectId = await detailRoot.locator('.el-form-item').evaluateAll((items) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    for (const item of items) {
      const label = normalize(item.querySelector('.el-form-item__label')?.innerText || '');
      if (!label.includes('项目编号')) continue;
      const input = item.querySelector('input.el-input__inner, textarea');
      const value = normalize(input?.value || '');
      if (value) return value;
    }
    return '';
  }).catch(() => '');
  if (projectId) record.项目编号 = projectId;

  const summary = await detailRoot.locator('.el-descriptions').evaluateAll((blocks) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const result = {};
    for (const block of blocks) {
      const text = normalize(block.innerText);
      if (!text.includes('工单编号') || !text.includes('工单名称')) continue;
      for (const row of block.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td.el-descriptions__cell')];
        for (let index = 0; index < cells.length - 1; index += 1) {
          if (!cells[index].classList.contains('el-descriptions__label')) continue;
          const label = normalize(cells[index].innerText).replace(/[：:]$/, '');
          const value = normalize(cells[index + 1].innerText);
          if (!label || !value) continue;
          if (/^工单编号$/.test(label)) result.工单编号 = value;
          else if (/^工单名称$/.test(label)) result.工单名称 = value;
          else if (/^工单状态$/.test(label)) result.状态 = value;
          else if (/^接单时间$/.test(label)) result.接单时间 = value;
        }
      }
      if (result.工单编号 || result.工单名称 || result.状态) break;
    }
    return result;
  }).catch(() => ({}));
  for (const [key, value] of Object.entries(summary)) {
    if (value) record[key] = value;
  }

  const history = await detailRoot.locator('.el-timeline-item').evaluateAll((items) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const result = { summaries: [], handlers: [], firstTimestamp: '' };
    for (const item of items) {
      if (!result.firstTimestamp) {
        result.firstTimestamp = normalize(item.querySelector('.el-timeline-item__timestamp')?.innerText || '');
      }
      const content = item.querySelector('.el-timeline-item__content') || item;
      const spans = [...content.querySelectorAll('span')];
      const values = { summary: '', handler: '' };
      for (const span of spans) {
        const label = normalize(span.innerText).replace(/[：:]$/, '');
        if (label !== '简要' && label !== '处理人') continue;
        const siblingSpans = [...(span.parentElement?.querySelectorAll(':scope > span') || [])];
        const index = siblingSpans.indexOf(span);
        const value = index >= 0 ? normalize(siblingSpans.slice(index + 1).map((node) => node.innerText).find(Boolean)) : '';
        if (label === '简要' && value) values.summary = value;
        if (label === '处理人' && value) values.handler = value;
      }
      const text = normalize(content.innerText);
      if (!values.summary) values.summary = text.match(/简要\s*[:：]\s*(.*?)(?=处理人\s*[:：]|$)/)?.[1]?.trim() || '';
      if (!values.handler) values.handler = text.match(/处理人\s*[:：]\s*(.*?)(?=简要\s*[:：]|$)/)?.[1]?.trim() || '';
      if (values.summary) result.summaries.push(values.summary);
      if (values.handler) result.handlers.push(values.handler);
    }
    return result;
  }).catch(() => ({ summaries: [], handlers: [], firstTimestamp: '' }));

  if (history.firstTimestamp) record['流转时间'] = history.firstTimestamp;
  record['流转历史简要'] = history.summaries.join('\n');
  record['流转历史处理人'] = history.handlers.join('\n');
}

async function extractTaskQueryDetail(page, listRecord) {
  const record = { ...listRecord };
  let pairs = [];
  for (let attempt = 0; attempt < 15; attempt += 1) {
    pairs = await extractDisplayTags(page).catch(() => []);
    if (pairs.length) break;
    await sleep(REPORT_RETRY_DELAY);
  }
  for (const [key, value] of pairs) record[key] = value;
  if (!pairs.length) {
    const diagnostic = await page.locator('.el-form-item').evaluateAll((items) => items
      .map((item) => `${item.querySelector('.el-form-item__label')?.innerText || ''}: ${item.querySelector('.el-form-item__content')?.innerText || ''}`)
      .filter((line) => line.includes('展示标签')).join(' | ')).catch(() => '');
    throw new Error(`未读取到展示标签行；匹配项内容：${cleanCellText(diagnostic).slice(0, 220) || '页面中找不到“展示标签”表单项'}`);
  }
  await extractTaskHeaderAndHistory(page, record);
  return record;
}

async function closeTaskQueryDetail(page) {
  const dialog = page.locator('[role="dialog"]:visible').last();
  const close = dialog.locator('button[aria-label="关闭此对话框"], .el-dialog__headerbtn').first();
  if (await close.count()) await close.click();
  else await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await sleep(ACTION_DELAY);
}

async function goToQueryFirstPage(page) {
  const first = page.locator('.el-pagination li[aria-label="第 1 页"]').first();
  if (await first.count() && !await first.getAttribute('class').then((value) => /active/.test(value || '')).catch(() => false)) {
    await first.click();
    await sleep(ACTION_DELAY);
  }
}

async function goToQueryPage(page, pageNumber) {
  if (pageNumber <= 1) {
    await goToQueryFirstPage(page);
    return;
  }
  const editor = page.locator('.el-pagination__editor input:visible, .el-pagination input[aria-label*="页"]:visible').last();
  if (!(await editor.count())) {
    throw new Error('未找到分页页码输入框，无法跳转到指定页');
  }
  await editor.fill(String(pageNumber));
  await editor.press('Enter');
  await sleep(ACTION_DELAY);
  const activePage = page.locator('.el-pagination li.is-active').last();
  await activePage.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const activeText = cleanCellText(await activePage.innerText().catch(() => ''));
  if (activeText && activeText !== String(pageNumber)) {
    throw new Error(`分页跳转失败，当前页为 ${activeText}，目标页为 ${pageNumber}`);
  }
}

async function goToQueryNextPage(page) {
  const next = page.locator('.el-pagination .btn-next').first();
  if (await next.count()) {
    const disabled = await next.getAttribute('disabled').catch(() => null);
    const className = await next.getAttribute('class').catch(() => '');
    if (disabled !== null || /is-disabled/.test(className || '')) return false;
    await next.click();
    await sleep(ACTION_DELAY);
    return true;
  }
  const accessibleNext = page.getByRole('button', { name: '下一页' }).first();
  if (!(await accessibleNext.count()) || !(await accessibleNext.isEnabled().catch(() => false))) return false;
  await accessibleNext.click();
  await sleep(ACTION_DELAY);
  return true;
}

async function runTaskQuery(amount, startPage = 1) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '_').slice(0, 13);
  const outputDir = path.join(__dirname, '执行结果', '工单查询');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `工单查询_${timestamp}.xlsx`);
  console.log(`工单查询结果文件：${outputFile}`);
  const browser = await withTimeout(chromium.connectOverCDP(CDP_URL), 10000, '连接 Chrome 超时，请确认远程调试端口 9222 已启动');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((item) => (item.url() || '').includes('/searchTask/myHandled'))
    || [...pages].reverse().find((item) => (item.url() || '').includes('/pc-workflow/'))
    || pages[pages.length - 1] || await context.newPage();

  await page.goto(QUERY_TASK_PAGE, { waitUntil: 'domcontentloaded' });
  await page.bringToFront().catch(() => {});
  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.el-table__body-wrapper tbody tr').first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
  await goToQueryPage(page, startPage);

  let saved = 0;
  let pagesVisited = startPage - 1;
  while (saved < amount) {
    pagesVisited += 1;
    const rows = await getQueryTableRows(page);
    if (!rows.length) {
      console.log(`第 ${pagesVisited} 页没有工单，停止查询`);
      break;
    }
    console.log(`正在查询第 ${pagesVisited} 页，本页 ${rows.length} 条`);
    for (let rowIndex = 0; rowIndex < rows.length && saved < amount; rowIndex += 1) {
      const currentRows = await page.locator('.el-table__body-wrapper tbody tr').all();
      const row = currentRows[rowIndex];
      if (!row) break;
      const detailButton = row.getByText('详情', { exact: true }).first();
      if (!(await detailButton.count())) throw new Error(`第 ${pagesVisited} 页第 ${rowIndex + 1} 条工单没有“详情”入口`);
      await detailButton.click();
      const record = await extractTaskQueryDetail(page, rows[rowIndex].record);
      appendTaskQueryToExcel(record, outputFile);
      saved += 1;
      console.log(`已保存工单查询结果 ${saved}/${amount}：${record.工单编号 || '未识别编号'}`);
      await closeTaskQueryDetail(page);
    }
    if (saved >= amount) break;
    if (!await goToQueryNextPage(page)) break;
  }
  console.log(`工单查询完成，从第 ${startPage} 页开始，已保存 ${saved}/${amount} 条，查询页数 ${pagesVisited}，文件：${outputFile}`);
}

async function scrollReportTable(page) {
  await page.locator('.el-table__body-wrapper, .el-scrollbar__wrap').evaluateAll((elements) => {
    for (const element of elements) {
      element.scrollTop = element.scrollHeight;
    }
  }).catch(() => {});
  await sleep(400);
}

async function collectReportRows(page, projectId) {
  const rows = [];
  for (let pageNo = 0; pageNo < 100; pageNo += 1) {
    await scrollReportTable(page);
    for (const row of await page.getByRole('row').all()) {
      const text = await row.innerText().catch(() => '');
      if (!text || !text.includes(projectId)) continue;
      const taskId = text.match(/\b\d{15,}\b/)?.[0];
      const detail = row.getByText('详情', { exact: true }).first();
      if (taskId && await detail.count()) rows.push({ taskId });
    }
    const next = page.getByRole('button', { name: '下一页' }).first();
    if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) break;
    await next.click();
    await sleep(ACTION_DELAY);
  }
  return rows;
}

async function locateReportRow(page, projectId, taskId) {
  for (let pageNo = 0; pageNo < 100; pageNo += 1) {
    await scrollReportTable(page);
    const row = page.getByRole('row', { name: new RegExp(escapeRegExp(taskId)) }).filter({ hasText: projectId }).first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      return row;
    }
    const next = page.getByRole('button', { name: '下一页' }).first();
    if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) break;
    await next.click();
    await sleep(ACTION_DELAY);
  }
  return null;
}

async function extractReportDetail(page) {
  const dialog = page.locator('[role="dialog"]:visible').last();
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const record = { 抓取时间: new Date().toLocaleString('zh-CN', { hour12: false }) };
  for (const input of await dialog.locator('input').all()) {
    const value = await input.inputValue().catch(() => '');
    if (/^1\d{10}$/.test(value)) record.手机号 = value;
    if (/^20\d{10,}$/.test(value)) record.项目编号 = value;
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const pairs = await extractDisplayTags(dialog).catch(() => []);
    if (pairs.length) {
      for (const [key, value] of pairs) record[key] = value;
      return record;
    }
    await sleep(REPORT_RETRY_DELAY);
  }
  throw new Error('详情弹层展示标签加载超时');
}

async function waitForReportReady(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pageText = await page.locator('body').innerText().catch(() => '');
    const hasProjectLabel = pageText.includes('项目编号');
    const input = page.locator('input.el-input__inner[placeholder*="精确匹配"]').first();
    const hasInput = await input.count().catch(() => 0) && await input.isVisible().catch(() => false);
    if (hasProjectLabel && hasInput) return;
    console.log(`等待空军报表页面初始化（${(attempt + 1) * 2}/60 秒）`);
    await sleep(2000);
  }
  throw new Error('空军报表页面初始化超过60秒，任务已结束');
}

async function findReportProjectInput(page) {
  const formItem = page.locator('.el-form-item').filter({ hasText: '项目编号' }).first();
  const input = formItem.locator('input.el-input__inner[type="text"]').first();
  if (await input.count().catch(() => 0)) return input;
  return page.locator('input.el-input__inner[type="text"]').first();
}

async function fillAndSearchReport(page, projectId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const input = await findReportProjectInput(page);
    await input.waitFor({ state: 'visible', timeout: 1500 });
    await input.click();
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await input.fill('').catch(() => {});
    await input.pressSequentially(String(projectId), { delay: 20 });
    await input.press('Tab').catch(() => {});
    await sleep(250);
    if (await input.inputValue().catch(() => '') === String(projectId)) {
      console.log(`已录入项目编号：${projectId}`);
      await page.getByRole('button', { name: '搜索' }).first().click();
      await sleep(ACTION_DELAY);
      return;
    }
    await sleep(300);
  }
  throw new Error(`项目编号填充失败：${projectId}`);
}

async function waitForReportResults(page, projectId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await page.getByRole('row').all();
    for (const row of rows) {
      const text = await row.innerText().catch(() => '');
      if (text.includes(projectId) || /\b\d{15,}\b/.test(text)) {
        console.log(`报表数据已加载（等待 ${(attempt + 1) * 2} 秒）`);
        return;
      }
    }
    const empty = await page.getByText('暂无数据', { exact: true }).count().catch(() => 0);
    if (empty) {
      console.log(`报表暂无数据，继续等待（${(attempt + 1) * 2}/60 秒）`);
    }
    await sleep(2000);
  }
  throw new Error('点击搜索后等待报表数据超过60秒，任务已结束');
}

async function runAirForceReport(projectId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '_').slice(0, 13);
  const outputDir = path.join(__dirname, '执行结果', '空军报表');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `空军报表_${timestamp}.xlsx`);
  console.log(`空军报表结果文件：${outputFile}`);
  console.log(`正在连接 Chrome（${CDP_URL}）...`);
  const browser = await withTimeout(chromium.connectOverCDP(CDP_URL), 10000, '连接 Chrome 超时，请确认远程调试端口 9222 已启动');
  console.log('Chrome 连接成功，正在准备空军报表页面...');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((item) => (item.url() || '').includes('/kyxm/report/secondReport'))
    || [...pages].reverse().find((item) => (item.url() || '').includes('/pc-workflow/'))
    || pages[pages.length - 1] || await context.newPage();
  await withTimeout(page.goto(REPORT_PAGE, { waitUntil: 'commit', timeout: 15000 }), 20000, '打开空军报表页面超时');
  await page.bringToFront().catch(() => {});
  console.log('空军报表路由已打开，等待页面初始化...');
  await withTimeout(page.reload({ waitUntil: 'commit', timeout: 15000 }), 20000, '刷新空军报表页面超时');
  await sleep(300);
  console.log('开始检查页面是否出现项目编号...');
  await waitForReportReady(page);
  console.log('页面初始化完成，准备录入项目编号...');
  await fillAndSearchReport(page, projectId);
  await waitForReportResults(page, projectId);
  const rows = await collectReportRows(page, projectId);
  console.log(`空军报表查询到 ${rows.length} 条记录`);
  // Keep the current page and search condition; only return pagination to page 1.
  const firstPage = page.getByRole('listitem', { name: '第 1 页' }).first();
  if (await firstPage.count()) {
    await firstPage.click().catch(() => {});
    await sleep(ACTION_DELAY);
  }

  let saved = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const target = await locateReportRow(page, projectId, rows[index].taskId);
    if (!target) { console.warn(`第 ${index + 1} 条记录定位失败，跳过`); continue; }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    const detailButton = target.getByText('详情', { exact: true }).first();
    await detailButton.scrollIntoViewIfNeeded().catch(() => {});
    await detailButton.click();
    const record = await extractReportDetail(page);
    appendReportToExcel(record, outputFile);
    saved += 1;
    console.log(`已保存空军报表第 ${saved}/${rows.length} 条`);
    const dialog = page.getByRole('dialog').last();
    const close = dialog.locator('button[aria-label="关闭此对话框"]').first();
    if (await close.count()) await close.click().catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(ACTION_DELAY);
  }
  console.log(`空军报表处理完成，共保存 ${saved} 条`);
}

async function main() {
  if (process.env.PHONE_AUTOMATION_MODE === TASK_QUERY_MODE) {
    const amountText = process.env.PHONE_AUTOMATION_AMOUNT || await ask('请输入工单查询数量：');
    const startText = process.env.PHONE_AUTOMATION_START_PAGE || await ask('请输入起始页码（回车默认第 1 页）：', '1');
    const amount = Number(amountText);
    const startPage = Number(startText);
    if (!Number.isInteger(amount) || amount < 1 || amount > 10000) throw new Error('查询数量必须是 1-10000 的整数');
    if (!Number.isInteger(startPage) || startPage < 1 || startPage > 10000) throw new Error('起始页码必须是 1-10000 的整数');
    await runTaskQuery(amount, startPage);
    return;
  }
  if (process.env.PHONE_AUTOMATION_MODE === REPORT_MODE) {
    const projectId = process.env.PHONE_AUTOMATION_PROJECT_ID || await ask('请输入项目编号：');
    if (!projectId.trim()) throw new Error('项目编号不能为空');
    await runAirForceReport(projectId.trim());
    return;
  }
  const projectName = process.env.PHONE_AUTOMATION_PROJECT
    || await ask(`请输入项目名称（回车使用默认：${DEFAULT_PROJECT_NAME}）：`, DEFAULT_PROJECT_NAME);
  const amountText = process.env.PHONE_AUTOMATION_AMOUNT
    || await ask('请输入本次处理数量（0-50）：');
  const amount = Number(amountText);
  if (!Number.isInteger(amount) || amount < 0 || amount > 50) throw new Error('处理数量必须是 0-50 的整数');
  if (amount === 0) {
    console.log('本次处理数量为 0，任务结束。');
    return;
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '_').slice(0, 13);
  const outputDir = path.join(__dirname, '执行结果', '外呼取码');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `外呼号码_${timestamp}.xlsx`);
  console.log(`本次结果文件：${outputFile}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (error) {
    throw new Error(`无法连接已打开的 Chrome（${CDP_URL}）。请先完全退出 Chrome，再按 README 的远程调试命令启动。\n${error.message}`);
  }
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((item) => (item.url() || '').includes('/pc-workflow/')) || pages[0] || await context.newPage();
  try {
    if (!(page.url() || '').includes('/pc-workflow/')) {
      await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      if (await page.getByText('登录', { exact: true }).count()) {
        console.log(`请在 Chrome 中登录：${LOGIN_PAGE}`);
        await waitForEnter('登录完成后回到工作台，并按回车继续：');
      }
      const systemTile = page.getByText('智胜系统', { exact: true }).first();
      await systemTile.waitFor({ state: 'visible', timeout: 30000 });
      await systemTile.click();
      await page.waitForTimeout(1200);
    }
    if (!(page.url() || '').includes('/pc-workflow/')) {
      await page.goto(PHONE_PAGE, { waitUntil: 'domcontentloaded' });
    }
    if (!(page.url() || '').includes('/pc-workflow/#/kyxm/usePhone2')) {
      await page.goto(PHONE_PAGE, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(1200);

    if (await page.getByText('登录', { exact: true }).count()) {
      console.log('请在打开的浏览器中完成登录。');
      await waitForEnter('登录完成后按回车继续：');
      await page.goto(PHONE_PAGE, { waitUntil: 'domcontentloaded' });
    }

    const projectPattern = new RegExp(escapeRegExp(projectName));
    let processed = 0;
    const processedTaskIds = new Set();
    while (processed < amount) {
      // The list must be empty before every take operation.
      await drainPendingTasks(page, projectPattern, projectName, outputFile);
      await gotoTaskFirst(page);
      const beforeIds = await collectTaskIds(page, projectPattern);
      if (beforeIds.size > 0) continue;

      await page.goto(PHONE_PAGE, { waitUntil: 'domcontentloaded' });
      await sleep(ACTION_DELAY);
      const projectRows = await page.getByRole('row').all();
      let projectRow;
      let projectId = '';
      for (const row of projectRows) {
        const text = await row.innerText().catch(() => '');
        if (!projectPattern.test(text)) continue;
        const remaining = Number(text.match(/取数\s+(\d+)/)?.[1] || 0);
        if (remaining > 0) {
          projectRow = row;
          projectId = text.match(/\b20\d{12,}\b/)?.[0] || '';
          break;
        }
      }
      if (!projectRow) throw new Error(`找不到有剩余数量的项目：${projectName}`);

      const batch = Math.min(20, amount - processed);
      await retryWithReload(page, async () => {
        const row = page.getByRole('row', { name: new RegExp(escapeRegExp(projectId || projectName)) }).filter({ hasText: projectName }).first();
        await row.getByRole('button', { name: '取数' }).click();
        await sleep(ACTION_DELAY);
        await page.getByRole('textbox', { name: /请输入取数的数量/ }).fill(String(batch));
        await sleep(ACTION_DELAY);
        await page.getByRole('dialog').getByRole('button', { name: '确定' }).click();
        await sleep(ACTION_DELAY);
        const limitToast = page.getByText(/进行中的工单数量不能超过20个/).last();
        if (await limitToast.count() && await limitToast.isVisible().catch(() => false)) {
          throw new Error('进行中的工单数量不能超过20个');
        }
        await page.getByText(new RegExp(`取用成功\\s*${batch}个`)).last().waitFor({ state: 'visible', timeout: 10000 });
      }, '取数', 3, PHONE_PAGE, async (error) => {
        if (error.message.includes('进行中的工单数量不能超过20个')) {
          await gotoTaskFirst(page);
          const pendingIds = await collectTaskIds(page, projectPattern);
          if (pendingIds.size) {
            console.log(`检测到数量限制，自动处理同项目未完成工单 ${pendingIds.size} 条`);
            for (const taskId of pendingIds) await processOneTask(page, taskId, projectName, projectId, outputFile);
            await waitForBatchCleared(page, projectPattern, pendingIds);
          }
        }
      });
      console.log(`取数成功：${batch} 个，项目编号：${projectId || '未识别'}`);

      await gotoTaskFirst(page);
      const batchTaskIds = new Set();
      for (let i = 0; i < batch; i += 1) {
        let candidateId = '';
        for (let attempt = 0; attempt < 15 && !candidateId; attempt += 1) {
          await gotoTaskFirst(page);
          const currentIds = await collectTaskIds(page, projectPattern);
          candidateId = [...currentIds].find((id) => !beforeIds.has(id) && !processedTaskIds.has(id)) || '';
          if (!candidateId) { await page.waitForTimeout(2000); await page.reload(); await page.waitForTimeout(700); }
        }
        if (!candidateId) throw new Error(`未找到本批次第 ${i + 1} 条新工单`);
        batchTaskIds.add(candidateId);
        await gotoTaskFirst(page);
        for (let pageNo = 0; pageNo < 20 && await page.getByRole('row', { name: new RegExp(candidateId) }).count() === 0; pageNo += 1) {
          const next = page.getByRole('button', { name: '下一页' });
          if (await next.count() === 0 || !(await next.isEnabled())) break;
          await next.click();
          await sleep(700);
        }
        await processOneTask(page, candidateId, projectName, projectId, outputFile);
        processedTaskIds.add(candidateId);
        processed += 1;
        console.log(`已处理 ${processed}/${amount}`);
        await page.waitForTimeout(300);
      }
      await waitForBatchCleared(page, projectPattern, batchTaskIds);
    }
    console.log(`批量处理完成，共 ${processed} 条，已写入：${outputFile}`);
  } finally {
    // The browser is owned by the user and must remain open after CDP disconnects.
  }
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exitCode = 1;
});
