import React from 'react';
import ReactDOM from 'react-dom/client';
import { initNonePwdCore } from '@nonepwd/core';
import { PopupApp } from './PopupApp';
import './styles.css';

async function bootstrap() {
  await initNonePwdCore();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PopupApp />
    </React.StrictMode>
  );
}

void bootstrap();
