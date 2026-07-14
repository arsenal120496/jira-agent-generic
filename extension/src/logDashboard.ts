import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as agent from './agent';

export class LogDashboard {
    private static currentPanel: LogDashboard | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private currentFilePath: string | undefined;
    private disposables: vscode.Disposable[] = [];
    private watcher: fs.FSWatcher | undefined;

    public static open(extensionUri: vscode.Uri, filePath?: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (LogDashboard.currentPanel) {
            if (filePath) {
                LogDashboard.currentPanel.loadLogFile(filePath);
            }
            LogDashboard.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'jiraAgentLogDashboard',
            'Jira Agent: Log Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        LogDashboard.currentPanel = new LogDashboard(panel, extensionUri, filePath);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, filePath?: string) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.currentFilePath = filePath || agent.newestRunLog();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'ready':
                        this.sendFilesList();
                        this.loadCurrentLog();
                        break;
                    case 'selectFile':
                        if (message.filePath) {
                            this.loadLogFile(message.filePath);
                        }
                        break;
                    case 'refresh':
                        this.loadCurrentLog();
                        break;
                }
            },
            null,
            this.disposables
        );

        this.panel.webview.html = this.getHtmlForWebview();
        this.setupWatcher();
    }

    private loadLogFile(filePath: string): void {
        this.currentFilePath = filePath;
        this.setupWatcher();
        this.loadCurrentLog();
        // Update files list in case a new file was created
        this.sendFilesList();
    }

    private setupWatcher(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }

        if (this.currentFilePath && fs.existsSync(this.currentFilePath)) {
            try {
                this.watcher = fs.watch(this.currentFilePath, (event) => {
                    if (event === 'change') {
                        this.loadCurrentLog();
                    }
                });
            } catch (e) {
                // Ignore watcher registration errors
            }
        }
    }

    private sendFilesList(): void {
        try {
            const files = agent.logFiles();
            const fileItems = files.map(f => ({
                name: path.basename(f),
                path: f,
                selected: f === this.currentFilePath
            })).reverse(); // Newest first

            this.panel.webview.postMessage({
                type: 'filesList',
                files: fileItems
            });
        } catch (e) {
            // Ignore
        }
    }

    private loadCurrentLog(): void {
        if (!this.currentFilePath || !fs.existsSync(this.currentFilePath)) {
            this.panel.webview.postMessage({
                type: 'logContent',
                lines: [],
                filePath: this.currentFilePath || '',
                fileName: this.currentFilePath ? path.basename(this.currentFilePath) : 'No log file selected'
            });
            return;
        }

        try {
            const content = fs.readFileSync(this.currentFilePath, 'utf8');
            const lines = content.split(/\r?\n/).filter(l => l.length > 0);
            this.panel.webview.postMessage({
                type: 'logContent',
                lines: lines,
                filePath: this.currentFilePath,
                fileName: path.basename(this.currentFilePath)
            });
        } catch (e: any) {
            this.panel.webview.postMessage({
                type: 'logContent',
                lines: [`[ERROR] Failed to read log file: ${e.message}`],
                filePath: this.currentFilePath,
                fileName: path.basename(this.currentFilePath)
            });
        }
    }

    private getHtmlForWebview(): string {
        const nonce = this.getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jira Agent Log Dashboard</title>
    <style>
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 15px;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
        }
        .header {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
            margin-bottom: 12px;
        }
        .title-area {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .title-area h2 {
            margin: 0;
            font-size: 1.3rem;
            font-weight: 600;
        }
        .controls {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
        }
        select, input[type="text"] {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 12px;
            outline: none;
        }
        select:focus, input[type="text"]:focus {
            border-color: var(--vscode-focusBorder);
        }
        .filter-group {
            display: flex;
            align-items: center;
            gap: 8px;
            background-color: var(--vscode-welcomePage-tileBackground, rgba(128,128,128,0.1));
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
        }
        .filter-checkbox {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
        }
        .filter-checkbox input {
            margin: 0;
            cursor: pointer;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .main-layout {
            display: flex;
            flex: 1;
            gap: 15px;
            min-height: 0;
        }
        .sidebar {
            width: 200px;
            border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
            padding-right: 15px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .sidebar h4 {
            margin: 0 0 5px 0;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        .workflow-list {
            list-style: none;
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
            overflow-y: auto;
            flex: 1;
        }
        .workflow-item {
            padding: 6px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: background-color 0.15s;
        }
        .workflow-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .workflow-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .log-viewport {
            flex: 1;
            background-color: var(--vscode-textBlockCode-background, rgba(0,0,0,0.15));
            border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
            border-radius: 4px;
            overflow-y: auto;
            padding: 12px;
            font-family: var(--vscode-editor-font-family, "Courier New", Courier, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: 1.5;
            white-space: pre-wrap;
            min-height: 0;
            position: relative;
        }
        .log-line {
            display: block;
            margin: 0;
            padding: 2px 4px;
            border-radius: 2px;
            border-left: 3px solid transparent;
        }
        .log-line:hover {
            background-color: rgba(255,255,255,0.03);
        }
        .log-timestamp {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
            margin-right: 8px;
            user-select: none;
        }
        .log-badge {
            display: inline-block;
            font-size: 10px;
            font-weight: bold;
            padding: 1px 5px;
            border-radius: 3px;
            margin-right: 6px;
            text-transform: uppercase;
            user-select: none;
        }
        .badge-info {
            background-color: var(--vscode-badge-background, #3a3d3f);
            color: var(--vscode-badge-foreground, #f0f0f0);
        }
        .badge-success {
            background-color: #1e4620;
            color: #b2ebb5;
        }
        .badge-warning {
            background-color: #534015;
            color: #fbe094;
        }
        .badge-error {
            background-color: #632323;
            color: #ffc4c4;
        }
        .badge-blocked {
            background-color: #5a2a0d;
            color: #ffd8be;
        }
        .log-line.level-success {
            border-left-color: #4caf50;
        }
        .log-line.level-warning {
            border-left-color: #ffeb3b;
        }
        .log-line.level-error {
            border-left-color: #f44336;
        }
        .log-line.level-blocked {
            border-left-color: #ff9800;
        }
        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .collapsible-header {
            cursor: pointer;
            padding: 4px;
            background-color: rgba(128,128,128,0.1);
            border-radius: 3px;
            margin: 4px 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: bold;
        }
        .collapsible-header::before {
            content: "▼ ";
            font-size: 9px;
            margin-right: 5px;
        }
        .collapsible-header.collapsed::before {
            content: "▶ ";
        }
        .collapsible-content {
            padding-left: 15px;
            border-left: 1px dashed rgba(128,128,128,0.3);
        }
        .collapsible-content.collapsed {
            display: none;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title-area">
            <h2 id="logTitle">Log Dashboard</h2>
        </div>
        <div class="controls">
            <select id="logFileSelect">
                <option value="">Loading logs...</option>
            </select>
            <input type="text" id="searchInput" placeholder="Filter logs...">
            <div class="filter-group">
                <label class="filter-checkbox">
                    <input type="checkbox" id="checkInfo" checked> Info
                </label>
                <label class="filter-checkbox">
                    <input type="checkbox" id="checkSuccess" checked> Success
                </label>
                <label class="filter-checkbox">
                    <input type="checkbox" id="checkWarning" checked> Warning
                </label>
                <label class="filter-checkbox">
                    <input type="checkbox" id="checkError" checked> Error
                </label>
            </div>
            <label class="filter-checkbox">
                <input type="checkbox" id="checkLiveTail" checked> Live Tail
            </label>
            <button id="refreshBtn" class="secondary">Refresh</button>
        </div>
    </div>

    <div class="main-layout">
        <div class="sidebar">
            <h4>Workflows</h4>
            <ul class="workflow-list" id="workflowList">
                <li class="workflow-item active" data-wf="all">All Workflows</li>
            </ul>
        </div>
        <div class="log-viewport" id="logViewport">
            <div class="empty-state">No logs loaded</div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const select = document.getElementById('logFileSelect');
        const viewport = document.getElementById('logViewport');
        const searchInput = document.getElementById('searchInput');
        const refreshBtn = document.getElementById('refreshBtn');
        const checkLiveTail = document.getElementById('checkLiveTail');
        const workflowList = document.getElementById('workflowList');

        const filters = {
            info: true,
            success: true,
            warning: true,
            error: true
        };

        let rawLogLines = [];
        let selectedWorkflow = 'all';
        let detectedWorkflows = new Set();

        // Signal ready to extension
        vscode.postMessage({ type: 'ready' });

        select.addEventListener('change', (e) => {
            const filePath = e.target.value;
            if (filePath) {
                vscode.postMessage({ type: 'selectFile', filePath });
            }
        });

        refreshBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        searchInput.addEventListener('input', () => {
            renderLogs();
        });

        ['checkInfo', 'checkSuccess', 'checkWarning', 'checkError'].forEach(id => {
            const level = id.replace('check', '').toLowerCase();
            document.getElementById(id).addEventListener('change', (e) => {
                filters[level] = e.target.checked;
                renderLogs();
            });
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'filesList':
                    updateFilesDropdown(message.files);
                    break;
                case 'logContent':
                    document.getElementById('logTitle').textContent = 'Log: ' + message.fileName;
                    rawLogLines = message.lines;
                    extractWorkflows();
                    renderLogs();
                    break;
            }
        });

        function updateFilesDropdown(files) {
            select.innerHTML = '';
            if (files.length === 0) {
                select.innerHTML = '<option value="">No log files found</option>';
                return;
            }
            files.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.path;
                opt.textContent = f.name;
                opt.selected = f.selected;
                select.appendChild(opt);
            });
        }

        function extractWorkflows() {
            detectedWorkflows.clear();
            rawLogLines.forEach(line => {
                const msg = line.replace(/^\\S+\\s+/, '');
                const m = msg.match(/^workflow\\s+(\\S+?):/);
                if (m) {
                    detectedWorkflows.add(m[1]);
                }
            });

            // Update sidebar UI
            const activeWf = selectedWorkflow;
            workflowList.innerHTML = '';
            
            const allItem = document.createElement('li');
            allItem.className = 'workflow-item' + (activeWf === 'all' ? ' active' : '');
            allItem.textContent = 'All Workflows';
            allItem.dataset.wf = 'all';
            allItem.addEventListener('click', () => selectWorkflow('all'));
            workflowList.appendChild(allItem);

            detectedWorkflows.forEach(wf => {
                const item = document.createElement('li');
                item.className = 'workflow-item' + (activeWf === wf ? ' active' : '');
                item.textContent = wf;
                item.dataset.wf = wf;
                item.addEventListener('click', () => selectWorkflow(wf));
                workflowList.appendChild(item);
            });
        }

        function selectWorkflow(wf) {
            selectedWorkflow = wf;
            document.querySelectorAll('.workflow-item').forEach(item => {
                if (item.dataset.wf === wf) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
            renderLogs();
        }

        function parseLine(line) {
            // Strip timestamp if present at beginning
            const timestampMatch = line.match(/^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z|\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})\\s+/);
            let timestamp = '';
            let content = line;

            if (timestampMatch) {
                timestamp = timestampMatch[1];
                content = line.substring(timestampMatch[0].length);
            }

            // Determine level and badges
            let level = 'info';
            let badgeText = 'INFO';

            if (/FAILED|failed|error/i.test(content)) {
                level = 'error';
                badgeText = 'ERROR';
            } else if (/BLOCKED|blocked/i.test(content)) {
                level = 'blocked';
                badgeText = 'BLOCKED';
            } else if (/DONE|success|done \\(/i.test(content)) {
                level = 'success';
                badgeText = 'SUCCESS';
            } else if (/warning/i.test(content)) {
                level = 'warning';
                badgeText = 'WARNING';
            }

            // Detect workflow context if possible
            let wfContext = null;
            const wfMatch = content.match(/^workflow\\s+(\\S+?):/);
            if (wfMatch) {
                wfContext = wfMatch[1];
            }

            return {
                timestamp,
                content,
                level,
                badgeText,
                wfContext
            };
        }

        function renderLogs() {
            viewport.innerHTML = '';
            if (rawLogLines.length === 0) {
                viewport.innerHTML = '<div class="empty-state">Log file is empty</div>';
                return;
            }

            const searchVal = searchInput.value.toLowerCase();
            let currentWfContext = '(general)';

            let renderCount = 0;
            let currentCollapsible = null;

            rawLogLines.forEach((line) => {
                const parsed = parseLine(line);
                
                // Track workflow context changes
                if (parsed.wfContext) {
                    currentWfContext = parsed.wfContext;
                } else if (/^tick complete\\.?$/.test(parsed.content.trim())) {
                    currentWfContext = '(general)';
                }

                // Filter by workflow
                if (selectedWorkflow !== 'all' && currentWfContext !== selectedWorkflow) {
                    return;
                }

                // Filter by level
                if (parsed.level === 'info' && !filters.info) return;
                if (parsed.level === 'success' && !filters.success) return;
                if (parsed.level === 'warning' && !filters.warning) return;
                if (parsed.level === 'error' && !filters.error) return;
                if (parsed.level === 'blocked' && !filters.warning) return; // Map blocked to warning filter

                // Filter by search
                if (searchVal && !line.toLowerCase().includes(searchVal)) {
                    return;
                }

                renderCount++;

                // Build DOM Elements
                const lineDiv = document.createElement('div');
                lineDiv.className = 'log-line level-' + parsed.level;

                if (parsed.timestamp) {
                    const tsSpan = document.createElement('span');
                    tsSpan.className = 'log-timestamp';
                    tsSpan.textContent = parsed.timestamp;
                    lineDiv.appendChild(tsSpan);
                }

                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'log-badge badge-' + parsed.level;
                badgeSpan.textContent = parsed.badgeText;
                lineDiv.appendChild(badgeSpan);

                const textNode = document.createTextNode(parsed.content);
                lineDiv.appendChild(textNode);

                // Command grouping/collapsing logic:
                // If line starts a shell command or script run, group it
                if (parsed.content.startsWith('Running command:') || parsed.content.includes('Executing prepublish')) {
                    const header = document.createElement('div');
                    header.className = 'collapsible-header';
                    header.textContent = parsed.content;
                    header.addEventListener('click', () => {
                        header.classList.toggle('collapsed');
                        contentDiv.classList.toggle('collapsed');
                    });

                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'collapsible-content';
                    
                    viewport.appendChild(header);
                    viewport.appendChild(contentDiv);
                    currentCollapsible = contentDiv;
                } else if (currentCollapsible && (parsed.content.startsWith('=== workflow') || parsed.content.startsWith('=== poller exited'))) {
                    // Close collapse group
                    currentCollapsible = null;
                    viewport.appendChild(lineDiv);
                } else if (currentCollapsible) {
                    currentCollapsible.appendChild(lineDiv);
                } else {
                    viewport.appendChild(lineDiv);
                }
            });

            if (renderCount === 0) {
                viewport.innerHTML = '<div class="empty-state">No matching log lines found</div>';
            }

            if (checkLiveTail.checked) {
                viewport.scrollTop = viewport.scrollHeight;
            }
        }
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private dispose(): void {
        LogDashboard.currentPanel = undefined;
        if (this.watcher) {
            this.watcher.close();
        }
        this.disposables.forEach(d => {
            try {
                d.dispose();
            } catch (e) {
                // Ignore
            }
        });
    }
}
