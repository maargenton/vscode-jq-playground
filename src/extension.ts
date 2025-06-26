import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

enum PreviewType {
    Placeholder = 'placeholder',
    Result = 'result',
    Error = 'error',
}

export function activate(context: vscode.ExtensionContext) {
    const previewSessions = new Map<string, JqPreviewSession>();
    context.subscriptions.push(vscode.commands.registerCommand('jqPlayground.openPreview', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !activeEditor.document.fileName.endsWith('.jq')) {
            vscode.window.showErrorMessage('Please open a .jq file to use the preview');
            return;
        }
        const docUri = activeEditor.document.uri.toString();
        let session = previewSessions.get(docUri);
        if (session) {
            session.updateWebview();
            // @ts-ignore: Accessing private for reveal
            (session as any)["panel"].reveal(vscode.ViewColumn.Beside, true);
        } else {
            let inputFile = await pickInputFile();
            if (!inputFile) return;
            let options = updateROption(inputFile, []);
            const panel = vscode.window.createWebviewPanel('jqPreview', `Preview ${path.basename(activeEditor.document.fileName)}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
            session = new JqPreviewSession(context, docUri, panel, activeEditor, inputFile, options, () => previewSessions.delete(docUri));
            previewSessions.set(docUri, session);
            await session.updateWebview();
        }
        await vscode.window.showTextDocument(activeEditor.document, activeEditor.viewColumn);
    }));
}

export function deactivate() { }

class JqPreviewSession {
    private disposables: vscode.Disposable[] = [];
    private needUpdate = false;
    private updating = false;
    private previewState: { content: string, type: PreviewType } = { content: 'Loading...', type: PreviewType.Placeholder };
    private lastLoadingState = false;
    private loadingIndicatorTimeout: NodeJS.Timeout | undefined;
    private jsonWatcher?: vscode.FileSystemWatcher;
    private jsonChangeDisposable?: vscode.Disposable;
    private queryChangeDisposable?: vscode.Disposable;

    constructor(
        private context: vscode.ExtensionContext,
        public docUri: string,
        public panel: vscode.WebviewPanel,
        public activeEditor: vscode.TextEditor,
        public inputFile: string,
        public options: string[],
        public onDispose: () => void
    ) {
        this.setupWatchers();
        this.setupPanelHandlers();
    }

    private setupWatchers() {
        if (this.inputFile) {
            this.jsonWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(this.inputFile), path.basename(this.inputFile)));
            this.jsonWatcher.onDidChange(() => this.requestUpdate());
            this.jsonWatcher.onDidDelete(() => {
                if (this.panel)
                    this.panel.webview.html = '<p style="color: orange;">Input file was deleted.</p>';
            });
            this.jsonChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.fileName === this.inputFile && this.panel)
                    this.requestUpdate();
            });
            this.queryChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
                if (event.document === this.activeEditor.document) {
                    this.requestUpdate();
                }
            });
            this.disposables.push(this.jsonWatcher, this.jsonChangeDisposable, this.queryChangeDisposable);
        }
    }

    private requestUpdate() {
        this.needUpdate = true;
        this.updateLoadingIndicatorState();
        if (!this.updating) {
            this.runUpdate();
        }
    }

    private async runUpdate() {
        this.updating = true;
        this.needUpdate = false;
        this.updateLoadingIndicatorState();
        try {
            if (this.panel) {
                let output = '';
                let isError = false;
                try {
                    const fileName = path.basename(this.inputFile);
                    let jsonContent: string | undefined = undefined;
                    const openDoc = vscode.workspace.textDocuments.find(doc => doc.fileName === this.inputFile);
                    if (openDoc) {
                        jsonContent = openDoc.getText();
                    } else {
                        jsonContent = fs.readFileSync(this.inputFile, 'utf8');
                    }
                    output = await this.executeJq(jsonContent);
                    isError = false;
                } catch (error: any) {
                    output = error instanceof Error ? error.message : String(error);
                    isError = true;
                }
                this.previewState = {
                    content: output,
                    type: isError ? PreviewType.Error : PreviewType.Result
                };
                this.setWebviewContent();
            }
        } finally {
            this.updating = false;
            if (this.needUpdate) {
                this.runUpdate();
            } else {
                this.updateLoadingIndicatorState();
            }
        }
    }

    private updateLoadingIndicatorState() {
        const loading = this.needUpdate || this.updating;
        if (!loading) {
            if (this.loadingIndicatorTimeout) {
                clearTimeout(this.loadingIndicatorTimeout);
                this.loadingIndicatorTimeout = undefined;
            }
            this.setLoadingIndicator(false);
            this.lastLoadingState = false;
        } else {
            if (this.lastLoadingState) {
                this.setLoadingIndicator(true);
            } else if (!this.loadingIndicatorTimeout) {
                this.loadingIndicatorTimeout = setTimeout(() => {
                    if (this.needUpdate || this.updating) {
                        this.setLoadingIndicator(true);
                        this.lastLoadingState = true;
                    }
                    this.loadingIndicatorTimeout = undefined;
                }, 100);
            }
        }
    }

    private setLoadingIndicator(on: boolean) {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'setLoading', loading: on });
        }
    }

    private setupPanelHandlers() {
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'setOptions') {
                this.options = msg.options;
                this.updateWebview();
            } else if (msg.type === 'chooseInput') {
                const newInput = await pickInputFile();
                if (newInput) {
                    this.inputFile = newInput;
                    this.options = updateROption(newInput, this.options);
                    this.updateWebview();
                }
            } else if (msg.type === 'openResultDoc') {
                const isRaw = this.options.includes('-r');
                const doc = await vscode.workspace.openTextDocument({
                    content: msg.content,
                    language: isRaw ? undefined : 'json'
                });

                // Open in the column to the left if any
                let targetColumn = vscode.ViewColumn.Active;
                if (this.panel.viewColumn && this.panel.viewColumn > 1) {
                    targetColumn = this.panel.viewColumn - 1;
                }
                vscode.window.showTextDocument(doc, targetColumn);
            }
        });
        this.panel.onDidDispose(() => {
            this.dispose();
            this.onDispose();
        });
    }

    public updateWebview() {
        this.setWebviewContent();
        this.requestUpdate();
    }

    private setWebviewContent() {
        if (this.panel) {
            this.panel.webview.html = this.getWebviewContent();
            this.updateLoadingIndicatorState();
        }
    }

    private getWebviewContent() {
        if (!this.inputFile) {
            return '<p style="color: orange;">No input file selected.</p>';
        }
        const inputUri = vscode.Uri.file(this.inputFile);
        const { name, description } = filenameDisplay(inputUri);
        let inputFileDisplay = `<span class="jq-input-name">${escapeHtml(name)}</span><span class="jq-input-desc"> ${escapeHtml(description)}</span>`;
        const optionsHtml = renderOptionSelection(this.options);
        const isRaw = this.options.includes('-r');
        let highlightedContent = '';
        if (!isRaw && this.previewState.type === PreviewType.Result) {
            highlightedContent = `<pre class="jq-json-output">${highlightJson(this.previewState.content)}</pre>`;
        } else {
            highlightedContent = `<pre>${escapeHtml(this.previewState.content)}</pre>`;
        }

        let copyIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24"
                preserveAspectRatio="xMidYMid meet" fill="currentColor">
                <path d="M0 0h24v24H0V0z" fill="none" />
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
            </svg>
        `;
        let openIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24"
                preserveAspectRatio="xMidYMid meet" fill="currentColor">
                <path d="M0 0h24v24H0V0z" fill="none" />
                <path d="M13 11h-2v3H8v2h3v3h2v-3h3v-2h-3zm1-9H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
            </svg>
        `;

        let previewContent = `
            <div class="json-file">
                <div class="json-file-header">
                    <div class="jq-input-row"><span class="info-label">Input File:</span><span class="jq-input-file">${inputFileDisplay}</span><button class="jq-input-choose" id="jq-input-choose" title="Change input file">&#8230;</button></div>
                    ${optionsHtml}
                </div>
                <div class="json-content">
                    ${(this.previewState.type === PreviewType.Result) ? `
                    <div class="jq-result-actions" id="jq-result-actions">
                        <button class="jq-action-btn" id="jq-copy-btn" title="Copy to clipboard" aria-label="Copy">${copyIcon}</button>
                        <button class="jq-action-btn" id="jq-open-btn" title="Open in new document" aria-label="Open">${openIcon}</button>
                    </div>
                    ` : ''}
                    <div class="${this.previewState.type} jq-result-pane" id="jq-result-pane">
                        ${highlightedContent}
                    </div>
                </div>
            </div>
        `;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>jq Preview</title>
            <style>
                body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
                .jq-activity-indicator {
                    display: none; position: fixed; left: 0; right: 0; top: 0; height: 2px; z-index: 1000;
                    background: transparent; overflow: hidden; opacity: 0; transition: opacity 0.2s;
                }
                .jq-activity-indicator.active { display: block; opacity: 1; }
                .jq-activity-bar-track {
                    position: absolute; left: 0; top: 0; height: 100%; width: calc(100% + 160px);
                    will-change: transform; display: flex;
                }
                .jq-activity-bar {
                    position: absolute; top: 0; width: 160px; height: 100%;
                    background: linear-gradient(90deg, transparent 0%, #7195EA 70%, transparent 100%);
                }
                .jq-activity-bar:first-child { left: 0; }
                .jq-activity-bar:last-child { left: calc(100% - 160px); }
                @keyframes jq-activity-bar-move {
                    0% { transform: translateX(calc(160px - 100%)); }
                    100% { transform: translateX(0%); }
                }
                .jq-activity-indicator.active .jq-activity-bar-track {
                    animation: jq-activity-bar-move 1.2s linear infinite;
                }
                .info-label { font-weight: 500; margin-right: 0.5em; white-space: nowrap; }
                .jq-input-row { display: flex; align-items: center; margin-bottom: 2px; }
                .jq-input-file { margin-right: 0.5em; }
                .jq-input-name { font-size: 1em; }
                .jq-input-desc { font-size: 0.9em; opacity: 0.7; margin-left: 0.3em; }
                .jq-input-choose { background: none; border: none; color: var(--vscode-button-foreground); font-size: 1em; cursor: pointer; margin-left: 0.2em; padding: 0 4px; border-radius: 3px; }
                .jq-input-choose:hover { background: var(--vscode-button-hoverBackground); }
                .jq-options-block { margin-top: 4px; }
                .jq-options-row-flex { display: flex; align-items: flex-start; }
                .jq-options-label { font-weight: 500; margin-right: 0.5em; white-space: nowrap; }
                .jq-chips-row-flex { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; flex: 1 1 0%; min-width: 0; }
                .jq-chip { display: inline-flex; align-items: center; background: var(--vscode-button-secondaryBackground, #2a2d2e); color: var(--vscode-button-secondaryForeground, #fff); border-radius: 16px; padding: 2px 10px; font-size: 90%; margin-right: 2px; margin-bottom: 2px; }
                .jq-chip-x { margin-left: 6px; cursor: pointer; font-weight: bold; color: var(--vscode-button-secondaryForeground, #fff); }
                .jq-chip-x:hover { color: var(--vscode-errorForeground); }
                .jq-dropdown-btn { background: none; border: none; color: var(--vscode-foreground); font-size: 1em; margin-left: 4px; cursor: pointer; }
                .jq-dropdown-list { position: absolute; z-index: 10; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin-top: 2px; min-width: 220px; }
                .jq-dropdown-item { padding: 6px 12px; cursor: pointer; }
                .jq-dropdown-item.selected, .jq-dropdown-item:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
                .json-file { margin-bottom: 24px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
                .json-file-header { background-color: var(--vscode-editorGroupHeader-tabsBackground); padding: 8px 12px; font-weight: normal; border-bottom: 1px solid var(--vscode-panel-border); }
                .json-content { padding: 12px; position: relative; }
                .error { color: var(--vscode-errorForeground); background-color: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px; border-radius: 4px; margin: 8px 0; }
                .placeholder { color: var(--vscode-descriptionForeground); background: none; border: none; padding: 8px; border-radius: 4px; margin: 8px 0; font-style: italic; }
                .result { border: 1px solid var(--vscode-input-border); border-radius: 4px; overflow-x: auto; }
                pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; }
                .jq-json-output { background: none; color: #d4d4d4; }
                .hljs-attr { color: #593CE2; }
                .hljs-string { color: #66C147; }
                .hljs-number { }
                .hljs-null { opacity: 0.6; font-style: italic; }
                .hljs-boolean { color: #46B4B2; font-style: italic; }
                .jq-result-actions { opacity: 0; transition: opacity 0.2s; position: absolute; top: 12px; right: 12px; z-index: 2; gap: 0; background: var(--vscode-editorWidget-background, #23272e); border: 1px solid var(--vscode-input-border); border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: flex; flex-direction: row; }
                .jq-result-actions.visible { opacity: 0.3; }
                .jq-result-actions.opaque { opacity: 1; }
                .jq-action-btn { background: none; height: 32px; color: var(--vscode-foreground); border: none; border-radius: 0; padding: 6px; margin: 0; cursor: pointer; font-size: 1em; transition: background 0.2s, opacity 0.2s; outline: none; display: flex; align-items: center; }
                .jq-action-btn:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
                .jq-action-btn:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
                .jq-action-btn:hover, .jq-action-btn:focus { background: var(--vscode-button-hoverBackground); opacity: 1; }
                .jq-result-pane { position: relative; }
                .jq-copied-tooltip { position: absolute; top: -28px; left: 50%; transform: translateX(-50%); background: var(--vscode-editorInfo-foreground, #4caf50); color: #fff; padding: 2px 10px; border-radius: 6px; font-size: 0.95em; pointer-events: none; opacity: 0.95; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.10); white-space: nowrap; }
            </style>
        </head>
        <body>
            <div class="jq-activity-indicator" id="jq-activity-indicator">
                <div class="jq-activity-bar-track">
                    <div class="jq-activity-bar"></div>
                    <div class="jq-activity-bar"></div>
                </div>
            </div>
            ${previewContent}
            <script>
            const vscode = window.acquireVsCodeApi();
            document.getElementById('jq-input-choose').addEventListener('click', () => {
                vscode.postMessage({ type: 'chooseInput' });
            });

            // Show/hide result action buttons on hover using opacity changes
            const resultPane = document.getElementById('jq-result-pane');
            const actions = document.getElementById('jq-result-actions');
            if (actions) {
                resultPane.addEventListener('mouseenter', () => { actions.classList.add('visible'); });
                resultPane.addEventListener('mouseleave', () => {
                    actions.classList.remove('visible');
                    actions.classList.remove('opaque');
                });
                actions.addEventListener('mouseenter', () => { actions.classList.add('opaque'); });
                actions.addEventListener('mouseleave', () => { actions.classList.remove('opaque'); });

                // Use event delegation for action buttons
                actions.addEventListener('click', (event) => {
                    const target = event.target.closest('button');
                    if (!target) return;
                    event.preventDefault(); // Prevent default button behavior
                    target.blur(); // Remove focus from button after click

                    const text = resultPane.innerText;
                    if (target.id === 'jq-copy-btn') {
                        navigator.clipboard.writeText(text).then(() => {
                            let tooltip = document.createElement('span');
                            tooltip.className = 'jq-copied-tooltip';
                            tooltip.textContent = 'Copied!';
                            target.appendChild(tooltip);
                            setTimeout(() => {
                                if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
                            }, 900);
                        });
                    } else if (target.id === 'jq-open-btn') {
                        vscode.postMessage({ type: 'openResultDoc', content: text });
                    }
                });
            }

            // Handle dropdown for options
            const dropdownBtn = document.getElementById('jq-dropdown-btn');
            const dropdownList = document.getElementById('jq-dropdown-list');
            dropdownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdownList.style.display = dropdownList.style.display === 'none' ? 'block' : 'none';
            });
            document.body.addEventListener('click', () => {
                dropdownList.style.display = 'none';
            });
            dropdownList.addEventListener('click', (e) => { e.stopPropagation(); });
            Array.from(dropdownList.getElementsByClassName('jq-dropdown-item')).forEach(item => {
                item.addEventListener('click', () => {
                    const value = item.getAttribute('data-value');
                    let selected = Array.from(dropdownList.getElementsByClassName('jq-dropdown-item'))
                        .filter(i => i.classList.contains('selected'))
                        .map(i => i.getAttribute('data-value'));
                    if (item.classList.contains('selected')) {
                        selected = selected.filter(v => v !== value);
                    } else {
                        selected.push(value);
                    }
                    vscode.postMessage({ type: 'setOptions', options: selected });
                    dropdownList.style.display = 'none';
                });
            });
            Array.from(document.getElementsByClassName('jq-chip-x')).forEach(x => {
                x.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const value = x.getAttribute('data-value');
                    let selected = Array.from(dropdownList.getElementsByClassName('jq-dropdown-item'))
                        .filter(i => i.classList.contains('selected') && i.getAttribute('data-value') !== value)
                        .map(i => i.getAttribute('data-value'));
                    vscode.postMessage({ type: 'setOptions', options: selected });
                    dropdownList.style.display = 'none';
                });
            });

            // Handle loading indicator
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg && msg.type === 'setLoading') {
                    const indicator = document.getElementById('jq-activity-indicator');
                    if (indicator) {
                        if (msg.loading) {
                            indicator.classList.add('active');
                        } else {
                            indicator.classList.remove('active');
                        }
                    }
                }
            });
            </script>
        </body>
        </html>`;
    }

    private async executeJq(jsonContent: string): Promise<string> {
        // Artificial delay for testing
        // if (Math.random() < 0.99) {
        //     await new Promise(res => setTimeout(res, 2000));
        // }

        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `jq-playground-${crypto.randomBytes(8).toString('hex')}.json`);
        const tmpFilter = path.join(tmpDir, `jq-playground-filter-${crypto.randomBytes(8).toString('hex')}.jq`);
        try {
            fs.writeFileSync(tmpFile, jsonContent, 'utf8');
            fs.writeFileSync(tmpFilter, this.activeEditor.document.getText(), 'utf8');
            const opts = this.options.join(' ');
            const { stdout } = await execAsync(`jq ${opts} -f '${tmpFilter}' '${tmpFile}' 2>&1`);
            return stdout.trim();
        } catch (error: any) {
            let errMsg = error.stdout || error.stderr || error.message || String(error);
            let jsonDisplay = getWorkspaceRelativePath(this.inputFile);
            let filterDisplay = getWorkspaceRelativePath(this.activeEditor.document.fileName);
            if (jsonDisplay) {
                errMsg = errMsg.replaceAll(tmpFile, jsonDisplay);
            }
            if (filterDisplay) {
                errMsg = errMsg.replaceAll(tmpFilter, filterDisplay);
            }
            if (errMsg.includes('command not found')) {
                errMsg = 'jq command not found. Please install jq on your system: https://jqlang.org/download/';
            }
            throw new Error(errMsg);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { }
            try { fs.unlinkSync(tmpFilter); } catch { }
        }
    }

    public dispose() {
        this.disposables.forEach(d => d && d.dispose());
        this.disposables = [];
    }
}

function filenameDisplay(uri: vscode.Uri): { name: string, description: string } {
    const name = path.basename(uri.fsPath);
    const wsFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
    const wsFolder = wsFolders.find(ws => uri.fsPath.startsWith(ws + path.sep));
    let description = '';
    if (wsFolder) {
        const rel = path.relative(wsFolder, uri.fsPath);
        const dir = path.dirname(rel);
        description = dir === '.' ? '' : dir;
    } else {
        description = path.dirname(uri.fsPath);
    }
    return { name, description };
}

async function pickInputFile(): Promise<string | undefined> {
    const openDocs = vscode.workspace.textDocuments
        .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file')
        .map(doc => doc.uri);
    const workspaceFiles =
        await vscode.workspace.findFiles('**/*', '**/node_modules/**', 1000);
    const allUris = [...openDocs, ...workspaceFiles].filter((uri, idx, arr) =>
        arr.findIndex(u => u.fsPath === uri.fsPath) === idx
    );

    const items = allUris.map(uri => {
        const { name, description } = filenameDisplay(uri);
        return {
            label: name,
            description,
            uri
        };
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a file to use as input for this jq filter',
        matchOnDescription: true
    });
    return picked?.uri.fsPath;
}

function renderOptionSelection(options: string[]): string {
    const allOptions = [
        { value: '-c', label: '-c (Compact output)' },
        { value: '-n', label: '-n (Null input)' },
        { value: '-R', label: '-R (Raw input)' },
        { value: '-r', label: '-r (Raw output)' },
        { value: '-s', label: '-s (Slurp: read into array)' },
        { value: '-S', label: '-S (Sort keys)' },
    ];
    const selectedOptions = allOptions.filter(opt => options.includes(opt.value));
    const chipsHtml = selectedOptions.length
        ? selectedOptions.map(opt => `<span class="jq-chip" data-value="${opt.value}">${opt.label}<span class="jq-chip-x" data-value="${opt.value}">&times;</span></span>`).join(' ')
        : '<span style="opacity:0.6;">(none)</span>';
    return `
            <div class="jq-options-block">
                <div class="jq-options-row-flex">
                    <span class="jq-options-label">Filter Options:</span>
                    <span class="jq-chips-row-flex" id="jq-chips-row">${chipsHtml}<button id="jq-dropdown-btn" class="jq-dropdown-btn" title="Edit options">&#x25BC;</button></span>
                </div>
                <div id="jq-dropdown-list" class="jq-dropdown-list" style="display:none;">
                    ${allOptions.map(opt => `<div class="jq-dropdown-item${options.includes(opt.value) ? ' selected' : ''}" data-value="${opt.value}">${opt.label}</div>`).join('')}
                </div>
            </div>
        `;
}

function updateROption(inputFile: string, options: string[]): string[] {
    if (!inputFile.endsWith('.json')) {
        return Array.from(new Set([...options, '-R']));
    } else {
        return options.filter(opt => opt !== '-R');
    }
}

function escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

function getWorkspaceRelativePath(filePath: string): string {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders) {
        for (const ws of wsFolders) {
            const wsPath = ws.uri.fsPath;
            if (filePath.startsWith(wsPath)) {
                return path.relative(wsPath, filePath);
            }
        }
    }
    return filePath;
}


// Simpler regex-based JSON/jq fragment highlighter for jq output
function highlightJson(json: string): string {
    const stringRE = /"(?:\\.|[^"\\])*"/g;
    const numberRE = /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
    const booleanRE = /\b(?:true|false)\b/g;
    const nullRE = /\bnull\b/g;
    const keyRE = /("(?:\\.|[^"\\])*"\s*):/g;

    function highlightLine(line: string): string {
        line = line.replace(keyRE, (m, g1) => `<span class="hljs-attr">${escapeHtml(g1)}</span>:`);
        line = line.replace(stringRE, m =>
            /hljs-attr/.test(m) ? m : `<span class="hljs-string">${escapeHtml(m)}</span>`
        );
        line = line.replace(numberRE, m => `<span class="hljs-number">${m}</span>`);
        line = line.replace(booleanRE, m => `<span class="hljs-boolean">${m}</span>`);
        line = line.replace(nullRE, m => `<span class="hljs-null">${m}</span>`);
        return line;
    }
    return json.split(/\r?\n/).map(highlightLine).join('\n');
}
