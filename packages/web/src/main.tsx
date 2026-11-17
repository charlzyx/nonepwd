import React from 'react';
import ReactDOM from 'react-dom/client';
import { initNonePwdCore } from '@nonepwd/core';
import App from './App';
import './styles.css';

async function bootstrap() {
  await initNonePwdCore();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
