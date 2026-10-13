'use client';

const prompts = new Map<symbol, { message: string; onDiscard: (() => void) | undefined }>();
let installed = false;

function onAnchorClick(event: MouseEvent) {
  if (event.defaultPrevented || prompts.size === 0 || !(event.target instanceof Element)) {
    return;
  }
  const anchor = event.target.closest('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || !href || href.startsWith('#') || anchor.target === '_blank') {
    return;
  }
  if (!confirmDirtyNavigation()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

export function registerDirtyNavigation(prompt: string, onDiscard?: () => void) {
  const token = Symbol('dirty-navigation');
  prompts.set(token, { message: prompt, onDiscard });
  if (!installed) {
    window.addEventListener('click', onAnchorClick, true);
    installed = true;
  }
  return () => {
    prompts.delete(token);
    if (prompts.size === 0) {
      window.removeEventListener('click', onAnchorClick, true);
      installed = false;
    }
  };
}

export function confirmDirtyNavigation(): boolean {
  const prompt = prompts.values().next().value;
  if (prompt === undefined) {
    return true;
  }
  if (!window.confirm(prompt.message)) {
    return false;
  }
  for (const entry of prompts.values()) {
    entry.onDiscard?.();
  }
  return true;
}
