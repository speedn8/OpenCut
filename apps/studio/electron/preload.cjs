"use strict";

// Sandboxed preload: expose only the close/save exchange, never ipcRenderer.
const { contextBridge, ipcRenderer } = require("electron");
const REQUEST = "studio:close-requested";
const RESPONSE = "studio:close-response";
let callback;
let activeRequest;

function respondToClose(result) {
  if (!activeRequest || !result || typeof result.saved !== "boolean") return;
  const requestId = activeRequest;
  activeRequest = undefined;
  ipcRenderer.send(RESPONSE, {
    requestId,
    saved: result.saved,
    ...(typeof result.error === "string" ? { error: result.error.slice(0, 2000) } : {}),
  });
}

ipcRenderer.on(REQUEST, (_event, payload) => {
  if (!payload || typeof payload.requestId !== "string" || !/^[a-f0-9-]{36}$/u.test(payload.requestId)) return;
  if (activeRequest) {
    // An earlier timed-out flush may still finish. It must never acknowledge a
    // newer request through the renderer's intentionally token-free API.
    ipcRenderer.send(RESPONSE, { requestId: payload.requestId, saved: false, error: "A previous save is still finishing. Keep editing and try closing again." });
    return;
  }
  activeRequest = payload.requestId;
  if (!callback) { respondToClose({ saved: false, error: "The editor is not ready to confirm that the project is saved." }); return; }
  try {
    Promise.resolve(callback()).catch((error) => respondToClose({ saved: false, error: error instanceof Error ? error.message : "Project save failed." }));
  } catch (error) {
    respondToClose({ saved: false, error: error instanceof Error ? error.message : "Project save failed." });
  }
});

contextBridge.exposeInMainWorld("studioDesktop", Object.freeze({
  onCloseRequested(listener) {
    if (typeof listener !== "function") throw new TypeError("A close listener is required.");
    callback = listener;
    return () => { if (callback === listener) callback = undefined; };
  },
  respondToClose,
}));
