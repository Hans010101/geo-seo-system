export function isOperatorAuthorized(
  request: Request,
  env: { CLOUDFLARE_OPERATOR_TOKEN?: string },
): boolean {
  const token =
    request.headers.get("x-operator-token") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(env.CLOUDFLARE_OPERATOR_TOKEN && token === env.CLOUDFLARE_OPERATOR_TOKEN);
}
