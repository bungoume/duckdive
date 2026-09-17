import { render } from 'preact';
import { App } from './app';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyTheme } from './settings';
import './styles.css';

applyTheme();
render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!,
);
