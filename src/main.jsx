import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import { holdReloadOnDisconnect } from '@/lib/devReloadGuard'
import '@/index.css'

holdReloadOnDisconnect(import.meta.hot)

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
