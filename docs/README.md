# IAM setup for the OIDC sign-in

1. Create an OAuth client at your identity provider (Google: "Web application"; add
   `https://<extension-id>.chromiumapp.org/` as an authorized redirect URI).
2. In IAM, add an OpenID Connect identity provider for the issuer
   (Google: `https://accounts.google.com`, audience = the OAuth client ID).
3. Create a role with `iam-role-trust-policy.json` as the trust policy (adjust the
   provider ARN, audience and the email condition) and `iam-role-policy.json` as the
   permissions policy (bucket and prefix).
4. In the extension's Data source tab choose "Sign in (OIDC) → STS", enter the
   authorization endpoint, client ID and role ARN, then click "Sign in".

For Okta / Entra ID use the tenant's authorization endpoint and replace the
`accounts.google.com:*` condition keys with the provider's host
(e.g. `login.microsoftonline.com/<tenant>/v2.0:aud`).
