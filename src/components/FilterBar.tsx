import { useState } from 'preact/hooks';
import type { Field } from '../fields';
import { describeFilter, newId, type Filter, type FilterOp } from '../sql';
import { Popover } from './ui';

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
      <h4>{props.initial ? 'Edit filter' : 'Add filter'}</h4>
      <div class="field-row">
        <label>Operator</label>
        <select class="input" value={op} onChange={(e) => setOp((e.target as HTMLSelectElement).value as FilterOp)}>
          <option value="is">is</option>
          <option value="is_not">is not</option>
          <option value="is_one_of">is one of</option>
          <option value="is_not_one_of">is not one of</option>
          <option value="exists">exists</option>
          <option value="does_not_exist">does not exist</option>
          <option value="between">is between</option>
          <option value="query">custom SQL</option>
        </select>
      </div>
      {!custom && (
        <div class="field-row">
          <label>Field</label>
          <select class="input" value={field} onChange={(e) => setField((e.target as HTMLSelectElement).value)}>
            {props.fields.filter((f) => f.kind !== 'object').map((f) => (
              <option value={f.name}>{f.name}</option>
            ))}
          </select>
        </div>
      )}
      {(op === 'is' || op === 'is_not' || op === 'is_one_of' || op === 'is_not_one_of') && (
        <div class="field-row">
          <label>{op.endsWith('one_of') ? 'Values (comma separated)' : 'Value'}</label>
          <input class="input" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </div>
      )}
      {op === 'between' && (
        <div class="row">
          <div class="field-row" style="flex:1">
            <label>From (inclusive)</label>
            <input class="input" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
          </div>
          <div class="field-row" style="flex:1">
            <label>To (exclusive)</label>
            <input class="input" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
          </div>
        </div>
      )}
      {custom && (
        <div class="field-row">
          <label>SQL boolean expression (DuckDB)</label>
          <textarea class="input" value={sql} onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)} placeholder={'e.g. "http"."latency_ms" > 500 AND "level" <> \'info\''} />
        </div>
      )}
      <div class="row end">
        <button class="btn small" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          class="btn primary small"
          onClick={() => {
            const f: Filter = { id: props.initial?.id ?? newId(), field, op, negate: props.initial?.negate, disabled: props.initial?.disabled };
            if (op === 'is' || op === 'is_not') f.value = value;
            if (op === 'is_one_of' || op === 'is_not_one_of') f.values = value.split(',').map((s) => s.trim()).filter(Boolean);
            if (op === 'between') {
              f.from = from || undefined;
              f.to = to || undefined;
            }
            if (custom) {
              f.sql = sql;
              f.label = sql.length > 60 ? sql.slice(0, 57) + '…' : sql;
              f.field = '';
            }
            props.onSave(f);
          }}
        >
          Save
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
  const remove = (id: string) => props.onChange(props.filters.filter((f) => f.id !== id));

  return (
    <div class="filterbar">
      {props.filters.map((f) => (
        <Popover
          open={menu === f.id || editing === f.id}
          onClose={() => {
            setMenu(null);
            setEditing(null);
          }}
          button={
            <span class={'pill' + (f.negate ? ' negate' : '') + (f.disabled ? ' disabled' : '')} title={describeFilter(f)}>
              <span class="txt" style="cursor:pointer" onClick={() => setMenu(menu === f.id ? null : f.id)}>
                {describeFilter({ ...f, negate: false })}
              </span>
              <button title="Remove" onClick={() => remove(f.id)}>
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
                update(f.id, nf);
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
                ✎ Edit filter
              </button>
              <button
                onClick={() => {
                  update(f.id, { negate: !f.negate });
                  setMenu(null);
                }}
              >
                {f.negate ? 'Include results' : 'Exclude results'}
              </button>
              <button
                onClick={() => {
                  update(f.id, { disabled: !f.disabled });
                  setMenu(null);
                }}
              >
                {f.disabled ? 'Re-enable' : 'Temporarily disable'}
              </button>
              <button
                onClick={() => {
                  remove(f.id);
                  setMenu(null);
                }}
              >
                🗑 Delete
              </button>
            </div>
          )}
        </Popover>
      ))}
      <Popover open={adding} onClose={() => setAdding(false)} button={<button class="add" onClick={() => setAdding(!adding)}>+ Add filter</button>}>
        <FilterEditor
          fields={props.fields}
          onCancel={() => setAdding(false)}
          onSave={(f) => {
            props.onChange([...props.filters, f]);
            setAdding(false);
          }}
        />
      </Popover>
      {props.filters.length > 1 && (
        <button class="add" onClick={() => props.onChange([])}>
          Clear all
        </button>
      )}
    </div>
  );
}
