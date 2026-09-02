import { render } from 'preact';
import './assets/app.css';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { startRuntime } from './runtime';

void startRuntime();

render(
  <ToastProvider>
    <App />
  </ToastProvider>,
  document.getElementById('app')!,
);

const boot = document.getElementById('boot');
if (boot) boot.remove();
