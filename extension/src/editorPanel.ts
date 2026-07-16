import * as vscode from 'vscode';
import * as agent from './agent';

interface Field { key: string; label: string; hint: string; }

// Field hints shown behind the "!" tooltip in the form.
const HINTS: Record<string, string> = {
    name: 'Display name for this workflow.',
    autoRun: 'Auto run after add: when ON, the workflow starts running automatically on its interval as soon as it is added/saved. OFF = it stays idle until you turn this on.',
    pollIntervalMinutes: 'How often (in minutes) to scan Jira for new tickets. 1-1439. A ticket, once picked up, runs to completion regardless of this.',
    repo: 'Local working copy this workflow operates on. Use Browse, or Clone a GitHub repo.',
    labelMatch: 'How the query labels are combined: Any (OR), All (AND), None (exclude), or write your own JQL. assignee = current user is always applied (except in Custom).',
    jql: 'Custom JQL. Used only when match mode is "Custom". You may use any operators, e.g. labels in (a,b), labels ~ "sec", labels not in (x).',
    agentLabels: 'Label(s) used to query tickets: the poller picks up YOUR assigned tickets that carry any of these labels (assignee = current user is always applied). Separate multiple with ";".',
    handler: 'Skill that implements a matched ticket (e.g. implement-task).',
    issueTypes: 'Restrict to these Jira issue types (e.g. Bug;Defect). Use "Pick" to load from the project. If left empty, ALL of the project\'s issue types are filled in on save. Separate with ";".',
    projectKey: 'Jira project key (e.g. ABC) used to load issue types and scope the board.',
    instructions: 'Extra instructions passed to the handler for tickets matched by this workflow.',
    maxTicketsPerRun: 'Safety cap: maximum tickets dispatched per scan.',
    jiraBaseUrl: 'Your Jira site URL, e.g. https://your-org.atlassian.net.',
    lockLabel: 'Label the poller adds to a ticket while it is being worked on.',
    doneLabel: 'Label the poller adds when a ticket is completed.',
    blockLabel: 'Label added to a ticket when the agent blocks it (missing AC, blocked-by another ticket, needs a human).',
    failLabel: 'Label added to a ticket when the run fails (build/test gate failed or handler errored).',
    baseBranch: 'The default integration branch to branch off and merge into (e.g. main or master). If left empty, the repo\'s default integration branch is automatically detected.',
    createPR: 'Whether to automatically create a GitHub pull request after successfully implementing the task.'
};

function esc(s: any): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function nonce(): string {
    let t = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 24; i++) { t += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return t;
}

// Single reusable webview panel that edits (or creates) a workflow with per-field inputs + hints.
export class WorkflowEditor {
    private static current: WorkflowEditor | undefined;
    private readonly panel: vscode.WebviewPanel;
    private file: string | undefined;
    private disposables: vscode.Disposable[] = [];

