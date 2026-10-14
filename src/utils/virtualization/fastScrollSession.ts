const VIRTUAL_FAST_SCROLL_ACTIVE_ATTRIBUTE = 'data-virtual-fast-scroll-active';
const VIRTUAL_FAST_SCROLL_OWNER_ATTRIBUTE = 'data-virtual-fast-scroll-owner';
export const VIRTUAL_FAST_SCROLL_START_EVENT = 'versora:virtual-fast-scroll-start';
export const VIRTUAL_FAST_SCROLL_END_EVENT = 'versora:virtual-fast-scroll-end';

export type VirtualFastScrollOwner = 'minimap' | 'implicit';

export function isVirtualFastScrollSessionActive(element: HTMLElement | null | undefined): boolean {
  return element?.getAttribute(VIRTUAL_FAST_SCROLL_ACTIVE_ATTRIBUTE) === 'true';
}

export function getVirtualFastScrollOwner(element: HTMLElement | null | undefined): VirtualFastScrollOwner | null {
  const owner = element?.getAttribute(VIRTUAL_FAST_SCROLL_OWNER_ATTRIBUTE);
  return owner === 'minimap' || owner === 'implicit' ? owner : null;
}

export function beginVirtualFastScrollSession(element: HTMLElement, owner: VirtualFastScrollOwner): void {
  const currentOwner = getVirtualFastScrollOwner(element);
  if (isVirtualFastScrollSessionActive(element) && currentOwner === owner) return;
  if (currentOwner) endVirtualFastScrollSession(element, currentOwner);
  element.setAttribute(VIRTUAL_FAST_SCROLL_ACTIVE_ATTRIBUTE, 'true');
  element.setAttribute(VIRTUAL_FAST_SCROLL_OWNER_ATTRIBUTE, owner);
  element.dispatchEvent(new Event(VIRTUAL_FAST_SCROLL_START_EVENT));
}

export function endVirtualFastScrollSession(element: HTMLElement, owner: VirtualFastScrollOwner): void {
  if (getVirtualFastScrollOwner(element) !== owner) return;
  element.removeAttribute(VIRTUAL_FAST_SCROLL_ACTIVE_ATTRIBUTE);
  element.removeAttribute(VIRTUAL_FAST_SCROLL_OWNER_ATTRIBUTE);
  element.dispatchEvent(new Event(VIRTUAL_FAST_SCROLL_END_EVENT));
}

export function clearVirtualFastScrollSession(element: HTMLElement, owner: VirtualFastScrollOwner): void {
  if (getVirtualFastScrollOwner(element) !== owner) return;
  element.removeAttribute(VIRTUAL_FAST_SCROLL_ACTIVE_ATTRIBUTE);
  element.removeAttribute(VIRTUAL_FAST_SCROLL_OWNER_ATTRIBUTE);
}
