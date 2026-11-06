import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import GrowthApp from './GrowthApp'
import WebChat from './WebChat'
import './style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {location.pathname.startsWith('/chat/') ? <WebChat /> : new URLSearchParams(location.search).has('legacy') ? <App /> : <GrowthApp />}
  </React.StrictMode>,
)
