import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { TickerProvider } from './useElapsedTicker';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in document.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <TickerProvider>
          <App />
        </TickerProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
