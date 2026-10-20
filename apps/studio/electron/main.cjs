"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, screen, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { STUDIO_ORIGIN, startStaticServer } = require("./server.cjs");

const CLOSE_REQUEST = "studio:close-requested";
const CLOSE_RESPONSE = "studio:close-response";
const SAVE_WAIT_MS = 30000;
let window;
let localServer;
let pendingClose;
let closeDialogOpen = false;
let rendererFailure;
let finalQuit = false;
let shutdownPromise;

app.setName("OpenCut Studio");
app.enableSandbox();

function isStudioUrl(value) {
  try { return new URL(value).origin === STUDIO_ORIGIN; } catch { return false; }
}

function configureProfile() {
  const selected = process.env.OPENCUT_STUDIO_DATA_DIR;
  if (selected && !path.isAbsolute(selected)) throw new Error("OPENCUT_STUDIO_DATA_DIR must be an absolute disposable profile path.");
  const profile = selected || path.join(app.getPath("appData"), "OpenCut Studio");
  const browserData = path.join(profile, "browser-session");
  fs.mkdirSync(browserData, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", browserData);
}

function clearPendingClose() {
  if (pendingClose) clearTimeout(pendingClose.timeout);
  pendingClose = undefined;
}

function closeWindow(discard = false) {
  clearPendingClose();
  try { session.defaultSession.flushStorageData(); }
  catch (error) {
    console.error("Could not flush browser storage:", error);
    if (!discard) { void offerKeepEditing(`The browser storage flush failed: ${error.message}`); return; }
  }
  // Only reached after renderer acknowledgement or an explicit discard choice.
  // destroy bypasses a crashed renderer or an unresponsive beforeunload handler.
  if (window && !window.isDestroyed()) window.destroy();
}

async function offerKeepEditing(reason) {
  if (!window || window.isDestroyed() || closeDialogOpen) return;
  clearPendingClose();
  closeDialogOpen = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Project save was not confirmed",
      message: "Keep editing, or discard unsaved changes and close?",
      detail: String(reason || "The editor did not confirm that all changes were saved.").slice(0, 2000),
      buttons: ["Keep Editing", "Discard and Close"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 1) closeWindow(true);
  } catch (error) {
    console.error("Could not show the close confirmation:", error);
    // Native synchronous fallback still requires an explicit discard decision.
    const result = dialog.showMessageBoxSync({ type: "warning", title: "OpenCut Studio", message: "The editor could not confirm its save. Close and discard unsaved changes?", buttons: ["Keep Editing", "Discard and Close"], defaultId: 0, cancelId: 0, noLink: true });
    if (result === 1) closeWindow(true);
  } finally {
    closeDialogOpen = false;
  }
}

function requestClose() {
  if (!window || window.isDestroyed() || pendingClose || closeDialogOpen) return;
  if (rendererFailure || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) {
    void offerKeepEditing(rendererFailure || "The editor is still loading and cannot confirm a completed save.");
    return;
  }
  const requestId = randomUUID();
  const timeout = setTimeout(() => {
    if (pendingClose?.requestId !== requestId) return;
    void offerKeepEditing("The editor did not finish confirming its save within 30 seconds. A save may still be running.");
  }, SAVE_WAIT_MS);
  pendingClose = { requestId, timeout };
  try { window.webContents.send(CLOSE_REQUEST, { requestId }); }
  catch { void offerKeepEditing("The editor could not receive the save request."); }
}

ipcMain.on(CLOSE_RESPONSE, (event, result) => {
  if (!window || window.isDestroyed() || !pendingClose || !result || typeof result !== "object") return;
  const contents = window.webContents;
  const frame = event.senderFrame;
  if (event.sender !== contents || !frame || frame !== contents.mainFrame || !isStudioUrl(frame.url)) return;
  if (result.requestId !== pendingClose.requestId || typeof result.saved !== "boolean") return;
  if (result.saved) closeWindow();
  else void offerKeepEditing(typeof result.error === "string" ? result.error : "Project saving failed.");
});

