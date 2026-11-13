import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app.tsx';
import { AuthGate } from './auth.tsx';
import { watchVisibleViewport } from './app-viewport.ts';
import { mountDiagnostics } from './diag.ts';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// 先把「看得见的那块」量好，首帧就按它排版；登录页也吃这一份，键盘弹起时同样不跑出屏幕。
watchVisibleViewport(window, document);
mountDiagnostics();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <App />
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>
);
