import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';

// Single shared output channel so background poller runs are visible without opening a terminal.
let _output: vscode.OutputChannel | undefined;
export function output(): vscode.OutputChannel {
    if (!_output) { _output = vscode.window.createOutputChannel('Jira Agent'); }
    return _output;
}

// Layout under the .jira-agent home (single source of truth shared with the poller CLI):
//   config.json                 - global DEFAULTS used to seed new workflows
//   workflows/<id>.json         - one file per workflow (repo/board/label/interval/rules)
//   workflows/<id>.state.json   - per-workflow ticket state { "ABC-123": { status, ts, note } }
//   logs/                       - dispatch logs
export function homeDir(): string {
    const cfg = vscode.workspace.getConfiguration('jiraAgent').get<string>('homeDir');
    if (cfg && cfg.trim()) { return cfg.trim(); }
    return path.join(os.homedir(), '.jira-agent');
}
export function configPath(): string { return path.join(homeDir(), 'config.json'); }
export function statePath(): string { return path.join(homeDir(), 'state.json'); }
export function logsDir(): string { return path.join(homeDir(), 'logs'); }
export function workflowsDir(): string { return path.join(homeDir(), 'workflows'); }

export function exists(p: string): boolean {
    try { return fs.existsSync(p); } catch { return false; }
}

// PowerShell 5.1 (Set-Content -Encoding UTF8) writes a UTF-8 BOM; JSON.parse chokes on it.
function readJsonFile(p: string): any {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) { raw = raw.slice(1); }
    return JSON.parse(raw);
}

export function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

// -------- global defaults (config.json) --------
export function defaultConfig(): any {
    return {
        pollIntervalMinutes: 10,
        jiraBaseUrl: '',
        projectKey: '',
        agentLabel: 'claude-fix',
        lockLabel: 'claude-in-progress',
        doneLabel: 'claude-done',
        blockLabel: 'claude-blocked',
        failLabel: 'claude-failed',
        maxTicketsPerRun: 2,
        claudeArgs: [],
        rules: []
    };
}
export function ensureConfig(): boolean {
    const p = configPath();
    if (exists(p)) { return false; }
    try {
        fs.mkdirSync(homeDir(), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(defaultConfig(), null, 2), 'utf8');
        return true;
    } catch (e: any) {
        vscode.window.showWarningMessage(`Jira Agent: could not create default config.json: ${e?.message ?? e}`);
        return false;
    }
}
export function readConfig(): any | undefined {
    try { return readJsonFile(configPath()); } catch { return undefined; }
}
export function writeConfig(obj: any): void {
    fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2), 'utf8');
}

