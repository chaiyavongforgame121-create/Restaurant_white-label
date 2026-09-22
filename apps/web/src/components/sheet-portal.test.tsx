import * as React from 'react';
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MotionGlobalConfig } from 'framer-motion';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogProvider, Sheet, ThemeProvider, useConfirm } from '@favornoms/ui';

// The shared Sheet is tested here rather than in packages/ui because this is the workspace
// with a DOM test environment, and the storefront is where a portalled sheet has the most to
// lose: every item, combo and chat sheet has to keep the tenant's colours.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root | null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Exit animations finish at once, so "closed" means gone without waiting on a spring.
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

function render(ui: React.ReactElement) {
  root = createRoot(container);
  act(() => root!.render(ui));
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

/** The row the admin Orders table puts its Receipt button in: sticky, with its own z-index. */
function StickyRow({ children, onRowClick }: { children: React.ReactNode; onRowClick?: () => void }) {
  return (
    <table>
      <tbody>
        <tr onClick={onRowClick}>
          <td data-testid="cell" style={{ position: 'sticky', right: 0, zIndex: 10 }}>
            {children}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

describe('Sheet portal', () => {
  it('renders an open sheet on the body, not inside the sticky cell that opened it', () => {
    render(
      <StickyRow>
        <Sheet open onClose={() => {}} ariaLabel="Receipt">
          <p>lines</p>
        </Sheet>
      </StickyRow>,
    );
    const cell = container.querySelector('[data-testid="cell"]')!;
    const sheet = dialog();
    expect(sheet).not.toBeNull();
    expect(cell.contains(sheet)).toBe(false);
    expect(sheet!.parentElement!.parentElement).toBe(document.body);
    expect(sheet!.getAttribute('aria-modal')).toBe('true');
    expect(sheet!.getAttribute('aria-label')).toBe('Receipt');
  });

  it('leaves nothing on the body while closed, and removes itself once it closes', async () => {
    const before = document.body.childElementCount;
    render(
      <Sheet open={false} onClose={() => {}}>
        <p>lines</p>
      </Sheet>,
    );
    expect(document.body.childElementCount).toBe(before);

    act(() =>
      root!.render(
        <Sheet open onClose={() => {}}>
          <p>lines</p>
        </Sheet>,
      ),
    );
    expect(dialog()).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    act(() =>
      root!.render(
        <Sheet open={false} onClose={() => {}}>
          <p>lines</p>
        </Sheet>,
      ),
    );
    // Even a skipped exit animation completes on a later frame, not synchronously, and
    // AnimatePresence only lets the portal go once it has.
    for (let frame = 0; frame < 30 && dialog(); frame++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
    }
    expect(dialog()).toBeNull();
    expect(document.body.childElementCount).toBe(before);
    expect(document.body.style.overflow).toBe('');
  });

  it("carries the tenant's theme variables out to the portalled sheet", () => {
    render(
      // An explicit mode: 'system' would ask matchMedia, which jsdom does not have.
      <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }} defaultMode="light">
        <ThemeProvider theme={{ primaryColor: '#123456' }}>
          <Sheet open onClose={() => {}}>
            <p>lines</p>
          </Sheet>
        </ThemeProvider>
      </ThemeProvider>,
    );
    const providers = container.querySelectorAll<HTMLElement>('div.contents');
    expect(providers).toHaveLength(2);
    const outer = providers[0]!;
    const inner = providers[1]!;
    const wrapper = dialog()!.parentElement!;
    // The nearest provider's colour wins; what it does not set still comes from the root.
    expect(wrapper.style.getPropertyValue('--primary')).toBe(inner.style.getPropertyValue('--primary'));
    expect(wrapper.style.getPropertyValue('--primary')).not.toBe(outer.style.getPropertyValue('--primary'));
    expect(wrapper.style.getPropertyValue('--accent')).toBe(outer.style.getPropertyValue('--accent'));
    expect(wrapper.style.getPropertyValue('--accent')).not.toBe('');
  });

  it("keeps a click inside the sheet from reaching the row's own onClick", () => {
    const onRowClick = vi.fn();
    const onClose = vi.fn();
    const onPrint = vi.fn();
    render(
      <StickyRow onRowClick={onRowClick}>
        <Sheet open onClose={onClose}>
          <button type="button" onClick={onPrint}>
            Print
          </button>
        </Sheet>
      </StickyRow>,
    );
    act(() => document.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();

    // The backdrop still closes the sheet, and still does not count as a click on the row.
    const backdrop = dialog()!.firstElementChild as HTMLElement;
    act(() => backdrop.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('still closes only the topmost sheet on Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const stacked = (innerOpen: boolean) => (
      <Sheet open onClose={closeOuter}>
        <Sheet open={innerOpen} onClose={closeInner}>
          <input aria-label="field" />
        </Sheet>
      </Sheet>
    );
    // Opened one after the other, the way a picker is opened over a form.
    render(stacked(false));
    act(() => root!.render(stacked(true)));
    const input = document.querySelector('input')!;
    // Dispatched from inside the sheet, so it has to bubble out of the portal to the window
    // listener: the click guard must not swallow keys.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('puts a confirm asked from inside a sheet above that sheet', async () => {
    function AskFromSheet() {
      const confirm = useConfirm();
      return (
        <Sheet open onClose={() => {}} ariaLabel="Drawer">
          <button type="button" onClick={() => void confirm({ title: 'Refund this order?' })}>
            Refund
          </button>
        </Sheet>
      );
    }
    render(
      <DialogProvider>
        <AskFromSheet />
      </DialogProvider>,
    );
    act(() => document.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    const sheet = document.querySelector('[aria-label="Drawer"]')!;
    const question = document.querySelector('[aria-label="Refund this order?"]')!;
    expect(question).not.toBeNull();
    // Both are z-[100] on the body, so the later one in the page is the one on top.
    expect(sheet.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question.parentElement!.parentElement).toBe(document.body);
  });

  it('answers a confirm asked from inside a sheet on Escape, and leaves the sheet open', async () => {
    // The dish editor: a sheet holding a draft, whose "remove group" asks first. Escape on that
    // question used to close the editor too, and the unsaved dish went with it.
    const closeSheet = vi.fn();
    const screenShortcut = vi.fn();
    const answers: boolean[] = [];
    function Editor() {
      const confirm = useConfirm();
      return (
        <Sheet open onClose={closeSheet} ariaLabel="Editor">
          <button
            type="button"
            onClick={() => void confirm({ title: 'Remove this group?' }).then((ok) => answers.push(ok))}
          >
            Remove
          </button>
        </Sheet>
      );
    }
    // A screen's own window shortcut, like the counter's and the kitchen's Escape.
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') screenShortcut();
    };
    window.addEventListener('keydown', onWindowKey);
    try {
      render(
        <DialogProvider>
          <Editor />
        </DialogProvider>,
      );
      act(() => document.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
      const question = document.querySelector<HTMLElement>('[aria-label="Remove this group?"]')!;
      expect(question).not.toBeNull();

      // Pressed with focus inside the question, as it is in the app.
      await act(async () => {
        question.querySelector('button')!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });
      expect(answers).toEqual([false]);
      expect(document.querySelector('[aria-label="Remove this group?"]')).toBeNull();
      expect(closeSheet).not.toHaveBeenCalled();
      expect(screenShortcut).not.toHaveBeenCalled();
      expect(document.querySelector('[aria-label="Editor"]')).not.toBeNull();

      // With the question gone, Escape is the sheet's again.
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(closeSheet).toHaveBeenCalledTimes(1);
      expect(screenShortcut).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('hydrates an open sheet without a mismatch, then shows it on the body', () => {
    const ui = (
      <StickyRow>
        <Sheet open onClose={() => {}} ariaLabel="Receipt">
          <p>lines</p>
        </Sheet>
      </StickyRow>
    );
    const html = renderToString(ui);
    // Nothing of the overlay in the server's HTML: there is no body to portal into there.
    expect(html).not.toContain('role="dialog"');
    container.innerHTML = html;

    const onRecoverableError = vi.fn();
    act(() => {
      root = hydrateRoot(container, ui, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(container.contains(dialog())).toBe(false);
  });
});
