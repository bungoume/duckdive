import { useState } from 'preact/hooks';
import { t } from '../i18n';
import type { Field } from '../fields';
import { describeFilter, newId, sqlLabel, type Filter, type FilterOp } from '../sql';
import { trustSql } from '../trust';
import { FormField, Popover } from './ui';

function FilterEditor(props: { fields: Field[]; initial?: Filter; onSave: (f: Filter) => void; onCancel: () => void }) {
  const [field, setField] = useState(props.initial?.field ?? props.fields[0]?.name ?? '');
  const [op, setOp] = useState<FilterOp>(props.initial?.op ?? 'is');
  const [value, setValue] = useState(props.initial?.value ?? (props.initial?.values ?? []).join(', '));
  const [from, setFrom] = useState(props.initial?.from ?? '');
  const [to, setTo] = useState(props.initial?.to ?? '');
  const [sql, setSql] = useState(props.initial?.sql ?? '');
  const custom = op === 'query';
  return (
    <div style="width:360px">
      <h4>{props.initial ? t('flt.edit') : t('flt.add')}</h4>
      <FormField label={t('flt.operator')}>
        <select class="input" value={op} onChange={(e) => setOp(e.currentTarget.value as FilterOp)}>
          <option value="is">{t('flt.op.is')}</option>
          <option value="is_not">{t('flt.op.is_not')}</option>
          <option value="is_one_of">{t('flt.op.is_one_of')}</option>
          <option value="is_not_one_of">{t('flt.op.is_not_one_of')}</option>
          <option value="exists">{t('flt.op.exists')}</option>
          <option value="does_not_exist">{t('flt.op.does_not_exist')}</option>
          <option value="between">{t('flt.op.between')}</option>
          <option value="query">{t('flt.op.query')}</option>
        </select>
      </FormField>
      {!custom && (
        <FormField label={t('common.field')}>
          <select class="input" value={field} onChange={(e) => setField(e.currentTarget.value)}>
            {props.fields
              .filter((f) => f.kind !== 'object')
              .map((f) => (
                <option value={f.name}>{f.name}</option>
              ))}
          </select>
        </FormField>
      )}
      {(op === 'is' || op === 'is_not' || op === 'is_one_of' || op === 'is_not_one_of') && (
        <FormField label={op.endsWith('one_of') ? t('flt.values') : t('flt.value')}>
          <input class="input" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        </FormField>
      )}
      {op === 'between' && (
        <div class="row">
          <FormField label={t('flt.from')} class="grow">
            <input class="input" value={from} onInput={(e) => setFrom(e.currentTarget.value)} />
          </FormField>
          <FormField label={t('flt.to')} class="grow">
            <input class="input" value={to} onInput={(e) => setTo(e.currentTarget.value)} />
          </FormField>
        </div>
      )}
      {custom && (
        <FormField label={t('flt.sql')}>
          <textarea class="input" value={sql} onInput={(e) => setSql(e.currentTarget.value)} placeholder={'e.g. "http"."latency_ms" > 500 AND "level" <> \'info\''} />
        </FormField>
      )}
      <div class="row end">
        <button class="btn small" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
        <button
          class="btn primary small"
          onClick={() => {
            const f: Filter = { id: props.initial?.id ?? newId(), field, op, negate: props.initial?.negate, disabled: props.initial?.disabled };
            if (op === 'is' || op === 'is_not') f.value = value;
            if (op === 'is_one_of' || op === 'is_not_one_of')
              f.values = value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (op === 'between') {
              f.from = from || undefined;
              f.to = to || undefined;
            }
            if (custom) {
              f.sql = sql;
              f.label = sqlLabel(sql);
              f.field = '';
            }
            props.onSave(f);
          }}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

export function FilterBar(props: { filters: Filter[]; fields: Field[]; onChange: (f: Filter[]) => void }) {
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const update = (id: string, patch: Partial<Filter>) => props.onChange(props.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const replace = (id: string, nf: Filter) => props.onChange(props.filters.map((f) => (f.id === id ? nf : f)));
  const remove = (id: string) => props.onChange(props.filters.filter((f) => f.id !== id));
  /** A custom SQL filter saved from the editor was written (or reviewed) here: remember it as trusted. */
  const saved = (f: Filter): Filter => {
    if (f.op === 'query' && f.sql) trustSql(f.sql);
    return f;
  };
  const untrusted = props.filters.filter((f) => f.untrusted).length;

  return (
    <div class="filterbar">
      {untrusted > 0 && (
        <div class="alert warn filter-untrusted" style="flex-basis:100%;margin:0">
          {t('flt.untrusted', { n: untrusted })}
        </div>
      )}
      {props.filters.map((f) => (
        <Popover
          key={f.id}
          open={menu === f.id || editing === f.id}
          onClose={() => {
            setMenu(null);
            setEditing(null);
          }}
          button={
            <span class={'pill' + (f.negate ? ' negate' : '') + (f.disabled ? ' disabled' : '') + (f.untrusted ? ' untrusted' : '')} title={describeFilter(f)} data-not={t('flt.not')}>
              <span
                class="txt"
                style="cursor:pointer"
                role="button"
                tabIndex={0}
                aria-expanded={menu === f.id}
                onClick={() => setMenu(menu === f.id ? null : f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setMenu(menu === f.id ? null : f.id);
                  }
                }}
              >
                {describeFilter({ ...f, negate: false })}
              </span>
              <button title={t('common.remove')} aria-label={t('common.remove')} onClick={() => remove(f.id)}>
                ✕
              </button>
            </span>
          }
        >
          {editing === f.id ? (
            <FilterEditor
              fields={props.fields}
              initial={f}
              onCancel={() => setEditing(null)}
              onSave={(nf) => {
                replace(f.id, saved(nf));
                setEditing(null);
              }}
            />
          ) : (
            <div class="menu">
              <button
                onClick={() => {
                  setMenu(null);
                  setEditing(f.id);
                }}
              >
                {t('flt.menu.edit')}
              </button>
              <button
                onClick={() => {
                  update(f.id, { negate: !f.negate });
                  setMenu(null);
                }}
              >
                {f.negate ? t('flt.menu.include') : t('flt.menu.exclude')}
              </button>
              {f.untrusted ? (
                <>
                  {/* the statement itself, so that "I checked this SQL" is about something the user has seen */}
                  <code class="sql">{f.sql}</code>
                  <button
                    onClick={() => {
                      const { untrusted: _u, disabled: _d, ...rest } = f;
                      replace(f.id, saved(rest));
                      setMenu(null);
                    }}
                  >
                    {t('flt.menu.trust')}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    update(f.id, { disabled: !f.disabled });
                    setMenu(null);
                  }}
                >
                  {f.disabled ? t('flt.menu.reenable') : t('flt.menu.disable')}
                </button>
              )}
              <button
                onClick={() => {
                  remove(f.id);
                  setMenu(null);
                }}
              >
                {t('flt.menu.delete')}
              </button>
            </div>
          )}
        </Popover>
      ))}
      <Popover
        open={adding}
        onClose={() => setAdding(false)}
        button={
          <button class="add" onClick={() => setAdding(!adding)}>
            {t('flt.addButton')}
          </button>
        }
      >
        <FilterEditor
          fields={props.fields}
          onCancel={() => setAdding(false)}
          onSave={(f) => {
            props.onChange([...props.filters, saved(f)]);
            setAdding(false);
          }}
        />
      </Popover>
      {props.filters.length > 1 && (
        <button class="add" onClick={() => props.onChange([])}>
          {t('flt.clearAll')}
        </button>
      )}
    </div>
  );
}