    static open(context: vscode.ExtensionContext, file: string | undefined, onSaved: () => void): void {
        const column = vscode.ViewColumn.Active;
        if (WorkflowEditor.current) {
            WorkflowEditor.current.load(file);
            WorkflowEditor.current.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('jiraAgentWorkflowEditor', 'Jira Agent: Workflow', column, { enableScripts: true, retainContextWhenHidden: true });
        WorkflowEditor.current = new WorkflowEditor(panel, file, onSaved);
    }

    private constructor(panel: vscode.WebviewPanel, file: string | undefined, private onSaved: () => void) {
        this.panel = panel;
        this.file = file;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
        this.render();
    }

    private load(file: string | undefined): void {
        this.file = file;
        this.render();
    }

    private model(): any {
        if (this.file) {
            const w = agent.readWorkflow(this.file);
            if (w) { return w; }
        }
        return agent.newWorkflow('', '', [], 0);
    }

    private async onMessage(msg: any): Promise<void> {
        if (msg?.type === 'browse') {
            const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select repo folder' });
            if (picked && picked.length) { this.panel.webview.postMessage({ type: 'setRepo', path: picked[0].fsPath }); }
            return;
        }
        if (msg?.type === 'clone') {
            const url = String(msg.url || '').trim();
            if (!url) { vscode.window.showWarningMessage('Jira Agent: enter a repo URL to clone.'); return; }
            let parent = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!parent) {
                const p = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Clone into this folder' });
                if (!p || !p.length) { return; }
                parent = p[0].fsPath;
            }
            try {
                const target = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Jira Agent: cloning ${url}...` }, () => agent.cloneRepo(url, parent!));
                this.panel.webview.postMessage({ type: 'setRepo', path: target });
                vscode.window.showInformationMessage(`Jira Agent: cloned to ${target}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Jira Agent: clone failed: ${e?.message ?? e}`);
            }
            return;
        }
        if (msg?.type === 'pickLabels' || msg?.type === 'pickIssueTypes') {
            const base = String(msg.base || '').trim();
            if (!base) { vscode.window.showWarningMessage('Jira Agent: enter the Jira base URL first, then Pick.'); return; }
            const currentSet = new Set(String(msg.current || '').split(';').map((s: string) => s.trim()).filter(Boolean));
            try {
                const values = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Jira Agent: loading from Jira...' },
                    () => msg.type === 'pickLabels' ? agent.getJiraLabels(base) : agent.getJiraIssueTypes(base, String(msg.projectKey || 'PR').trim() || 'PR')
                );
                if (!values.length) { vscode.window.showInformationMessage('Jira Agent: nothing returned from Jira.'); return; }
                const items = values.map(v => ({ label: v, picked: currentSet.has(v) }));
                const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: msg.type === 'pickLabels' ? 'Select query labels' : 'Select issue types' });
                if (!picked) { return; }
                const value = picked.map(p => p.label).join('; ');
                this.panel.webview.postMessage({ type: msg.type === 'pickLabels' ? 'setLabels' : 'setIssueTypes', value });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Jira Agent: ${e?.message ?? e}`);
            }
            return;
        }
        if (msg?.type === 'save') {
            const d = msg.data || {};
            const name = String(d.name || '').trim();
            if (!name) { vscode.window.showWarningMessage('Jira Agent: name is required.'); return; }
            const isNew = !this.file;
            let labels = String(d.agentLabels || '').split(';').map((s: string) => s.trim()).filter(Boolean);
            if (!labels.length) { labels = ['claude-fix']; }
            const w: any = this.file ? (agent.readWorkflow(this.file) || {}) : agent.newWorkflow(name, '', labels, parseInt(d.pollIntervalMinutes, 10) || 10);
            w.name = name;
            if (!w.id) { w.id = agent.slug(name); }
            w.autoRun = !!d.autoRun;
            // autoRun is a CREATE-TIME preference only: "start automatically as soon as it is added".
            // The live on/off state is `enabled` (toggled by Start/Stop). On create we seed enabled
            // from autoRun; on edit we leave the existing enabled state alone so saving edits never
            // silently starts or stops a running workflow.
            if (isNew) { w.enabled = !!d.autoRun; }
            delete w.dryRun;
            w.pollIntervalMinutes = Math.min(1439, Math.max(1, parseInt(d.pollIntervalMinutes, 10) || 10));
            w.repo = String(d.repo || '').trim();
            w.baseBranch = String(d.baseBranch || '').trim();
            w.createPR = !!d.createPR;
            // Build JQL from the match mode + query labels (or a custom JQL).
            const mode = String(d.labelMatch || 'any');
            w.labelMatch = mode;
            const cu = 'assignee = currentUser()';
            let jql: string;
            if (mode === 'custom') {
                jql = String(d.jql || '').trim() || cu;
            } else if (!labels.length) {
                jql = cu;
            } else if (mode === 'all') {
                jql = `${cu} AND ` + labels.map(l => `labels = ${l}`).join(' AND ');
            } else if (mode === 'none') {
                jql = `${cu} AND labels not in (${labels.join(', ')})`;
            } else {
                jql = labels.length > 1 ? `${cu} AND labels in (${labels.join(', ')})` : `${cu} AND labels = ${labels[0]}`;
            }
            w.jql = jql;
            w.jiraBaseUrl = String(d.jiraBaseUrl || '').trim();
            w.projectKey = String(d.projectKey || '').trim();
            w.agentLabel = labels[0] || 'claude-fix';
            w.lockLabel = String(d.lockLabel || '').trim() || 'claude-in-progress';
            w.doneLabel = String(d.doneLabel || '').trim() || 'claude-done';
            w.blockLabel = String(d.blockLabel || '').trim() || 'claude-blocked';
            w.failLabel = String(d.failLabel || '').trim() || 'claude-failed';
            w.maxTicketsPerRun = Math.max(1, parseInt(d.maxTicketsPerRun, 10) || 2);
            let issueTypes = String(d.issueTypes || '').split(';').map((s: string) => s.trim()).filter(Boolean);
            // If the user did not specify any issue type, fill with ALL of the project's types.
            // On failure, DO NOT save with a silent default - ask the user to fill it in first.
            if (!issueTypes.length) {
                try {
                    issueTypes = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Jira Agent: loading project issue types...' },
                        () => agent.getJiraIssueTypes(w.jiraBaseUrl, w.projectKey)
                    );
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Jira Agent: could not load issue types for project "${w.projectKey}" (${e?.message ?? e}). Enter issue types manually (or fix the JIRA token / project key), then Save again. Workflow NOT saved.`);
                    return;
                }
                if (!issueTypes.length) {
                    vscode.window.showErrorMessage(`Jira Agent: no issue types returned for project "${w.projectKey}". Check the project key or enter issue types manually, then Save again. Workflow NOT saved.`);
                    return;
                }
            }
            w.rules = [{
                name: 'default',
                labels,
                issueTypes,
                handler: String(d.handler || '').trim() || 'implement-task',
                instructions: String(d.instructions || '')
            }];
            const savedFile = agent.writeWorkflow(w);
            this.file = savedFile;
            this.onSaved();
            // On create with autoRun ON, start it headless right away (register the background task if
            // missing, then kick one run) so the user does not have to click Start manually.
            if (isNew && w.enabled) {
                const reg = agent.ensurePollerTask();
                if (reg.ok) {
                    agent.runWorkflowNow(w.id);
                    vscode.window.showInformationMessage(`Jira Agent: "${name}" created and started headless - it will poll every ${w.pollIntervalMinutes} min. (${reg.message})`);
                } else {
                    vscode.window.showWarningMessage(`Jira Agent: "${name}" saved, but the headless poller could not start - ${reg.message}`);
                }
            } else {
                vscode.window.showInformationMessage(`Jira Agent: saved workflow "${name}".`);
            }
            this.render();
            return;
        }
        if (msg?.type === 'cancel') { this.panel.dispose(); }
    }

    private render(): void {
        const w = this.model();
        const rule = (Array.isArray(w.rules) && w.rules[0]) ? w.rules[0] : {};
        const labels = Array.isArray(rule.labels) ? rule.labels.join('; ') : (w.agentLabel || '');
        const issueTypes = Array.isArray(rule.issueTypes) ? rule.issueTypes.join('; ') : '';
        this.panel.title = this.file ? `Jira Agent: ${w.name || w.id}` : 'Jira Agent: New workflow';
        const n = nonce();
        const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;

        const isNew = !this.file;
        // Defaults are shown as PLACEHOLDERS on a new workflow (empty input); for editing, the
        // stored value is shown. Empty on save falls back to the default.
        const shown = (v: any) => isNew ? '' : (v ?? '');
        const hint = (k: string) => `<span class="hint" tabindex="0">!<span class="tip">${esc(HINTS[k])}</span></span>`;
        const text = (k: string, v: any, ph = '') => `<input id="${k}" type="text" value="${esc(v)}" placeholder="${esc(ph)}" />`;
        const num = (k: string, v: any, ph = '') => `<input id="${k}" type="number" min="1" value="${esc(v)}" placeholder="${esc(ph)}" />`;
        const check = (k: string, v: any) => `<label class="chk"><input id="${k}" type="checkbox" ${v ? 'checked' : ''}/> <span>${v ? 'ON' : 'OFF'}</span></label>`;

        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 18px; }
  h2 { margin: 0 0 12px; }
  .row { margin-bottom: 12px; }
  label.field { display: block; font-weight: 600; margin-bottom: 4px; }
  input[type=text], input[type=number], textarea {
    width: 100%; box-sizing: border-box; padding: 5px 7px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  }
  textarea { min-height: 60px; resize: vertical; }
  select {
    width: 100%; box-sizing: border-box; padding: 5px 7px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 3px;
  }
  .chk { font-weight: 400; }
  .hint {
    position: relative;
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; margin-left: 6px; border-radius: 50%;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 11px; font-weight: 700; cursor: help; user-select: none;
  }
  .hint .tip {
    visibility: hidden; opacity: 0; transition: opacity .1s;
    position: absolute; left: 20px; top: -4px; z-index: 10;
    width: max-content; max-width: 320px; white-space: normal;
    padding: 6px 9px; border-radius: 4px; font-size: 12px; font-weight: 400; line-height: 1.35;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
  }
  .hint:hover .tip, .hint:focus .tip { visibility: visible; opacity: 1; }
  .inline { display: flex; gap: 8px; }
  .inline input[type=text] { flex: 1; }
  button {
    padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .muted { opacity: .7; font-weight: 400; font-size: 12px; }
  .row.narrow input { max-width: 160px; }
  details.advanced { margin-top: 8px; border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,.25)); padding-top: 10px; }
  details.advanced summary { cursor: pointer; font-weight: 600; margin-bottom: 10px; }
</style></head>
<body>
<h2>${this.file ? 'Edit workflow' : 'New workflow'}</h2>

<div class="row"><label class="field">Name ${hint('name')}</label>${text('name', w.name)}</div>

<div class="row"><label class="field">Repo ${hint('repo')}</label>
  <div class="inline">${text('repo', w.repo, 'D:\\path\\to\\repo')}<button class="secondary" id="browse">Browse</button></div>
  <div class="inline" style="margin-top:6px">${text('cloneUrl', '', 'https://github.com/org/repo.git')}<button class="secondary" id="clone">Clone</button></div>
</div>

<div class="row"><label class="field">Query labels ${hint('agentLabels')}</label>
  <div class="inline">${text('agentLabels', shown(labels), 'claude-fix')}<button class="secondary" id="pickLabels">Pick</button></div>
</div>
<div class="row"><label class="field">Match mode ${hint('labelMatch')}</label>
  <select id="labelMatch">
    <option value="any"${(w.labelMatch || 'any') === 'any' ? ' selected' : ''}>Any of these labels (OR)</option>
    <option value="all"${w.labelMatch === 'all' ? ' selected' : ''}>All of these labels (AND)</option>
    <option value="none"${w.labelMatch === 'none' ? ' selected' : ''}>None of these labels (NEITHER)</option>
    <option value="custom"${w.labelMatch === 'custom' ? ' selected' : ''}>Custom JQL</option>
  </select>
  <div class="muted" id="matchHint"></div>
</div>
<div class="row" id="customJqlRow">
  <label class="field">Custom JQL ${hint('jql')}</label>
  ${text('jql', w.jql, 'assignee = currentUser() AND labels in (a, b)')}
  
  <div style="margin-top: 8px; padding: 10px; background: var(--vscode-welcomePage-tileBackground, rgba(128,128,128,0.15)); border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));">
    <div style="font-weight: 600; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; color: var(--vscode-descriptionForeground);">JQL Builder Helper</div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
      <div>
        <label style="display: block; font-size: 10px; font-weight: 600; margin-bottom: 3px;">Project Key</label>
        <input type="text" id="jqlProj" placeholder="e.g. ABC" style="font-size: 11px; padding: 4px 6px;" />
      </div>
      <div>
        <label style="display: block; font-size: 10px; font-weight: 600; margin-bottom: 3px;">Issue Type</label>
        <input type="text" id="jqlType" placeholder="e.g. Bug" style="font-size: 11px; padding: 4px 6px;" />
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
      <div>
        <label style="display: block; font-size: 10px; font-weight: 600; margin-bottom: 3px;">Assignee</label>
        <select id="jqlAssignee" style="font-size: 11px; padding: 4px 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 3px; width: 100%;">
          <option value="currentUser()">Current User</option>
          <option value="unassigned">Unassigned</option>
          <option value="any">Any</option>
        </select>
      </div>
      <div>
        <label style="display: block; font-size: 10px; font-weight: 600; margin-bottom: 3px;">Status</label>
        <input type="text" id="jqlStatus" placeholder="e.g. To Do" style="font-size: 11px; padding: 4px 6px;" />
      </div>
    </div>
    <button type="button" class="secondary" id="jqlBuildBtn" style="font-size: 11px; padding: 4px 8px; width: 100%;">Generate & Insert JQL</button>
  </div>
</div>

<div class="grid2">
  <div class="row"><label class="field">Auto run after add ${hint('autoRun')}</label>${check('autoRun', w.autoRun !== false)}</div>
  <div class="row narrow"><label class="field">Poll interval (min) ${hint('pollIntervalMinutes')}</label>${num('pollIntervalMinutes', shown(w.pollIntervalMinutes), '10')}</div>
</div>

<details class="advanced">
  <summary>Advanced <span class="muted">(defaults are fine for most workflows)</span></summary>
  <div class="grid2">
    <div class="row"><label class="field">Handler ${hint('handler')}</label>${text('handler', shown(rule.handler), 'implement-task')}</div>
    <div class="row"><label class="field">Max tickets / run ${hint('maxTicketsPerRun')}</label>${num('maxTicketsPerRun', shown(w.maxTicketsPerRun), '2')}</div>
  </div>
  <div class="grid2">
    <div class="row"><label class="field">Project key ${hint('projectKey')}</label>${text('projectKey', shown(w.projectKey), 'PR')}</div>
    <div class="row"><label class="field">Issue types ${hint('issueTypes')}</label>
      <div class="inline">${text('issueTypes', shown(issueTypes), 'empty = all project types')}<button class="secondary" id="pickTypes">Pick</button></div>
    </div>
  </div>
  <div class="grid2">
    <div class="row"><label class="field">Base branch ${hint('baseBranch')}</label>${text('baseBranch', shown(w.baseBranch), 'empty = auto-detect')}</div>
    <div class="row"><label class="field">Create PR ${hint('createPR')}</label>${check('createPR', w.createPR !== false)}</div>
  </div>
  <div class="row"><label class="field">Instructions ${hint('instructions')}</label><textarea id="instructions">${esc(rule.instructions || '')}</textarea></div>
  <div class="row"><label class="field">Jira base URL ${hint('jiraBaseUrl')}</label>${text('jiraBaseUrl', shown(w.jiraBaseUrl), 'https://your-org.atlassian.net')}</div>
  <div class="grid2">
    <div class="row"><label class="field">Lock label ${hint('lockLabel')}</label>${text('lockLabel', shown(w.lockLabel), 'claude-in-progress')}</div>
    <div class="row"><label class="field">Done label ${hint('doneLabel')}</label>${text('doneLabel', shown(w.doneLabel), 'claude-done')}</div>
    <div class="row"><label class="field">Block label ${hint('blockLabel')}</label>${text('blockLabel', shown(w.blockLabel), 'claude-blocked')}</div>
    <div class="row"><label class="field">Fail label ${hint('failLabel')}</label>${text('failLabel', shown(w.failLabel), 'claude-failed')}</div>
  </div>
</details>

<div class="actions">
  <button id="save">Save</button>
  <button class="secondary" id="cancel">Close</button>
</div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const val = id => document.getElementById(id).value;
  const chk = id => document.getElementById(id).checked;
  document.getElementById('browse').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
  document.getElementById('clone').addEventListener('click', () => vscode.postMessage({ type: 'clone', url: val('cloneUrl') }));
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', data: {
    name: val('name'), autoRun: chk('autoRun'),
    labelMatch: val('labelMatch'), jql: val('jql'),
    pollIntervalMinutes: val('pollIntervalMinutes'), maxTicketsPerRun: val('maxTicketsPerRun'),
    repo: val('repo'), agentLabels: val('agentLabels'), issueTypes: val('issueTypes'),
    handler: val('handler'), instructions: val('instructions'),
    jiraBaseUrl: val('jiraBaseUrl'), projectKey: val('projectKey'),
    baseBranch: val('baseBranch'), createPR: chk('createPR'),
    lockLabel: val('lockLabel'), doneLabel: val('doneLabel'),
    blockLabel: val('blockLabel'), failLabel: val('failLabel')
  }}));
  
  document.getElementById('jqlBuildBtn').addEventListener('click', () => {
    const proj = val('jqlProj').trim();
    const type = val('jqlType').trim();
    const assignee = val('jqlAssignee');
    const status = val('jqlStatus').trim();
    
    let parts = [];
    if (assignee === 'currentUser()') {
      parts.push('assignee = currentUser()');
    } else if (assignee === 'unassigned') {
      parts.push('assignee is EMPTY');
    }
    
    if (proj) {
      parts.push('project = "' + proj + '"');
    }
    if (type) {
      if (type.includes(';')) {
        const types = type.split(';').map(t => '"' + t.trim() + '"').filter(Boolean).join(', ');
        parts.push('issuetype in (' + types + ')');
      } else {
        parts.push('issuetype = "' + type + '"');
      }
    }
    if (status) {
      if (status.includes(';')) {
        const statuses = status.split(';').map(s => '"' + s.trim() + '"').filter(Boolean).join(', ');
        parts.push('status in (' + statuses + ')');
      } else {
        parts.push('status = "' + status + '"');
      }
    }
    
    const generatedJql = parts.join(' AND ');
    if (generatedJql) {
      document.getElementById('jql').value = generatedJql;
      buildPreview();
    }
  });

  function buildPreview() {
    const mode = val('labelMatch');
    const labels = val('agentLabels').split(';').map(s => s.trim()).filter(Boolean);
    const row = document.getElementById('customJqlRow');
    const hint = document.getElementById('matchHint');
    row.style.display = (mode === 'custom') ? 'block' : 'none';
    if (mode === 'custom') { hint.textContent = 'Using your custom JQL below.'; return; }
    const cu = 'assignee = currentUser()';
    let q = cu;
    if (labels.length) {
      if (mode === 'all') { q = cu + ' AND ' + labels.map(l => 'labels = ' + l).join(' AND '); }
      else if (mode === 'none') { q = cu + ' AND labels not in (' + labels.join(', ') + ')'; }
      else { q = labels.length > 1 ? cu + ' AND labels in (' + labels.join(', ') + ')' : cu + ' AND labels = ' + labels[0]; }
    }
    hint.textContent = 'Query: ' + q;
  }
  document.getElementById('labelMatch').addEventListener('change', buildPreview);
  document.getElementById('agentLabels').addEventListener('input', buildPreview);
  buildPreview();
  document.getElementById('pickLabels').addEventListener('click', () => vscode.postMessage({ type: 'pickLabels', base: val('jiraBaseUrl'), current: val('agentLabels') }));
  document.getElementById('pickTypes').addEventListener('click', () => vscode.postMessage({ type: 'pickIssueTypes', base: val('jiraBaseUrl'), projectKey: val('projectKey'), current: val('issueTypes') }));
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'setRepo') { document.getElementById('repo').value = m.path; }
    if (m.type === 'setLabels') { document.getElementById('agentLabels').value = m.value; buildPreview(); }
    if (m.type === 'setIssueTypes') { document.getElementById('issueTypes').value = m.value; }
  });
</script>
</body></html>`;
    }

    private dispose(): void {
        WorkflowEditor.current = undefined;
        this.disposables.forEach(d => { try { d.dispose(); } catch { /* ignore */ } });
    }
}
