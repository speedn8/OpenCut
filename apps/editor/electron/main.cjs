"use strict";
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EditorNativeHost } = require("./host.cjs");
const { ORIGIN, startServer } = require("./server.cjs");
let editorWindow, nativeHost, server, waitingForSave, showingExitChoice, rendererError;
let quitting = false, shutdown;
app.setName("OpenCut Next");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: "app-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const trustedUrl = (value) => { try { return new URL(value).origin === ORIGIN; } catch { return false; } };
function trustedSender(event) {
  return Boolean(editorWindow && !editorWindow.isDestroyed() && event.sender === editorWindow.webContents && event.senderFrame && event.senderFrame === editorWindow.webContents.mainFrame && trustedUrl(event.senderFrame.url));
}
function profileDirectory() {
  const selected = process.env.OPENCUT_NEXT_DATA_DIR;
  if (selected && !path.isAbsolute(selected)) throw new Error("OPENCUT_NEXT_DATA_DIR must be an absolute path.");
  const directory = selected || path.join(app.getPath("appData"), "OpenCut Next");
  fs.mkdirSync(path.join(directory, "browser-session"), { recursive: true });
  app.setPath("userData", directory); app.setPath("sessionData", path.join(directory, "browser-session"));
  return directory;
}
function forgetExitRequest() { if (waitingForSave) clearTimeout(waitingForSave.timer); waitingForSave = undefined; }
function finishWindowClose() { forgetExitRequest(); if (editorWindow && !editorWindow.isDestroyed()) editorWindow.destroy(); }
async function showExitChoice(reason) {
  if (showingExitChoice || !editorWindow || editorWindow.isDestroyed()) return;
  showingExitChoice = true; forgetExitRequest();
  try {
    const choice = await dialog.showMessageBox(editorWindow, { type: "warning", title: "Save not confirmed", message: "Keep editing or discard unsaved changes and close?", detail: String(reason).slice(0, 2000), buttons: ["Keep Editing", "Discard and Close"], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response === 1) finishWindowClose();
  } catch {
    const choice = dialog.showMessageBoxSync({ type: "warning", message: "Saving was not confirmed. Discard changes and close?", buttons: ["Keep Editing", "Discard and Close"], defaultId: 0, cancelId: 0 });
    if (choice === 1) finishWindowClose();
  } finally { showingExitChoice = false; }
}
function askRendererToSave() {
  if (!editorWindow || editorWindow.isDestroyed() || showingExitChoice || waitingForSave) return;
  if (rendererError || editorWindow.webContents.isDestroyed() || editorWindow.webContents.isLoadingMainFrame()) { void showExitChoice(rendererError || "The editor has not finished loading."); return; }
  const token = randomUUID();
  waitingForSave = { token, timer: setTimeout(() => { if (waitingForSave?.token === token) void showExitChoice("The editor did not acknowledge its pending saves within 30 seconds."); }, 30000) };
  try { editorWindow.webContents.send("editor:exit-request", { token }); } catch { void showExitChoice("The editor could not receive the save request."); }
}
ipcMain.on("editor:exit-result", (event, value) => {
  if (!trustedSender(event) || !waitingForSave || !value || value.token !== waitingForSave.token || typeof value.saved !== "boolean") return;
  if (value.saved) finishWindowClose(); else void showExitChoice(value.error || "The project could not be saved.");
});
const operations = {
  "get-environment": "getEnvironment", "list-projects": "listProjects", "open-project": "openProject", "save-project": "saveProject", "import-media": "importMedia", "import-captions": "importCaptions", "export-project": "exportProject", "create-proxy": "createProxy", "analyze-silence": "analyzeSilence", "transcribe-asset": "transcribeAsset", "cancel-job": "cancelJob",
};
for (const [channel, method] of Object.entries(operations)) ipcMain.handle(`editor:${channel}`, async (event, value) => {
  if (!trustedSender(event) || !nativeHost || quitting) throw new Error("This IPC request does not belong to the local editor main frame.");
  try { return await nativeHost[method](value); } catch (error) { throw new Error(`${error.code ? `[${error.code}] ` : ""}${String(error.message || error).slice(0, 3000)}`); }
});
function hardenSession() {
  const current = session.defaultSession;
  current.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  current.setPermissionCheckHandler(() => false);
  current.setDevicePermissionHandler(() => false);
  current.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  current.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*", "ftp://*/*"] }, (details, callback) => callback({ cancel: !trustedUrl(details.url) }));
  current.on("will-download", (event) => event.preventDefault());
}
async function createEditorWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  editorWindow = new BrowserWindow({ ...workArea, minWidth: Math.min(1100, workArea.width), minHeight: Math.min(700, workArea.height), show: false, title: "OpenCut Next", backgroundColor: "#0a1019", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false } });
  editorWindow.maximize();
  const content = editorWindow.webContents;
  content.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const type of ["will-navigate", "will-redirect"]) content.on(type, (event) => { if (!trustedUrl(event.url)) event.preventDefault(); });
  content.on("will-frame-navigate", (event) => { if (!event.isMainFrame || !trustedUrl(event.url)) event.preventDefault(); });
  content.on("will-attach-webview", (event) => event.preventDefault());
  content.on("render-process-gone", (_event, detail) => { rendererError = `Editor process stopped: ${detail.reason}.`; if (waitingForSave) void showExitChoice(rendererError); });
  content.on("did-fail-load", (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { rendererError = `Editor failed to load: ${description}.`; editorWindow?.show(); if (waitingForSave) void showExitChoice(rendererError); } });
  content.on("did-finish-load", () => { rendererError = undefined; });
  editorWindow.once("ready-to-show", () => editorWindow?.show());
  editorWindow.on("close", (event) => { event.preventDefault(); askRendererToSave(); });
  editorWindow.on("closed", () => { forgetExitRequest(); editorWindow = undefined; });
  try { await editorWindow.loadURL(`${ORIGIN}/`); } catch (error) { rendererError = error.message; editorWindow?.show(); dialog.showErrorBox("OpenCut Next renderer failed", error.message); }
}
function terminate() {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    try { await nativeHost?.close(); } catch (error) { console.error("Native close failed", error); }
    try { await server?.close(); } catch (error) { console.error("Local origin close failed", error); }
    quitting = true; app.quit();
  })();
  return shutdown;
}
app.on("before-quit", (event) => { if (!quitting) { event.preventDefault(); if (editorWindow && !editorWindow.isDestroyed()) askRendererToSave(); else void terminate(); } });
app.on("window-all-closed", () => { void terminate(); });
app.on("second-instance", () => { if (editorWindow && !editorWindow.isDestroyed()) { if (editorWindow.isMinimized()) editorWindow.restore(); editorWindow.show(); editorWindow.focus(); } });
try {
  const profile = profileDirectory();
  if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); }
  else void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); app.setAppUserModelId("app.opencut.next.local"); hardenSession();
    const core = require("./core.cjs");
    nativeHost = new EditorNativeHost({ profile, core, version: app.getVersion(), dialogs: {
      async openMedia() { const value = await dialog.showOpenDialog(editorWindow, { title: "Import local media", properties: ["openFile", "multiSelections"], filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "png", "jpg", "jpeg", "webp", "bmp", "avif", "tif", "tiff"] }] }); return value.canceled ? [] : value.filePaths; },
      async openCaptions() { const value = await dialog.showOpenDialog(editorWindow, { title: "Import SRT captions", properties: ["openFile"], filters: [{ name: "SubRip captions", extensions: ["srt"] }] }); return value.canceled ? undefined : value.filePaths[0]; },
      async saveExport({ name, extension }) { const value = await dialog.showSaveDialog(editorWindow, { title: "Export locally", defaultPath: `${name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "_").slice(0, 100)}.${extension}`, filters: [{ name: extension === "mp4" ? "H.264 MP4" : "VP9 WebM", extensions: [extension] }], properties: ["showOverwriteConfirmation", "createDirectory"] }); return value.canceled ? undefined : value.filePath; },
    } });
    protocol.handle("app-media", (request) => nativeHost.media.response(request));
    nativeHost.jobs.on("job", (job) => { if (editorWindow && !editorWindow.isDestroyed()) editorWindow.webContents.send("editor:job", job); });
    server = await startServer(path.join(__dirname, "..", "dist"));
    server.server.on("error", (error) => { rendererError = `Local application server stopped: ${error.message}`; dialog.showErrorBox("OpenCut Next local server", rendererError); });
    await createEditorWindow();
  }).catch((error) => { dialog.showErrorBox("OpenCut Next could not start", error.message); void terminate(); });
} catch (error) { dialog.showErrorBox("OpenCut Next profile error", error.message); quitting = true; app.quit(); }