// -------- workflows (one file each) --------
export function ensureWorkflowsDir(): void {
    try { fs.mkdirSync(workflowsDir(), { recursive: true }); } catch { /* ignore */ }
}
export function listWorkflows(): any[] {
    let files: string[] = [];
    try {
        files = fs.readdirSync(workflowsDir()).filter(f => f.endsWith('.json') && !f.endsWith('.state.json'));
    } catch { return []; }
    const out: any[] = [];
    for (const f of files) {
        try {
            const full = path.join(workflowsDir(), f);
            const w = readJsonFile(full);
            w._file = full;
            w._id = w.id || path.basename(f, '.json');
            out.push(w);
        } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => String(a.name || a._id).localeCompare(String(b.name || b._id)));
}
export function readWorkflow(file: string): any | undefined {
    try {
        const w = readJsonFile(file);
        w._file = file;
        w._id = w.id || path.basename(file, '.json');
        return w;
    } catch { return undefined; }
}
export function writeWorkflow(w: any): string {
    ensureWorkflowsDir();
    const id = w.id || slug(w.name || 'workflow');
    w.id = id;
    const file = w._file || path.join(workflowsDir(), `${id}.json`);
    const clone: any = { ...w };
    delete clone._file;
    delete clone._id;
    fs.writeFileSync(file, JSON.stringify(clone, null, 2), 'utf8');
    return file;
}
export function deleteWorkflowFiles(id: string, file: string): void {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    try { fs.unlinkSync(workflowStatePath(id)); } catch { /* ignore */ }
}
// Seed a new workflow from the global defaults. labels can hold one or many agent labels.
export function newWorkflow(name: string, repo: string, labels: string[], intervalMin: number): any {
    const c = readConfig() || defaultConfig();
    const list = (labels && labels.length) ? labels : [c.agentLabel || 'claude-fix'];
    const jql = list.length > 1
        ? `assignee = currentUser() AND labels in (${list.join(', ')})`
        : `assignee = currentUser() AND labels = ${list[0]}`;
    return {
        id: slug(name),
        name,
        autoRun: true,   // create-time preference: auto-start on add
        enabled: true,   // live on/off state gated by the poller; toggled by Start/Stop
        labelMatch: 'any',
        pollIntervalMinutes: intervalMin || c.pollIntervalMinutes || 10,
        jiraBaseUrl: c.jiraBaseUrl || '',
        projectKey: c.projectKey || '',
        jql,
        repo: repo || '',
        agentLabel: list[0],
        lockLabel: c.lockLabel || 'claude-in-progress',
        doneLabel: c.doneLabel || 'claude-done',
        blockLabel: c.blockLabel || 'claude-blocked',
        failLabel: c.failLabel || 'claude-failed',
        maxTicketsPerRun: c.maxTicketsPerRun || 2,
        claudeArgs: (c.claudeArgs && c.claudeArgs.length) ? c.claudeArgs : ['--dangerously-skip-permissions'],
        rules: [
            { name: 'default', labels: list, issueTypes: [], handler: 'implement-task', instructions: '' }
        ]
    };
}

