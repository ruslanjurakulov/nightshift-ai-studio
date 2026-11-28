/**
 * A credential ref as the tail of its GitHub secret name: upper case, every run of anything else one underscore, none at the
 * ends ("extinct-world" -> "EXTINCT_WORLD"). Mirrors modules/channel_credentials.env_var_name.
 *
 * Client-safe on purpose and holding no prefix: the new-channel wizard computes a name while the operator types the ref, from
 * the prefix its page passes (lib/server/github-secrets.ts CHANNEL_TOKEN_SECRET_PREFIX), so the prefix is not in a static chunk.
 */
export function secretRefSuffix(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
