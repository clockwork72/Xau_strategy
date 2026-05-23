import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Apply the saved theme before first paint so users don't see a flash of
// dark while loading in light mode (or vice-versa).
const saved = localStorage.getItem('xau:theme')
document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
