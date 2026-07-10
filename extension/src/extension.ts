import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import * as agent from './agent';
import { WorkflowsProvider, WfItem } from './workflowsProvider';
import { TicketsProvider, TicketItem } from './ticketsProvider';
import { LogProvider } from './logProvider';
import { WorkflowEditor } from './editorPanel';

export function activate(context: vscode.ExtensionContext): void {
    // Marketplace installs ship the skills inside the VSIX; copy them to ~/.claude/skills on first
    // run (and after an update) so the poller works with no separate installer.
    const version = String(context.extension?.packageJSON?.version || '0.0.0');
    agent.bootstrapSkills(context.extensionPath, version);

    if (agent.ensureConfig()) {
        vscode.window.showInformationMessage(`Jira Agent: created default config at ${agent.configPath()}. Now create a workflow.`);
    }

    // Background poller processes started from this window, so Stop can kill them (no terminal window).
    const runningProcs = new Map<string, ChildProcess>();

    const workflows = new WorkflowsProvider();
    const tickets = new TicketsProvider();
    const logs = new LogProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('jiraAgentWorkflows', workflows),
        vscode.window.registerTreeDataProvider('jiraAgentTickets', tickets),
        vscode.window.registerTreeDataProvider('jiraAgentLog', logs)
    );

    const refreshAll = () => { workflows.refresh(); tickets.refresh(); logs.refresh(); };

    const saveWorkflow = (item: WfItem | undefined, mutate: (w: any) => void) => {
        if (!item?.file) { return; }
        const w = agent.readWorkflow(item.file);
        if (!w) { vscode.window.showWarningMessage('Jira Agent: workflow file could not be read.'); return; }
        mutate(w);
        agent.writeWorkflow(w);
        refreshAll();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('jiraAgent.refresh', refreshAll),
        vscode.commands.registerCommand('jiraAgent.runPollerNow', () => agent.runPollerNow()),
        vscode.commands.registerCommand('jiraAgent.openConfig', async () => {
            agent.ensureConfig();
            const doc = await vscode.workspace.openTextDocument(agent.configPath());
            await vscode.window.showTextDocument(doc);
        }),

        // ---- workflow lifecycle (visual form) ----
        vscode.commands.registerCommand('jiraAgent.createWorkflow', () => WorkflowEditor.open(context, undefined, refreshAll)),
        vscode.commands.registerCommand('jiraAgent.editWorkflow', (item: WfItem) => WorkflowEditor.open(context, item?.file, refreshAll)),
        vscode.commands.registerCommand('jiraAgent.toggleWorkflowAutoRun', (item: WfItem) => saveWorkflow(item, w => { w.autoRun = (w.autoRun === false); })),
        // Start = make this workflow run headless and poll every interval. Two things must be true:
        // (1) the background scheduled task exists (registered here on demand, once for all workflows),
        // (2) this workflow is enabled. We also kick one run now (hidden background process, output
        // streams to the Jira Agent channel) so the user sees immediate activity instead of waiting for
        // the first interval. (autoRun is only the create-time preference.)
        vscode.commands.registerCommand('jiraAgent.startWorkflow', (item: WfItem) => {
            if (!item?.wfId) { return; }
            const reg = agent.ensurePollerTask();
            if (!reg.ok) { vscode.window.showErrorMessage(`Jira Agent: cannot start headless poller - ${reg.message}`); return; }
            saveWorkflow(item, w => { w.enabled = true; });
            const rt = agent.workflowRuntime(item.wfId);
            if (rt.running) { vscode.window.showInformationMessage(`Jira Agent: "${item.label}" is already scanning.`); return; }
            const proc = agent.runWorkflowNow(item.wfId);
            if (proc) {
                runningProcs.set(item.wfId, proc);
                proc.on('close', () => { runningProcs.delete(item.wfId); refreshAll(); });
            }
            vscode.window.showInformationMessage(`Jira Agent: "${item.label}" is now running headless and will poll on its interval. (${reg.message})`);
            refreshAll();
        }),
        // Stop = disable this workflow (enabled = false) so the background poller skips it. Also tears
        // down any manual run this window started. The scheduled task keeps ticking for OTHER workflows.
        vscode.commands.registerCommand('jiraAgent.stopWorkflow', async (item: WfItem) => {
            if (!item?.wfId) { return; }
            const rt = agent.workflowRuntime(item.wfId);
            const proc = runningProcs.get(item.wfId);
            // Confirm before interrupting an in-progress ticket.
            const msg = (rt.running === 'working')
                ? `"${item.label}" is working on ${rt.activeTicket || 'a ticket'}. Stop now? It will be disabled; the in-progress ticket may finish in the background.`
                : `Stop "${item.label}"? It will be disabled and skipped by the background poller.`;
            const ok = await vscode.window.showWarningMessage(msg, { modal: true }, 'Stop');
            if (ok !== 'Stop') { return; }
            saveWorkflow(item, w => { w.enabled = false; });
            if (proc && proc.pid) {
                agent.killTree(proc.pid);
                runningProcs.delete(item.wfId);
            }
            agent.clearWorkflowRunning(item.wfId);
            refreshAll();
        }),
        vscode.commands.registerCommand('jiraAgent.setWorkflowInterval', async (item: WfItem) => {
            const w = item?.file ? agent.readWorkflow(item.file) : undefined;
            if (!w) { return; }
            const val = await vscode.window.showInputBox({ prompt: 'Poll interval (minutes, 1-1439)', value: String(w.pollIntervalMinutes ?? 10), validateInput: v => (/^\d+$/.test(v) && +v >= 1 && +v <= 1439) ? undefined : 'Enter 1-1439' });
            if (val === undefined) { return; }
            saveWorkflow(item, x => { x.pollIntervalMinutes = parseInt(val, 10); });
        }),
        vscode.commands.registerCommand('jiraAgent.openWorkflowFile', async (item: WfItem) => {
            if (!item?.file) { return; }
            const doc = await vscode.workspace.openTextDocument(item.file);
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('jiraAgent.deleteWorkflow', async (item: WfItem) => {
            if (!item?.file) { return; }
            const ok = await vscode.window.showWarningMessage(`Delete workflow "${item.label}"? This removes its file and state.`, { modal: true }, 'Delete');
            if (ok !== 'Delete') { return; }
            agent.deleteWorkflowFiles(item.wfId, item.file);
            refreshAll();
        }),

        // ---- tickets ----
        vscode.commands.registerCommand('jiraAgent.rerunTicket', (item: TicketItem) => { agent.clearTicketState(item?.key, item?.workflow); tickets.refresh(); }),
        vscode.commands.registerCommand('jiraAgent.openTicketLog', (item: TicketItem) => agent.openLatestLog(item?.key)),
        vscode.commands.registerCommand('jiraAgent.openTicketInJira', (item: TicketItem) => agent.openInJira(item?.key, item?.jiraBaseUrl)),

        // ---- log ----
        vscode.commands.registerCommand('jiraAgent.openLogFile', async (file?: string) => {
            const f = file || agent.newestRunLog();
            if (!f) { vscode.window.showInformationMessage('Jira Agent: no log yet.'); return; }
            const doc = await vscode.workspace.openTextDocument(f);
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('jiraAgent.openLogsFolder', () => vscode.env.openExternal(vscode.Uri.file(agent.logsDir())))
    );

    const watcher = agent.watch(refreshAll);
    if (watcher) { context.subscriptions.push(watcher); }

    // The file watcher only fires when the poller writes state/logs. If the headless poller dies it
    // stops writing, so nothing would flip a workflow to "Overdue". A periodic refresh re-evaluates
    // poll freshness and re-queries the scheduled task so a dead/disabled poller is surfaced.
    const heartbeat = setInterval(() => workflows.refresh(), 30000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(heartbeat)));
}

export function deactivate(): void { /* no-op */ }
