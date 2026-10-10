const { contextBridge, ipcRenderer } = require("electron");

// The only surface the page sees. None of these return or accept key material.
contextBridge.exposeInMainWorld("bridge", {
  state: () => ipcRenderer.invoke("state"),
  doctor: () => ipcRenderer.invoke("doctor"),
  setup: (request) => ipcRenderer.invoke("setup", request),
  open: (page) => ipcRenderer.invoke("open", page),
  copy: (text) => ipcRenderer.invoke("copy", text),
  restartAgent: () => ipcRenderer.invoke("restart-agent"),
  setOpenAtLogin: (value) => ipcRenderer.invoke("login-item", value),
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
});
