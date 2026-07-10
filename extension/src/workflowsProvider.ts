import * as vscode from 'vscode';
import * as agent from './agent';

type Kind = 'empty' | 'workflow' | 'wf-enabled' | 'wf-interval' | 'wf-info' | 'wf-rule';

// Workflow-level status: tracks the HEADLESS BACKGROUND POLLER, not this VS Code window. The poller
// is a Windows scheduled task (agent.pollerTaskState) that ticks on an interval and runs
// poller-run.ps1; per-workflow scans are gated by pollIntervalMinutes and recorded in _meta.lastRun.
// So the status answers two questions the user cares about: is the headless process alive, and is it
// still polling this workflow on schedule. Ticket status (blocked/done/failed) lives in the Tickets
// view and is intentionally NOT surfaced here. States:
//   Error         - the poller crashed last tick (search/parse/dispatch crash; a blocked/failed
//                   ticket is normal operation and does NOT count)
//   Not scheduled - the scheduled task is not registered or is disabled -> nothing runs headless
//   Stopped       - the workflow is disabled (enabled === false): the poller skips it
//   Scanning      - a scan is in progress right now
//   Running       - enabled, task alive, and it polled within the expected interval window
//   Overdue       - enabled and task alive, but no tick within the window (just started, or stalled)
// Note: `enabled` is the live on/off state (Start/Stop). `autoRun` is only a create-time preference
// (auto-start on add) and is NOT used here. Workflow files predating `enabled` are treated as enabled.
function isPollingFresh(lastRun: string | undefined, intervalMin: number): boolean {
    if (!lastRun) { return false; }
    const t = Date.parse(lastRun);
    if (isNaN(t)) { return false; }
    // Allow two missed intervals plus a 90s grace before calling it overdue.
    const windowMs = Math.max(intervalMin, 1) * 60000 * 2 + 90000;
    return (Date.now() - t) < windowMs;
}
function statusOf(w: any, task: agent.PollerTaskState): { icon: string; color: string; text: string } {
    const rt = agent.workflowRuntime(w._id);
    const interval = Number(w.pollIntervalMinutes ?? 10);
    // Distinct icon+color per state so none read as the same at a glance:
    //   Error         red    error         - poller crashed
    //   Not scheduled orange circle-slash  - engine off entirely (task missing/disabled)
    //   Overdue       yellow clock         - engine on but a tick is late
    //   Stopped       grey   debug-pause   - workflow disabled (enabled === false)
    //   Scanning      blue   spinner       - scanning now
    //   Running       green  play-circle   - alive and polling on schedule
    if (rt.lastResult === 'error') { return { icon: 'error', color: 'charts.red', text: 'Error' }; }
    if (!task.registered || !task.enabled) { return { icon: 'circle-slash', color: 'charts.orange', text: 'Not scheduled' }; }
    if (w.enabled === false) { return { icon: 'debug-pause', color: 'disabledForeground', text: 'Stopped' }; }
    if (rt.running) { return { icon: 'loading~spin', color: 'charts.blue', text: 'Scanning' }; }
    if (isPollingFresh(rt.lastRun, interval)) { return { icon: 'play-circle', color: 'charts.green', text: 'Running' }; }
    return { icon: 'clock', color: 'charts.yellow', text: 'Overdue' };
}

export class WfItem extends vscode.TreeItem {
    constructor(
        label: string,
        public kind: Kind,
        public file = '',
        public wfId = '',
        collapsible = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsible);
        this.contextValue = kind;
    }
}

// One file per workflow (workflows/<id>.json). Root = workflows; expand a workflow to see and
// toggle its enabled / dry-run / interval and its rules.
export class WorkflowsProvider implements vscode.TreeDataProvider<WfItem> {
    private _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._emitter.event;

    refresh(): void { this._emitter.fire(); }
    getTreeItem(e: WfItem): vscode.TreeItem { return e; }

