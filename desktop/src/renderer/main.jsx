// The launcher page's entry point. window.launcher comes from the preload script
// (src/preload/preload.cjs); the page reaches the main process only through it.
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';
import './launcher.css';
import LauncherApp from './LauncherApp.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <LauncherApp launcher={window.launcher} />
    </React.StrictMode>,
);
