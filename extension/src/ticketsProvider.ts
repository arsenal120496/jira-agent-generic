import * as vscode from 'vscode';
import * as agent from './agent';

class GroupItem extends vscode.TreeItem {
    constructor(label: string, public group: string) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'group';
    }
}

export class TicketItem extends vscode.TreeItem {
    constructor(public key: string, public status: string, public workflow: string, public jiraBaseUrl: string) {
        super(key, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'ticket';
    }
}

const GROUPS: { id: string; title: string; statuses: string[]; icon: string }[] = [
    { id: 'running', title: 'Running', statuses: ['dispatched'], icon: 'sync' },
    { id: 'blocked', title: 'Blocked', statuses: ['blocked'], icon: 'error' },
    { id: 'failed', title: 'Failed', statuses: ['failed'], icon: 'warning' },
    { id: 'done', title: 'Done', statuses: ['done'], icon: 'check' }
];

interface Row { key: string; status: string; ts?: string; note?: string; workflow: string; jiraBaseUrl: string; }

// Aggregates ticket state across every workflow's <id>.state.json (plus the legacy state.json).
export class TicketsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._emitter.event;

    refresh(): void { this._emitter.fire(); }
    getTreeItem(e: vscode.TreeItem): vscode.TreeItem { return e; }

    private collect(): Row[] {
        const rows: Row[] = [];
        for (const w of agent.listWorkflows()) {
            const base = String(w.jiraBaseUrl || '');
            const s = agent.readWorkflowState(w._id);
            for (const key of Object.keys(s)) {
                if (key.startsWith('_')) { continue; }
                const v = s[key] || {};
                rows.push({ key, status: String(v.status ?? ''), ts: v.ts, note: v.note, workflow: String(w.name || w._id), jiraBaseUrl: base });
            }
        }
        const legacy = agent.readLegacyState();
        for (const key of Object.keys(legacy)) {
            const v = legacy[key] || {};
            rows.push({ key, status: String(v.status ?? ''), ts: v.ts, note: v.note, workflow: '(default)', jiraBaseUrl: '' });
        }
        return rows;
    }

    getChildren(el?: vscode.TreeItem): vscode.TreeItem[] {
        const rows = this.collect();

        if (!el) {
            return GROUPS.map(g => {
                const count = rows.filter(r => g.statuses.includes(r.status)).length;
                const gi = new GroupItem(`${g.title} (${count})`, g.id);
                gi.iconPath = new vscode.ThemeIcon(g.icon);
                return gi;
            });
        }

        if (el instanceof GroupItem) {
            const g = GROUPS.find(x => x.id === el.group);
            if (!g) { return []; }
            return rows
                .filter(r => g.statuses.includes(r.status))
                .map(r => {
                    const it = new TicketItem(r.key, r.status, r.workflow, r.jiraBaseUrl);
                    it.description = `${r.workflow}${r.ts ? ' - ' + new Date(r.ts).toLocaleString() : ''}`;
                    it.tooltip = r.note || '';
                    it.command = { command: 'jiraAgent.openTicketInJira', title: 'Open in Jira', arguments: [it] };
                    return it;
                });
        }

        return [];
    }
}
