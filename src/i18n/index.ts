// UI language: a flat dictionary per language, `t()` for strings and `tx()` for strings that
// embed JSX (code samples, bold counts). The dictionaries are typed against `en`, so a missing
// key in any language is a compile error.
//
// The language is chosen once at startup (saved choice, else the browser / Chrome UI language)
// and can be switched from the header; the choice lives in localStorage like the other settings.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { en } from './en';
import { ja } from './ja';
import { zh_CN } from './zh_CN';
import { ko } from './ko';
import { de } from './de';
import { fr } from './fr';
import { es } from './es';

export type MsgKey = keyof typeof en;
export type Messages = Record<MsgKey, string>;
export type Lang = 'en' | 'ja' | 'zh_CN' | 'ko' | 'de' | 'fr' | 'es';

/** Languages offered in the header, labelled in their own script. */
export const LANGS: { id: Lang; label: string; html: string }[] = [
  { id: 'en', label: 'English', html: 'en' },
  { id: 'ja', label: '日本語', html: 'ja' },
  { id: 'zh_CN', label: '简体中文', html: 'zh-CN' },
  { id: 'ko', label: '한국어', html: 'ko' },
  { id: 'de', label: 'Deutsch', html: 'de' },
  { id: 'fr', label: 'Français', html: 'fr' },
  { id: 'es', label: 'Español', html: 'es' },
];

const TABLE: Record<Lang, Messages> = { en, ja, zh_CN, ko, de, fr, es };
const LS_LANG = 'ddv.lang';

export type Params = Record<string, string | number | undefined | null>;

function isLang(s: unknown): s is Lang {
  return typeof s === 'string' && s in TABLE;
}

/** Best language for the browser / Chrome UI locale (en when nothing matches). */
export function detectLang(): Lang {
  let tag: string;
  try {
    tag = (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()) || navigator.language || '';
  } catch {
    tag = navigator.language || '';
  }
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh_CN';
  const primary = lower.split(/[-_]/)[0];
  return isLang(primary) ? primary : 'en';
}

function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (isLang(saved)) return saved;
  } catch {
    /* ignore */
  }
  return detectLang();
}

let current: Lang = loadLang();
let msgs: Messages = TABLE[current];
const listeners = new Set<() => void>();

function applyHtmlLang(l: Lang) {
  try {
    document.documentElement.lang = LANGS.find((x) => x.id === l)?.html ?? 'en';
  } catch {
    /* not in a document */
  }
}
applyHtmlLang(current);

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  msgs = TABLE[l];
  try {
    localStorage.setItem(LS_LANG, l);
  } catch {
    /* ignore */
  }
  applyHtmlLang(l);
  for (const f of listeners) f();
}

/** Re-renders the calling component when the language changes; returns the current language. */
export function useLang(): Lang {
  const [l, setL] = useState(current);
  useEffect(() => {
    const f = () => setL(current);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return l;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Message for `key` with `{name}` placeholders filled from `params`; falls back to English. */
export function t(key: MsgKey, params?: Params): string {
  const s = msgs[key] ?? en[key] ?? key;
  if (!params) return s;
  return s.replace(PLACEHOLDER, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Like `t()`, but the parameters may be JSX nodes: the message is split around the placeholders
 * and returned as a list of children. Strings and numbers are inserted as text.
 */
export function tx(key: MsgKey, params: Record<string, ComponentChildren>): ComponentChildren[] {
  const s = msgs[key] ?? en[key] ?? key;
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(s.slice(last, idx));
    const v = params[m[1]];
    out.push(v === undefined ? m[0] : v);
    last = idx + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
