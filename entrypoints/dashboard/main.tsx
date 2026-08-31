import { render } from 'preact';
import '../../assets/app.css';
import { App } from './App';
import { ToastProvider } from './components/ui';

render(
  <ToastProvider>
    <App />
  </ToastProvider>,
  document.getElementById('app')!,
);
