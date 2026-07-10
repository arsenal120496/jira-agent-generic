import * as vscode from 'vscode';
import * as agent from './agent';

// Live view of the newest poller run log, GROUPED BY WORKFLOW. Top level = one node per workflow
// that appears in the log (plus a "General" bucket for tick-level lines); expand to see that
// workflow's recent lines, newest first. Auto-refreshes when the poller writes (see agent.watch).

type LogKind = 'group' | 'line' | 'info';

class LogItem extends vscode.TreeItem {
    constructor(label: string, public logKind: LogKind, public lines: string[] = []) {
        super(label, logKind === 'group' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    }
}

const GENERAL = '(general)';

// Attribute each log line to a workflow. Lines are timestamped: "<iso>  <message>". A
// "workflow <id>:" line sets the current workflow; subsequent dispatch/status lines inherit it.
// "tick complete." and anything before the first marker fall into the General bucket.
function groupByWorkflow(lines: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    const add = (wf: string, line: string) => {
        if (!groups.has(wf)) { groups.set(wf, []); }
        groups.get(wf)!.push(line);
    };
    let current = GENERAL;
    for (const raw of lines) {
        const msg = raw.replace(/^\S+\s+/, '');       // strip leading ISO timestamp
        const m = msg.match(/^workflow\s+(\S+?):/);
        if (m) { current = m[1]; add(current, raw); continue; }
        if (/^tick complete\.?$/.test(msg.trim())) { add(GENERAL, raw); continue; }
        add(current, raw);
    }
    return groups;
}

export class LogProvider implements vscode.TreeDataProvider<LogItem> {
    private _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._emitter.event;

    refresh(): void { this._emitter.fire(); }
    getTreeItem(e: LogItem): vscode.TreeItem { return e; }

    getChildren(el?: LogItem): LogItem[] {
        const file = agent.newestRunLog();
        if (!file) {
            const it = new LogItem('No logs yet - run the poller (Run Poller Now)', 'info');
            it.iconPath = new vscode.ThemeIcon('info');
            return [it];
        }

        // Child level: the lines of one workflow group, newest first.
        if (el && el.logKind === 'group') {
            return el.lines.slice().reverse().map(raw => {
                const it = new LogItem(raw, 'line');
                if (/\[FAILED\]|failed|error/i.test(raw)) { it.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')); }
                else if (/\[BLOCKED\]|blocked/i.test(raw)) { it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')); }
                else if (/\[DONE\]|dispatched|scanning|done \(/i.test(raw)) { it.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')); }
                else { it.iconPath = new vscode.ThemeIcon('circle-small'); }
                it.tooltip = raw;
                return it;
            });
        }

        // Top level: one node per workflow that appears in the log.
        const groups = groupByWorkflow(agent.tailLines(file, 400));
        const nameById = new Map<string, string>();
        for (const w of agent.listWorkflows()) { nameById.set(String(w._id), String(w.name || w._id)); }

        const items: LogItem[] = [];
        // Stable order: real workflows first (by name), General last.
        const keys = Array.from(groups.keys()).filter(k => k !== GENERAL).sort();
        for (const k of keys) {
            const lines = groups.get(k)!.slice(-80);
            const g = new LogItem(nameById.get(k) || k, 'group', lines);
            const last = lines[lines.length - 1] || '';
            g.description = /error|failed/i.test(last) ? 'error' : (/blocked/i.test(last) ? 'blocked' : `${lines.length} lines`);
            g.iconPath = new vscode.ThemeIcon('symbol-event');
            g.tooltip = `${file}\nworkflow: ${k}`;
            items.push(g);
        }
        if (groups.has(GENERAL)) {
            const lines = groups.get(GENERAL)!.slice(-40);
            const g = new LogItem('General (ticks)', 'group', lines);
            g.iconPath = new vscode.ThemeIcon('list-flat');
            g.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            items.push(g);
        }
        if (!items.length) {
            const it = new LogItem('Log is empty', 'info');
            it.iconPath = new vscode.ThemeIcon('info');
            return [it];
        }
        return items;
    }
}
