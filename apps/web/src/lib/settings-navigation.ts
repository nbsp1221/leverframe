// Return paths are locale-neutral; the localized Link supplies the active locale.
export function settingsReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/decisions';
  }
  for (const character of value) {
    if (character.charCodeAt(0) <= 32) {
      return '/decisions';
    }
  }
  const url = new URL(value, 'https://leverframe.invalid');
  if (!/^\/(decisions|reviews|development)(\/|$)/.test(url.pathname)) {
    return '/decisions';
  }
  return `${url.pathname}${url.search}`;
}

export function connectionSettingsHref(returnTo: string): string {
  return settingsHref('connections', returnTo);
}

export function settingsHref(section: 'reviews' | 'connections', returnTo: string): string {
  return `/settings/${section}?${new URLSearchParams({ returnTo: settingsReturnPath(returnTo) })}`;
}
