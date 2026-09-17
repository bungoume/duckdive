import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { Popover } from './ui';

/** "Share" in the header: copies a link to the current view; shows it when the clipboard is unavailable. */
export function ShareButton(props: { link: () => string; withSource: boolean; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'shown'>('idle');
  const [link, setLink] = useState('');

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const share = async () => {
    const l = props.link();
    setLink(l);
    try {
      await navigator.clipboard.writeText(l);
      setState('copied');
    } catch {
      setState('shown');
    }
  };

  const label = state === 'copied' ? (props.withSource ? t('share.copied') : t('share.copiedNoSource')) : t('share.button');
  return (
    <Popover
      open={state === 'shown'}
      onClose={() => setState('idle')}
      align="right"
      width={480}
      button={
        <button class="btn small share" onClick={() => void share()} title={t('share.title')} disabled={props.disabled}>
          {label}
        </button>
      }
    >
      <h4>{t('share.title')}</h4>
      <input class="input mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      <p class="hint">{props.withSource ? t('share.hint') : t('share.hintNoSource')}</p>
    </Popover>
  );
}
