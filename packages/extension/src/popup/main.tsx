import React from 'react';
import ReactDOM from 'react-dom/client';
import { initNonePwdCore } from '@nonepwd/core';
import { applyDocumentTheme, loadThemePreference } from '../theme';
import { PopupApp } from './PopupApp';
import './styles.css';

async function bootstrap() {
  const pref = await loadThemePreference();
  applyDocumentTheme(pref);
  await initNonePwdCore();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PopupApp initialTheme={pref} />
    </React.StrictMode>
  );
}

void bootstrap();
