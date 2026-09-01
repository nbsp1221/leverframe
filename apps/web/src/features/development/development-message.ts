export function normalizeWorkspacePaths(message: string): string {
  return message.replaceAll(/(?:\/[^\s)]+)+\/workspace\/([^\s)]+)/g, '$1');
}
