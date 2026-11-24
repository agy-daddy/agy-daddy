import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { apiClient } from './api/client';
import { I18nProvider, type Locale } from './i18n';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';

function handleLocaleChange(next: Locale): void {
  void apiClient.setHostLocale(next).catch(() => {});
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <ThemeProvider>
        <I18nProvider onLocaleChange={handleLocaleChange}>
          <App />
        </I18nProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
