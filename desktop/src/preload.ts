import { contextBridge, ipcRenderer } from "electron";

/** VS Code webview API polyfill used by media/chat.js */
function acquireVsCodeApi() {
  return {
    postMessage(message: unknown) {
      ipcRenderer.send("webview-msg", message);
    },
    getState() {
      return undefined;
    },
    setState(_state: unknown) {
      /* no-op for desktop MVP */
    },
  };
}

contextBridge.exposeInMainWorld("acquireVsCodeApi", acquireVsCodeApi);

// Host → renderer: mirror VS Code webview postMessage delivery.
ipcRenderer.on("host-msg", (_event, msg) => {
  window.postMessage(msg, "*");
});
