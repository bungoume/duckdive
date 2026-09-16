import { t } from '../../i18n';
import type { Variables } from '../../hooks/useConnect';

/** The {name} tokens of the pattern: which values were listed and which the user picked. */
export function TokenValues(props: {
  tokens: string[];
  vars: Variables | null;
  selected: Record<string, string[]>;
  missing: string[];
  onSelect: (name: string, values: string[]) => void;
  onSelectAll: () => void;
}) {
  const { tokens, vars } = props;
  return (
    <div class="variables-box">
      <div class="row" style="justify-content:space-between;align-items:center">
        <span class="variables-title">{t('ds.vars.title', { names: tokens.join(', ') })}</span>
        {vars && (
          <span class="row" style="gap:6px">
            <span class="hint">{t('ds.vars.listed', { n: vars.listedFiles.toLocaleString() })}</span>
            <button class="btn small" onClick={props.onSelectAll}>
              {t('ds.vars.selectAll')}
            </button>
          </span>
        )}
      </div>
      {!vars && (
        <div class="hint" style="margin-top:6px">
          {t('ds.vars.hint', { button: t('ds.listAndConnect'), names: tokens.join(', ') })}
        </div>
      )}
      {vars &&
        tokens.map((n) => {
          const opts = vars.values[n] ?? [];
          const sel = props.selected[n] ?? [];
          return (
            <div class="var-values" data-token={n} style="margin-top:8px">
              <div class="row" style="gap:8px;align-items:center">
                <b class="mono" style="font-size:12px">
                  {'{' + n + '}'}
                </b>
                <span class="hint">{t('ds.vars.count', { n: opts.length, sel: sel.length })}</span>
                <button
                  class="btn ghost small"
                  onClick={() =>
                    props.onSelect(
                      n,
                      opts.map((v) => v.value),
                    )
                  }
                >
                  {t('ds.vars.all')}
                </button>
                <button class="btn ghost small" onClick={() => props.onSelect(n, [])}>
                  {t('ds.vars.none')}
                </button>
              </div>
              <div class="var-list">
                {opts.map((v) => (
                  <label class="var-item">
                    <input
                      type="checkbox"
                      checked={sel.includes(v.value)}
                      onChange={(e) => props.onSelect(n, (e.target as HTMLInputElement).checked ? [...sel, v.value] : sel.filter((x) => x !== v.value))}
                    />
                    <span class="mono">{v.value || t('common.empty')}</span>
                    <span class="hint">{t('common.files', { n: v.files.toLocaleString() })}</span>
                  </label>
                ))}
                {opts.length === 0 && <span class="hint">{t('ds.vars.noValue')}</span>}
              </div>
            </div>
          );
        })}
      {vars && props.missing.length > 0 && (
        <div class="alert warn" style="margin-top:8px">
          {t('ds.vars.missing', { names: props.missing.join(', ') })}
        </div>
      )}
    </div>
  );
}
