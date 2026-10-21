"use strict";
const { contextBridge, ipcRenderer } = require("electron");
let exitListener;
let exitToken;
const jobListeners = new Set();
const invoke = (operation, value) => ipcRenderer.invoke(`editor:${operation}`, value);

function respondToClose(value) {
  if (!exitToken || !value || typeof value.saved !== "boolean") return;
  const token = exitToken; exitToken = undefined;
  ipcRenderer.send("editor:exit-result", { token, saved: value.saved, ...(typeof value.error === "string" ? { error: value.error.slice(0, 2000) } : {}) });
}
ipcRenderer.on("editor:exit-request", (_event, value) => {
  if (!value || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/u.test(value.token)) return;
  if (exitToken) { ipcRenderer.send("editor:exit-result", { token: value.token, saved: false, error: "A previous save is still pending. Retry after it finishes, or explicitly discard." }); return; }
  exitToken = value.token;
  if (!exitListener) { respondToClose({ saved: false, error: "The editor has not registered its save handler." }); return; }
  try { Promise.resolve(exitListener()).catch((error) => respondToClose({ saved: false, error: String(error?.message || error) })); }
  catch (error) { respondToClose({ saved: false, error: String(error?.message || error) }); }
});
ipcRenderer.on("editor:job", (_event, value) => {
  if (!value || typeof value.id !== "string" || !["queued", "running", "completed", "failed", "cancelled"].includes(value.status) || !Number.isFinite(value.progress)) return;
  for (const listener of jobListeners) { try { listener(value); } catch { /* A UI listener cannot corrupt the native queue. */ } }
});
contextBridge.exposeInMainWorld("editorHost", Object.freeze({
  getEnvironment: () => invoke("get-environment"),
  listProjects: () => invoke("list-projects"),
  openProject: (id) => invoke("open-project", id),
  saveProject: (value) => invoke("save-project", value),
  importMedia: () => invoke("import-media"),
  importCaptions: () => invoke("import-captions"),
  exportProject: (value) => invoke("export-project", value),
  createProxy: (id) => invoke("create-proxy", id),
  analyzeSilence: (id) => invoke("analyze-silence", id),
  transcribeAsset: (id) => invoke("transcribe-asset", id),
  cancelJob: (id) => invoke("cancel-job", id),
  onJobs(listener) { if (typeof listener !== "function") throw new TypeError("Expected a job callback."); jobListeners.add(listener); return () => jobListeners.delete(listener); },
  onCloseRequested(listener) { if (typeof listener !== "function") throw new TypeError("Expected a close callback."); exitListener = listener; return () => { if (exitListener === listener) exitListener = undefined; }; },
  respondToClose,
}));