// -------- Jira REST (read-only lookups for the form) --------
// Auth from env vars set by setup-option1.cmd (JIRA_API_TOKEN + JIRA_USER).
function jiraAuthHeader(): string {
    const token = process.env.JIRA_API_TOKEN;
    const user = process.env.JIRA_USER;
    if (!token || !user) {
        throw new Error('JIRA_API_TOKEN / JIRA_USER not set in this environment. Run setup-option1.cmd, then restart the IDE.');
    }
    return 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
}
async function jiraGet(base: string, pathQuery: string): Promise<any> {
    const f: any = (globalThis as any).fetch;
    if (!f) { throw new Error('fetch is unavailable (needs a Node 18+ IDE runtime).'); }
    const url = base.replace(/\/$/, '') + pathQuery;
    const res = await f(url, { headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' } });
    if (!res.ok) { throw new Error(`Jira ${pathQuery} -> HTTP ${res.status}`); }
    return res.json();
}
export async function getJiraLabels(base: string): Promise<string[]> {
    const j = await jiraGet(base, '/rest/api/3/label?maxResults=1000');
    return Array.isArray(j.values) ? j.values : [];
}
export async function getJiraIssueTypes(base: string, projectKey: string): Promise<string[]> {
    try {
        const p = await jiraGet(base, `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
        if (Array.isArray(p.issueTypes) && p.issueTypes.length) {
            return p.issueTypes.map((t: any) => t.name).filter(Boolean);
        }
    } catch { /* fall back to createmeta */ }
    const j = await jiraGet(base, `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`);
    const proj = j.projects && j.projects[0];
    return (proj && Array.isArray(proj.issuetypes)) ? proj.issuetypes.map((t: any) => t.name).filter(Boolean) : [];
}

// Clone a git/GitHub repo into parentDir; resolves to the created folder path.
export function cloneRepo(url: string, parentDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const m = url.replace(/\.git$/i, '').match(/([^/\\]+)$/);
        const name = m ? m[1] : 'repo';
        const target = path.join(parentDir, name);
        if (exists(target)) { reject(new Error(`target already exists: ${target}`)); return; }
        execFile('git', ['clone', url, target], { cwd: parentDir }, (err, _stdout, stderr) => {
            if (err) { reject(new Error(stderr?.toString().trim() || err.message)); return; }
            resolve(target);
        });
    });
}

// -------- per-workflow state --------
export function workflowStatePath(id: string): string { return path.join(workflowsDir(), `${id}.state.json`); }
export function readWorkflowState(id: string): Record<string, any> {
    try {
        const o = readJsonFile(workflowStatePath(id));
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}
// Runtime signals for a workflow. `_meta` is written by the poller (running phase, last result);
// blocked count is derived from ticket entries. Meta keys are prefixed with '_' so they are not
// mistaken for tickets.
export function workflowRuntime(id: string): { running?: string; lastResult?: string; lastError?: string; lastRun?: string; activeTicket?: string; blocked: number } {
    const s = readWorkflowState(id);
    const meta: any = s._meta || {};
    let blocked = 0;
    for (const k of Object.keys(s)) {
        if (k.startsWith('_')) { continue; }
        if (String((s[k] || {}).status) === 'blocked') { blocked++; }
    }
    return {
        running: meta.running,
        lastResult: meta.lastResult,
        lastError: meta.lastError,
        lastRun: meta.lastRun,
        activeTicket: meta.activeTicket,
        blocked
    };
}

// Health of the headless background poller itself - the Windows scheduled task that ticks on an
// interval and runs poller-run.ps1. This is the process the status view tracks: is it registered
// and enabled (alive), and when did/does it tick. Result is cached briefly because a single tree
// refresh calls statusOf() once per workflow row.
const POLLER_TASK_NAME = 'Jira-Agent-Poller';
let _taskCache: { at: number; state: PollerTaskState } | undefined;
export type PollerTaskState = { registered: boolean; enabled: boolean; lastRun?: string; nextRun?: string };
export function pollerTaskState(): PollerTaskState {
    if (_taskCache && (Date.now() - _taskCache.at) < 4000) { return _taskCache.state; }
    let state: PollerTaskState = { registered: false, enabled: false };
    if (os.platform() === 'win32') {
        try {
            const out = execFileSync('schtasks', ['/Query', '/TN', POLLER_TASK_NAME, '/FO', 'LIST', '/V'],
                { encoding: 'utf8', windowsHide: true, timeout: 4000 });
            const field = (label: string) => {
                const line = out.split(/\r?\n/).find(l => l.trim().toLowerCase().startsWith(label.toLowerCase()));
                return line ? line.slice(line.indexOf(':') + 1).trim() : '';
            };
            // "Scheduled Task State" is Enabled/Disabled; "Status" is Ready/Running/Disabled.
            const taskState = field('Scheduled Task State') || field('Status');
            state = {
                registered: true,
                enabled: !/disabled/i.test(taskState),
                lastRun: field('Last Run Time'),
                nextRun: field('Next Run Time')
            };
        } catch { /* task not registered (schtasks exits non-zero) -> registered:false */ }
    } else {
        try {
            const out = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const script = pollerRunScript();
            if (script && out.includes(script)) {
                const lines = out.split('\n');
                const active = lines.some(l => l.trim() && !l.trim().startsWith('#') && l.includes(script));
                state = {
                    registered: true,
                    enabled: active,
                    lastRun: undefined,
                    nextRun: 'Every minute (cron)'
                };
            }
        } catch { /* crontab empty or command failed */ }
    }
    _taskCache = { at: Date.now(), state };
    return state;
}

// Register (idempotently) the headless background poller as a scheduled task (Windows Task Scheduler or Unix cron) that ticks every
// minute and runs poller-run.ps1. poller-run gates each workflow by its own pollIntervalMinutes, so
// one task serves ALL workflows - this is a one-time global setup, not per-workflow. Called from
// Start so the user never has to register the task by hand. No elevation needed.
export function ensurePollerTask(): { ok: boolean; message: string } {
    const existing = pollerTaskState();
    if (existing.registered && existing.enabled) { return { ok: true, message: 'already registered' }; }
    const script = pollerRunScript();
    if (!script || !exists(script)) {
        return { ok: false, message: 'poller-run.ps1 not found. Open the repo as a workspace folder, or set "jiraAgent.pollerScriptPath" in Settings.' };
    }
    if (os.platform() === 'win32') {
        const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
        try {
            execFileSync('schtasks', ['/Create', '/TN', POLLER_TASK_NAME, '/TR', tr, '/SC', 'MINUTE', '/MO', '1', '/F'],
                { windowsHide: true, timeout: 8000 });
            _taskCache = undefined; // invalidate so the next status read reflects the new task
            return { ok: true, message: 'headless poller registered (ticks every minute)' };
        } catch (e: any) {
            return { ok: false, message: `schtasks create failed: ${String(e?.message || e)}` };
        }
    } else {
        try {
            let currentCron = '';
            try {
                currentCron = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            } catch { /* ignored if no crontab */ }
            const cronLine = `* * * * * pwsh -NoProfile -File "${script}"`;
            if (currentCron.includes(script)) {
                return { ok: true, message: 'already registered in crontab' };
            }
            const lines = currentCron.split('\n').filter(l => l.trim() && !l.includes('poller-run.ps1'));
            lines.push(cronLine);
            const newCron = lines.join('\n') + '\n';
            execFileSync('crontab', [], { input: newCron, encoding: 'utf8', timeout: 5000 });
            _taskCache = undefined;
            return { ok: true, message: 'headless poller registered in crontab (ticks every minute)' };
        } catch (e: any) {
            return { ok: false, message: `crontab registration failed: ${String(e?.message || e)}` };
        }
    }
}

export function disablePollerTask(): { ok: boolean; message: string } {
    if (os.platform() === 'win32') {
        try {
            execFileSync('schtasks', ['/Change', '/TN', POLLER_TASK_NAME, '/DISABLE'],
                { windowsHide: true, timeout: 8000 });
            _taskCache = undefined;
            return { ok: true, message: 'headless poller task disabled' };
        } catch (e: any) {
            try {
                execFileSync('schtasks', ['/Delete', '/TN', POLLER_TASK_NAME, '/F'],
                    { windowsHide: true, timeout: 8000 });
                _taskCache = undefined;
                return { ok: true, message: 'headless poller task deleted' };
            } catch (e2: any) {
                return { ok: false, message: `failed to disable/delete task: ${String(e2?.message || e2)}` };
            }
        }
    } else {
        try {
            let currentCron = '';
            try {
                currentCron = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            } catch {
                return { ok: true, message: 'crontab already empty' };
            }
            const script = pollerRunScript();
            const lines = currentCron.split('\n').filter(l => l.trim() && (!script || !l.includes(script)));
            if (lines.length === 0) {
                try {
                    execFileSync('crontab', ['-r'], { timeout: 5000 });
                } catch {
                    execFileSync('crontab', [], { input: '# empty crontab\n', encoding: 'utf8', timeout: 5000 });
                }
            } else {
                const newCron = lines.join('\n') + '\n';
                execFileSync('crontab', [], { input: newCron, encoding: 'utf8', timeout: 5000 });
            }
            _taskCache = undefined;
            return { ok: true, message: 'headless poller removed from crontab' };
        } catch (e: any) {
            return { ok: false, message: `failed to remove from crontab: ${String(e?.message || e)}` };
        }
    }
}

export function readLegacyState(): Record<string, any> {
    try {
        const o = readJsonFile(statePath());
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}
export function clearTicketState(key: string, workflowId?: string): void {
    if (!key) { return; }
    const p = (workflowId && workflowId !== '(default)') ? workflowStatePath(workflowId) : statePath();
    try {
        const o = readJsonFile(p);
        if (o && o[key]) {
            delete o[key];
            fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
            vscode.window.showInformationMessage(`Jira Agent: ${key} state cleared - it will be retried on the next poll.`);
            return;
        }
    } catch { /* fallthrough */ }
    vscode.window.showInformationMessage(`Jira Agent: ${key} has no state entry.`);
}

export function logFiles(): string[] {
    try { return fs.readdirSync(logsDir()).filter(f => f.endsWith('.log')).map(f => path.join(logsDir(), f)); } catch { return []; }
}
export function newestRunLog(): string | undefined {
    const all = logFiles();
    const daily = all.filter(f => path.basename(f).startsWith('agent-'));
    const pool = daily.length ? daily : all;
    if (!pool.length) { return undefined; }
    const withTime = pool.map(f => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return { f, m: 0 }; } });
    withTime.sort((a, b) => b.m - a.m);
    return withTime[0].f;
}
// Locate poller-run.ps1: explicit setting, else user-scope skills (packaged install), else the
// open workspace folders.
export function pollerRunScript(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('jiraAgent');
    const rel = path.join('.claude', 'skills', 'jira-poller', 'scripts', 'poller-run.ps1');

    const direct = cfg.get<string>('pollerScriptPath');
    if (direct && direct.trim() && exists(direct.trim())) { return direct.trim(); }

    // Packaged install: skills copied user-scope by the installer.
    const userScope = path.join(os.homedir(), '.claude', 'skills', 'jira-poller', 'scripts', 'poller-run.ps1');
    if (exists(userScope)) { return userScope; }

    for (const f of (vscode.workspace.workspaceFolders || [])) {
        const base = f.uri.fsPath;
        const c = path.join(base, rel);
        if (exists(c)) { return c; }
    }
    return undefined;
}
// Trigger ONE workflow to run now (begins scanning/dispatching + logging). Runs the poller as a
// HIDDEN background process (no cmd/terminal window pops up) and streams its output to the shared
// "Jira Agent" output channel. Returns the child process so the caller can stop it later.
export function runWorkflowNow(wfId: string): ChildProcess | undefined {
    const script = pollerRunScript();
    if (!script || !exists(script)) {
        vscode.window.showWarningMessage('Jira Agent: poller-run.ps1 not found. Open the repo as a workspace folder, or set "jiraAgent.pollerScriptPath" in Settings.');
        return undefined;
    }
    const out = output();
    out.show(true);
    out.appendLine(`\n=== ${new Date().toISOString()} start workflow ${wfId} ===`);
    const isWin = os.platform() === 'win32';
    const psCmd = isWin ? 'powershell.exe' : 'pwsh';
    const args = isWin
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Force', '-WorkflowId', wfId]
        : ['-NoProfile', '-File', script, '-Force', '-WorkflowId', wfId];
    const child = spawn(
        psCmd,
        args,
        { windowsHide: true, detached: false }
    );
    child.stdout?.on('data', d => out.append(String(d)));
    child.stderr?.on('data', d => out.append(String(d)));
    child.on('close', code => out.appendLine(`=== workflow ${wfId} exited (code ${code}) ===`));
    child.on('error', e => out.appendLine(`workflow ${wfId} error: ${e?.message ?? e}`));
    return child;
}
// Kill a process tree (the poller shell + its claude child).
export function killTree(pid: number): void {
    if (os.platform() === 'win32') {
        try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => { /* best effort */ }); } catch { /* ignore */ }
    } else {
        try { process.kill(pid, 'SIGKILL'); } catch {
            try { execFile('kill', ['-9', String(pid)], () => { /* best effort */ }); } catch { /* ignore */ }
        }
    }
}
// Reset the workflow's runtime running flag (used after a manual stop).
export function clearWorkflowRunning(wfId: string): void {
    const p = workflowStatePath(wfId);
    try {
        const s = readJsonFile(p);
        if (s && s._meta) { s._meta.running = null; s._meta.activeTicket = ''; fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8'); }
    } catch { /* ignore */ }
}
export function tailLines(file: string, n: number): string[] {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length).slice(-n); } catch { return []; }
}

export function openLatestLog(key?: string): void {
    if (!key) { return; }
    try {
        const dir = logsDir();
        const files = fs.readdirSync(dir).filter(f => f.endsWith(`-${key}.log`)).sort();
        if (!files.length) { vscode.window.showInformationMessage(`Jira Agent: no log found for ${key}.`); return; }
        const p = path.join(dir, files[files.length - 1]);
        vscode.workspace.openTextDocument(p).then(d => vscode.window.showTextDocument(d));
    } catch {
        vscode.window.showWarningMessage('Jira Agent: logs directory not found.');
    }
}
export function openInJira(key?: string, jiraBaseUrl?: string): void {
    if (!key) { return; }
    const base = (jiraBaseUrl || '').trim();
    if (!base) { vscode.window.showWarningMessage('Jira Agent: this workflow has no Jira base URL set.'); return; }
    vscode.env.openExternal(vscode.Uri.parse(`${base}/browse/${key}`));
}

// Run ALL due workflows now, in the background (no terminal window). Output streams to the channel.
export function runPollerNow(): ChildProcess | undefined {
    const script = pollerRunScript();
    if (!script || !exists(script)) {
        vscode.window.showWarningMessage('Jira Agent: poller-run.ps1 not found. Open the repo as a workspace folder, or set "jiraAgent.pollerScriptPath" in Settings.');
        return undefined;
    }
    const out = output();
    out.show(true);
    out.appendLine(`\n=== ${new Date().toISOString()} run poller (all workflows) ===`);
    const isWin = os.platform() === 'win32';
    const psCmd = isWin ? 'powershell.exe' : 'pwsh';
    const args = isWin
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Force']
        : ['-NoProfile', '-File', script, '-Force'];
    const child = spawn(
        psCmd,
        args,
        { windowsHide: true, detached: false }
    );
    child.stdout?.on('data', d => out.append(String(d)));
    child.stderr?.on('data', d => out.append(String(d)));
    child.on('close', code => out.appendLine(`=== poller exited (code ${code}) ===`));
    child.on('error', e => out.appendLine(`poller error: ${e?.message ?? e}`));
    return child;
}

// Copy the skills packaged INSIDE the VSIX (<extensionPath>/skills) into the user-scope skill folder
// (~/.claude/skills) so a fresh Marketplace install works with no separate bundle/installer. The
// poller auto-detect (pollerRunScript) already looks there. Re-copies only when the extension version
// changed, tracked by a marker file, so we do not clobber the user's skills on every launch.
export function bootstrapSkills(extensionPath: string, version: string): void {
    const src = path.join(extensionPath, 'skills');
    if (!exists(src)) { return; } // dev run without a staged skills/ folder - nothing to bootstrap
    const destRoot = path.join(os.homedir(), '.claude', 'skills');
    const marker = path.join(destRoot, '.jira-agent-skills-version');
    let current = '';
    try { current = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first install */ }
    if (current === version) { return; }
    try {
        fs.mkdirSync(destRoot, { recursive: true });
        for (const s of ['jira-poller', 'implement-task']) {
            const from = path.join(src, s);
            if (!exists(from)) { continue; }
            fs.cpSync(from, path.join(destRoot, s), { recursive: true, force: true });
        }
        fs.writeFileSync(marker, version, 'utf8');
    } catch (e: any) {
        vscode.window.showWarningMessage(`Jira Agent: could not install bundled skills to ${destRoot}: ${e?.message ?? e}`);
    }
}

export function watch(onChange: () => void): vscode.Disposable | undefined {
    const disposables: fs.FSWatcher[] = [];
    try { disposables.push(fs.watch(homeDir(), { persistent: false }, () => onChange())); } catch { /* ignore */ }
    try {
        ensureWorkflowsDir();
        disposables.push(fs.watch(workflowsDir(), { persistent: false }, () => onChange()));
    } catch { /* ignore */ }
    try {
        fs.mkdirSync(logsDir(), { recursive: true });
        disposables.push(fs.watch(logsDir(), { persistent: false }, () => onChange()));
    } catch { /* ignore */ }
    if (!disposables.length) { return undefined; }
    return new vscode.Disposable(() => disposables.forEach(w => { try { w.close(); } catch { /* ignore */ } }));
}
