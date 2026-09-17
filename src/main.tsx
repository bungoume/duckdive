import { render } from 'preact';
import { App } from './app';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!,
);