    getChildren(el?: WfItem): WfItem[] {
        if (!el) {
            const wfs = agent.listWorkflows();
            if (!wfs.length) {
                const empty = new WfItem('No workflows - click to create one', 'empty');
                empty.iconPath = new vscode.ThemeIcon('add');
                empty.command = { command: 'jiraAgent.createWorkflow', title: 'Create workflow' };
                return [empty];
            }
            const task = agent.pollerTaskState();
            return wfs.map(w => {
                const it = new WfItem(String(w.name || w._id), 'workflow', w._file, w._id, vscode.TreeItemCollapsibleState.Collapsed);
                // contextValue drives which inline action shows: Stop when the workflow is live
                // (enabled), Start when it is stopped. Based on the live `enabled` state, not autoRun
                // (a create-time preference) nor the transient _meta.running scan window.
                it.contextValue = (w.enabled === false) ? 'workflow-idle' : 'workflow-running';
                const rt = agent.workflowRuntime(w._id);
                const st = statusOf(w, task);
                it.iconPath = new vscode.ThemeIcon(st.icon, new vscode.ThemeColor(st.color));
                it.description = st.text;
                const engine = task.registered ? (task.enabled ? 'scheduled task alive' : 'scheduled task disabled') : 'scheduled task NOT registered';
                it.tooltip = `status: ${st.text}\nheadless poller: ${engine}\nlast poll: ${rt.lastRun || 'never'}\nnext tick: ${task.nextRun || '-'}\nlive: ${w.enabled === false ? 'stopped' : 'running'}\nauto-start on add: ${w.autoRun === false ? 'off' : 'on'}\nrepo: ${w.repo || '-'}\njql: ${w.jql || '-'}\ninterval: ${w.pollIntervalMinutes ?? 10} min`;
                return it;
            });
        }

        if (el.kind === 'workflow') {
            const w = agent.readWorkflow(el.file);
            if (!w) { return []; }
            const kids: WfItem[] = [];

            // autoRun is a create-time preference (auto-start on add), NOT the live on/off state -
            // that is controlled by Start/Stop on the workflow row. Labelled to avoid confusion.
            const auto = w.autoRun !== false;
            const en = new WfItem(`Auto-start on add: ${auto ? 'ON' : 'OFF'}`, 'wf-enabled', el.file, el.wfId);
            en.iconPath = new vscode.ThemeIcon(auto ? 'play-circle' : 'debug-pause');
            en.command = { command: 'jiraAgent.toggleWorkflowAutoRun', title: 'Toggle', arguments: [en] };
            kids.push(en);

            const iv = new WfItem(`Interval: ${w.pollIntervalMinutes ?? 10} min`, 'wf-interval', el.file, el.wfId);
            iv.iconPath = new vscode.ThemeIcon('clock');
            iv.command = { command: 'jiraAgent.setWorkflowInterval', title: 'Set interval', arguments: [iv] };
            kids.push(iv);

            const repo = new WfItem(`repo: ${w.repo || '(none)'}`, 'wf-info', el.file, el.wfId);
            repo.iconPath = new vscode.ThemeIcon('repo');
            kids.push(repo);

            const jql = new WfItem(`jql: ${w.jql || '(none)'}`, 'wf-info', el.file, el.wfId);
            jql.iconPath = new vscode.ThemeIcon('search');
            kids.push(jql);

            const rules: any[] = Array.isArray(w.rules) ? w.rules : [];
            for (const r of rules) {
                const it = new WfItem(`${r.name || '(rule)'} -> ${r.handler || '(no handler)'}`, 'wf-rule', el.file, el.wfId);
                const labels = Array.isArray(r.labels) ? r.labels.join(', ') : '';
                const types = Array.isArray(r.issueTypes) && r.issueTypes.length ? r.issueTypes.join(', ') : 'any';
                it.tooltip = `labels: ${labels || '-'}\nissueTypes: ${types}`;
                it.iconPath = new vscode.ThemeIcon('symbol-event');
                kids.push(it);
            }
            return kids;
        }

        return [];
    }
}
