/** The clock the screens read. The browser mock freezes it so the demo content never ages. */
let source: () => number = Date.now;

export const now = (): number => source();

export function setClock(next: () => number): void {
  source = next;
}
