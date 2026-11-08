export function getAlertSourceUrl(description: string | null | undefined): string | null {
  const source = description?.match(/(?:^|\n)\s*原文[：:]\s*(https?:\/\/[^\s<>]+)/i)?.[1];
  if (!source) return null;
  try {
    const url = new URL(source);
    return !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
