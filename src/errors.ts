// Turning a thrown value into the text of an error banner.

import { t } from './i18n';
import { TimeoutError } from './net';

/** The message of an Error (without the "Error:" prefix String() adds), timeouts in the UI language, anything else as text. */
export function describeError(e: unknown): string {
  if (e instanceof TimeoutError) return t('app.error.timeout', { what: e.what, seconds: Math.round(e.ms / 1000) });
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
