/** Bind dialog updates to the request the member is actually comparing. */
export function verificationUpdate(
  activeId: string,
  view: { id: string; phase: string },
): 'show' | 'finish' | 'ignore' | 'busy' {
  if (view.phase === 'done' || view.phase === 'cancelled') {
    return activeId === view.id ? 'finish' : 'ignore';
  }
  return activeId && activeId !== view.id ? 'busy' : 'show';
}
