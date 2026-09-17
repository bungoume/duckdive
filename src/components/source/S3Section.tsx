import { useState } from 'preact/hooks';
import { redirectUrl, secondsUntilExpiry, signIn, storeCredentials, type AwsCredentials, type OidcConfig } from '../../auth';
import { describeError } from '../../errors';
import { t, tx } from '../../i18n';
import { isExtension } from '../../permissions';
import type { AuthMode, SourceConfig } from '../../sources';
import { FormField } from '../ui';

/** S3 connection settings: region, endpoint, URL style and how credentials are obtained. */
export function S3Section(props: {
  cfg: SourceConfig;
  creds: AwsCredentials | null;
  onChange: (patch: Partial<SourceConfig>) => void;
  onS3: (patch: Partial<SourceConfig['s3']>) => void;
  onOidc: (patch: Partial<OidcConfig>) => void;
  onCreds: (c: AwsCredentials | null) => void;
}) {
  const { cfg } = props;
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const doSignIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      props.onCreds(await signIn(cfg.oidc, true));
    } catch (e) {
      setAuthError(describeError(e));
    } finally {
      setAuthBusy(false);
    }
  };
  const expiresIn = props.creds ? Math.max(0, Math.round(secondsUntilExpiry(props.creds) / 60)) : 0;
  const input = (value: string, onInput: (v: string) => void, extra: Record<string, unknown> = {}) => <input class="input" value={value} onInput={(e) => onInput(e.currentTarget.value)} {...extra} />;

  return (
    <div class="mt8">
      <h4 style="margin:8px 0 6px;font-size:13px">{t('ds.s3.title')}</h4>
      <div class="grid2">
        <FormField label={t('ds.s3.region')}>{input(cfg.s3.region, (v) => props.onS3({ region: v }))}</FormField>
        <FormField label={t('ds.s3.endpoint')}>{input(cfg.s3.endpoint, (v) => props.onS3({ endpoint: v }), { placeholder: 's3.ap-northeast-1.amazonaws.com' })}</FormField>
        <FormField label={t('ds.s3.urlStyle')}>
          <select class="input" value={cfg.s3.urlStyle} onChange={(e) => props.onS3({ urlStyle: e.currentTarget.value as 'vhost' | 'path' })}>
            <option value="vhost">{t('ds.s3.vhost')}</option>
            <option value="path">{t('ds.s3.path')}</option>
          </select>
        </FormField>
        <FormField label={t('ds.s3.auth')}>
          <select class="input" value={cfg.authMode} onChange={(e) => props.onChange({ authMode: e.currentTarget.value as AuthMode })}>
            <option value="oidc">{t('ds.auth.oidc')}</option>
            <option value="static">{t('ds.auth.static')}</option>
            <option value="none">{t('ds.auth.none')}</option>
          </select>
        </FormField>
      </div>

      {cfg.authMode === 'static' && (
        <>
          <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.key.title')}</h4>
          <div class="alert info">{t('ds.key.warn')}</div>
          <div class="grid2">
            <FormField label={t('ds.key.id')}>{input(cfg.s3.accessKeyId, (v) => props.onS3({ accessKeyId: v }), { autocomplete: 'off' })}</FormField>
            <FormField label={t('ds.key.secret')}>{input(cfg.s3.secretAccessKey, (v) => props.onS3({ secretAccessKey: v }), { type: 'password', autocomplete: 'off' })}</FormField>
            <FormField label={t('ds.key.token')}>{input(cfg.s3.sessionToken, (v) => props.onS3({ sessionToken: v }), { type: 'password', autocomplete: 'off' })}</FormField>
          </div>
        </>
      )}

      {cfg.authMode === 'oidc' && (
        <>
          <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.oidc.title')}</h4>
          <p class="hint" style="margin-top:0">
            {tx('ds.oidc.intro', { api: <code>AssumeRoleWithWebIdentity</code>, url: <code>{redirectUrl()}</code> })}
          </p>
          <div class="grid2">
            <FormField label={t('ds.oidc.authUrl')}>{input(cfg.oidc.authUrl, (v) => props.onOidc({ authUrl: v }), { placeholder: 'https://accounts.google.com/o/oauth2/v2/auth' })}</FormField>
            <FormField label={t('ds.oidc.clientId')}>{input(cfg.oidc.clientId, (v) => props.onOidc({ clientId: v }), { autocomplete: 'off' })}</FormField>
            <FormField label={t('ds.oidc.scope')}>{input(cfg.oidc.scope, (v) => props.onOidc({ scope: v }))}</FormField>
            <FormField label={t('ds.oidc.extra')}>{input(cfg.oidc.extraParams, (v) => props.onOidc({ extraParams: v }))}</FormField>
            <FormField label={t('ds.oidc.roleArn')}>{input(cfg.oidc.roleArn, (v) => props.onOidc({ roleArn: v }), { placeholder: 'arn:aws:iam::123456789012:role/duckdive-readonly' })}</FormField>
            <FormField label={t('ds.oidc.duration')}>
              <input class="input" type="number" value={cfg.oidc.durationSeconds} onInput={(e) => props.onOidc({ durationSeconds: Number(e.currentTarget.value) || 3600 })} />
            </FormField>
            <FormField label={t('ds.oidc.stsEndpoint')}>
              {input(cfg.oidc.stsEndpoint, (v) => props.onOidc({ stsEndpoint: v }), { placeholder: `https://sts.${cfg.s3.region || 'ap-northeast-1'}.amazonaws.com/` })}
            </FormField>
          </div>
          <div class="row mt8">
            <button class="btn" disabled={authBusy || !isExtension} onClick={doSignIn}>
              {authBusy ? t('ds.oidc.signingIn') : t('ds.oidc.signIn')}
            </button>
            {props.creds ? (
              <span class="hint">
                {t('ds.oidc.signedIn', { as: props.creds.subject ? t('ds.oidc.as', { subject: props.creds.subject }) : '', min: expiresIn })}
                <button
                  class="btn ghost small"
                  onClick={async () => {
                    await storeCredentials(null);
                    props.onCreds(null);
                  }}
                >
                  {t('ds.oidc.signOut')}
                </button>
              </span>
            ) : (
              <span class="hint">{t('ds.oidc.notSignedIn', { ext: isExtension ? '' : t('ds.oidc.extOnly') })}</span>
            )}
          </div>
          {authError && <div class="alert error mt8">{authError}</div>}
        </>
      )}
    </div>
  );
}