function configureSession() {
  const studioSession = session.defaultSession;
  const trustedContents = (contents) => window && !window.isDestroyed() && contents === window.webContents && isStudioUrl(contents.getURL());
  // OPFS and IndexedDB require no filesystem bridge. Persistent storage is the
  // only optional permission granted, and only to the application's main frame.
  studioSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === "persistent-storage" && Boolean(trustedContents(contents)) && details.isMainFrame === true && isStudioUrl(details.requestingUrl));
  });
  studioSession.setPermissionCheckHandler((contents, permission, origin, details) => permission === "persistent-storage" && Boolean(trustedContents(contents)) && origin === STUDIO_ORIGIN && details.isMainFrame === true);
  studioSession.setDevicePermissionHandler(() => false);
  studioSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  studioSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*", "ftp://*/*"] }, (details, callback) => {
    callback({ cancel: !isStudioUrl(details.url) });
  });
  studioSession.on("will-download", (event, item) => {
    const url = item.getURL();
    if (!isStudioUrl(url) && !url.startsWith(`blob:${STUDIO_ORIGIN}/`)) event.preventDefault();
  });
}

async function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    ...area,
    minWidth: Math.min(1000, area.width),
    minHeight: Math.min(650, area.height),
    show: false,
    backgroundColor: "#101214",
    title: "OpenCut Studio",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  window.maximize();
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => { if (!isStudioUrl(event.url)) event.preventDefault(); });
  contents.on("will-redirect", (event) => { if (!isStudioUrl(event.url)) event.preventDefault(); });
  contents.on("will-frame-navigate", (event) => { if (!event.isMainFrame || !isStudioUrl(event.url)) event.preventDefault(); });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("render-process-gone", (_event, details) => {
    rendererFailure = `The editor process stopped (${details.reason}). Unsaved changes could not be confirmed.`;
    if (pendingClose) void offerKeepEditing(rendererFailure);
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      rendererFailure = `The editor could not load (${description}). Unsaved changes could not be confirmed.`;
      if (window && !window.isDestroyed()) window.show();
      if (pendingClose) void offerKeepEditing(rendererFailure);
    }
  });
  contents.on("did-finish-load", () => { rendererFailure = undefined; });
  window.once("ready-to-show", () => { if (window && !window.isDestroyed()) window.show(); });
  window.on("close", (event) => { event.preventDefault(); requestClose(); });
  window.on("closed", () => { clearPendingClose(); window = undefined; });
  try { await window.loadURL(`${STUDIO_ORIGIN}/`); }
  catch (error) {
    rendererFailure = `The local editor failed to load: ${error.message}`;
    if (window && !window.isDestroyed()) window.show();
    dialog.showErrorBox("OpenCut Studio could not load", rendererFailure);
  }
}

function shutdownAndQuit() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try { if (localServer) await localServer.close(); }
    catch (error) { console.error("Local server cleanup failed:", error); }
    finalQuit = true;
    app.quit();
  })();
  return shutdownPromise;
}

app.on("before-quit", (event) => {
  if (finalQuit) return;
  event.preventDefault();
  if (window && !window.isDestroyed()) requestClose();
  else void shutdownAndQuit();
});
app.on("window-all-closed", () => { void shutdownAndQuit(); });
app.on("second-instance", () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

try {
  configureProfile();
  if (!app.requestSingleInstanceLock()) { finalQuit = true; app.quit(); }
  else {
    void app.whenReady().then(async () => {
      Menu.setApplicationMenu(null);
      app.setAppUserModelId("app.opencut.studio.local");
      configureSession();
      localServer = await startStaticServer(path.join(__dirname, "..", "dist"));
      localServer.server.on("error", (error) => {
        rendererFailure = `The local application server failed: ${error.message}`;
        if (pendingClose) void offerKeepEditing(rendererFailure);
        dialog.showErrorBox("OpenCut Studio local server failed", rendererFailure);
      });
      await createWindow();
    }).catch((error) => {
      dialog.showErrorBox("OpenCut Studio could not start", error.message);
      void shutdownAndQuit();
    });
  }
} catch (error) {
  dialog.showErrorBox("OpenCut Studio profile could not be opened", error.message);
  finalQuit = true;
  app.quit();
}
