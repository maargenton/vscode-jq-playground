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
        let inputFileDisplay = getWorkspaceRelativePath(this.inputFile);
        const optionsHtml = renderOptionSelection(this.options);
        let previewContent = `
            <div class="json-file">
                <div class="json-file-header">${escapeHtml(path.basename(this.inputFile))}</div>
                <div class="json-content">
                    <div class="${this.previewState.type}">
                        <pre>${escapeHtml(this.previewState.content)}</pre>
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
                body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 16px; }
                .info-block { background: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); padding: 12px; margin-bottom: 16px; }
                .info-label { font-weight: 500; margin-right: 0.5em; }
                .jq-input-row { display: flex; align-items: center; margin-bottom: 2px; }
                .jq-input-file { margin-right: 0.5em; }
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
                .json-file-header { background-color: var(--vscode-editorGroupHeader-tabsBackground); padding: 8px 12px; font-weight: bold; border-bottom: 1px solid var(--vscode-panel-border); }
                .json-content { padding: 12px; }
                .error { color: var(--vscode-errorForeground); background-color: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px; border-radius: 4px; margin: 8px 0; }
                .placeholder { color: var(--vscode-descriptionForeground); background: none; border: none; padding: 8px; border-radius: 4px; margin: 8px 0; font-style: italic; }
                .result { background-color: var(--vscode-editor-background); border: 1px solid var(--vscode-input-border); padding: 12px; border-radius: 4px; overflow-x: auto; }
                pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; }
                .jq-activity-indicator { display: none; position: fixed; left: 0; right: 0; top: 0; height: 2px; z-index: 1000; }
                .jq-activity-indicator.active { display: block; }
                .jq-activity-bar { width: 100%; height: 100%; background: linear-gradient(90deg, #1565c0 0%, #42a5f5 30%, #b3e5fc 50%, #42a5f5 70%, #1565c0 100%); background-size: 200% 100%; animation: jq-activity-bounce 2s ease-in-out infinite alternate; }
                @keyframes jq-activity-bounce { 0% { background-position: 0% 0; } 100% { background-position: 100% 0; } }
            </style>
        </head>
        <body>
            <div class="jq-activity-indicator" id="jq-activity-indicator">
                <div class="jq-activity-bar"></div>
            </div>
            <div class="info-block">
                <div class="jq-input-row"><span class="info-label">Input File:</span><span class="jq-input-file">${escapeHtml(inputFileDisplay)}</span><button class="jq-input-choose" id="jq-input-choose" title="Change input file">&#8230;</button></div>
                ${optionsHtml}
            </div>
            ${previewContent}
            <script>
            document.getElementById('jq-input-choose').addEventListener('click', () => {
                window.acquireVsCodeApi().postMessage({ type: 'chooseInput' });
            });
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
                    window.acquireVsCodeApi().postMessage({ type: 'setOptions', options: selected });
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
                    window.acquireVsCodeApi().postMessage({ type: 'setOptions', options: selected });
                    dropdownList.style.display = 'none';
                });
            });
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
        // Artificial delay for testing: 20% chance
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

async function pickInputFile(): Promise<string | undefined> {
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
    if (files.length === 0) {
        vscode.window.showErrorMessage('No files found in workspace.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(files.map(f => ({ label: path.basename(f.fsPath), description: f.fsPath })), {
        placeHolder: 'Select a file to use as input for this jq filter',
    });
    return picked?.description;
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
                    <span class="jq-options-label">Filter&nbsp;Options:</span>
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

export function deactivate() { }
