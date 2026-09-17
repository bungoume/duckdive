import { Component, type ComponentChildren } from 'preact';
import { describeError } from '../errors';
import { t } from '../i18n';

/** Keeps a render error from blanking the page: shows the message and a reload button instead. */
export class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: string | null }> {
  override state = { error: null };

  static override getDerivedStateFromError(e: unknown) {
    return { error: describeError(e) };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div class="alert error" style="margin:16px">
        {t('app.crashed', { error: this.state.error })}{' '}
        <button class="btn small" onClick={() => location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
}
