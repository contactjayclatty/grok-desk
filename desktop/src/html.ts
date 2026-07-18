import * as path from "node:path";
import { pathToFileURL } from "node:url";

function fileUrl(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Build the chat HTML that loads the existing media/* UI assets. */
export function buildChatHtml(repoRoot: string): string {
  const media = (...parts: string[]) => fileUrl(path.join(repoRoot, "media", ...parts));
  const resources = (...parts: string[]) => fileUrl(path.join(repoRoot, "resources", ...parts));
  const theme = fileUrl(path.join(repoRoot, "desktop", "theme.css"));
  const icon = resources("grok-icon.svg");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Grok Desk</title>
<link rel="stylesheet" href="${theme}" />
<link rel="stylesheet" href="${media("chat.css")}" />
</head>
<body class="thinking-hidden" style="--chat-zoom: 1">

  <header class="top-bar">
    <button id="history-btn" class="icon-btn" title="Session history"></button>
    <button id="new-btn" class="icon-btn" title="New session"></button>
    <div id="history-popover" class="toolbar-popover history-popover" hidden></div>
  </header>

  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <span class="welcome-mark" role="img" aria-label="Grok" style="--welcome-mark:url('${icon}')"></span>
      <h2>Grok Desk</h2>
      <p class="welcome-byline muted">Standalone GUI for Grok Build</p>
      <p id="welcome-version" class="muted loading-dots">Starting</p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>

  <footer class="composer">
    <button id="scroll-bottom-btn" class="scroll-bottom-btn" type="button" title="Scroll to bottom"></button>
    <div class="composer-card">
      <div id="attachments" class="attachments"></div>
      <div class="composer-input-wrap">
        <div id="input-highlight" class="input-highlight" aria-hidden="true" dir="auto"></div>
        <textarea id="input" placeholder="Ask Grok..." rows="2" dir="auto"></textarea>
        <button id="mic-btn" class="mic-btn" title="Voice control"></button>
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button id="add-btn" class="icon-btn" title="Add context"></button>
          <button id="gear-btn" class="icon-btn" title="Settings"></button>
          <div class="context-donut" id="donut" title="Context usage">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-editorWidget-border,#444)" stroke-width="3"/>
              <circle id="donut-arc" cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-charts-green,#4ec9b0)" stroke-width="3" stroke-dasharray="0 999" transform="rotate(-90 8 8)"/>
            </svg>
            <span id="donut-label" class="small muted">0%</span>
          </div>
          <div id="chips"></div>
        </div>
        <div class="toolbar-right">
          <button id="mode-btn" class="toolbar-btn" title="Pick mode"></button>
          <button id="send-btn" class="send"></button>
        </div>
      </div>
    </div>
    <div id="mode-popover" class="toolbar-popover" hidden></div>
    <div id="gear-popover" class="toolbar-popover gear-popover" hidden></div>
    <div id="add-popover" class="toolbar-popover" hidden></div>
    <div id="context-popover" class="toolbar-popover" hidden></div>
    <div id="slash-popover" class="slash-popover" hidden></div>
  </footer>

  <script>
    window.MathJax = {
      tex: { processEnvironments: true, processRefs: true },
      svg: { fontCache: "local" },
      options: { enableMenu: false, enableAssistiveMml: false },
      startup: { typeset: false }
    };
  </script>
  <script src="${media("mathjax/tex-svg-full.js")}"></script>
  <script src="${media("mermaid/mermaid.min.js")}"></script>
  <script src="${media("webview-helpers.js")}"></script>
  <script src="${media("chat.js")}"></script>
</body>
</html>`;
}
