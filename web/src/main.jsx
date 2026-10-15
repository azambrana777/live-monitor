// First on purpose: the saved language is applied (strings and <html lang>)
// before anything below renders, so there is no flash of the wrong one.
import './i18n/boot.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { DialogProvider } from './useDialog.jsx';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './tokens.css';
import './styles.css';
import './btn.css';
// One CSS per surface, each with a single owner (see the plan, section 1.2).
// They load after styles.css and btn.css on purpose: at equal specificity the
// later rule wins, so a surface file overrides the old monolith without
// `!important`. The order below is fixed.
import './styles/primitives.css';
import './styles/charts.css';
import './styles/side-panels.css';
import './styles/dialogs.css';
import './styles/noproject.css';
import './styles/dialogs-a.css';
import './styles/dialogs-b.css';
import './styles/dialogs-c.css';
import './styles/publish.css';
import './styles/plugins.css';
import './styles/topbar.css';
import './styles/poll-progress.css';
import './styles/settings-menu.css';
import './styles/more-menu.css';
import './styles/projects.css';
import './styles/kpi.css';
import './styles/kpi-panels.css';
import './styles/board.css';
import './styles/completed.css';
import './styles/card.css';
import './styles/card-decision.css';
import './styles/card-work.css';
import './styles/card-code.css';
import './styles/card-env.css';
import './styles/card-settings.css';
import './styles/card-danger.css';
import './styles/chat.css';
import './styles/chat-bubbles.css';
import './styles/task-tabs.css';
import './styles/activity.css';
import { FileViewerProvider, StandaloneViewer } from './viewer/FileViewer.jsx';

// `?view=<machine>:<path>` is a file opened in its own tab: the viewer, full
// page, instead of the board. token.js has already taken `?token=` off the URL.
const standalone = new URLSearchParams(location.search).has('view');

createRoot(document.getElementById('root')).render(
  <DialogProvider>
    <FileViewerProvider>
      {standalone ? <StandaloneViewer /> : <App />}
    </FileViewerProvider>
  </DialogProvider>,
);
