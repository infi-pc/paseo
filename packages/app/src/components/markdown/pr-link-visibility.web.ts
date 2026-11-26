const listeners = new WeakMap<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

export function observePrLink(element: Element, onVisibility: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") return () => {};
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  });
  listeners.set(element, onVisibility);
  observer.observe(element);
  return () => {
    listeners.delete(element);
    observer?.unobserve(element);
  };
}
