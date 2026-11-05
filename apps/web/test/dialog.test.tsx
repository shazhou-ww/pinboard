import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/dialog.js";

const surface = {
  getBoundingClientRect: () => ({
    left: 100,
    top: 100,
    right: 500,
    bottom: 400,
  }),
};
const pointer = (
  x: number,
  y: number,
  target: object = surface,
  button = 0,
) => ({
  clientX: x,
  clientY: y,
  currentTarget: surface,
  target,
  button,
});
type DialogHandlers = {
  onPointerDown: (event: ReturnType<typeof pointer>) => void;
  onPointerCancel: () => void;
  onClick: (event: ReturnType<typeof pointer>) => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
  onCancel: (event: { preventDefault: () => void }) => void;
};

function renderDialog({ busy = false, dismissOnOutsideClick = true } = {}) {
  const onClose = vi.fn();
  let node: ReactNode = null;
  function Probe() {
    node = Dialog({
      open: true,
      title: "Pin details",
      busy,
      dismissOnOutsideClick,
      onClose,
      children: <p>Pin content</p>,
    });
    return node;
  }
  const html = renderToStaticMarkup(<Probe />);
  const handlers = (element: ReactNode) => {
    if (!isValidElement<DialogHandlers>(element))
      throw new Error("Missing dialog.");
    return element.props;
  };
  return { html, onClose, ...handlers(node) };
}

describe("dialog dismissal", () => {
  it("dismisses only when a primary pointer starts and ends on the backdrop", () => {
    const dialog = renderDialog();
    const event = pointer(10, 10);
    dialog.onPointerDown(event);
    dialog.onClick(event);
    expect(dialog.onClose).toHaveBeenCalledOnce();
    dialog.onClick(event);
    expect(dialog.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["padding", pointer(105, 105), pointer(105, 105)],
    ["content", pointer(200, 200, {}), pointer(200, 200, {})],
    ["dragging out", pointer(200, 200), pointer(10, 10)],
    ["dragging in", pointer(10, 10), pointer(200, 200)],
    ["right click", pointer(10, 10, surface, 2), pointer(10, 10, surface, 2)],
  ])("does not dismiss on %s", (_label, down, up) => {
    const dialog = renderDialog();
    dialog.onPointerDown(down);
    dialog.onClick(up);
    expect(dialog.onClose).not.toHaveBeenCalled();
  });

  it("clears a cancelled outside gesture", () => {
    const dialog = renderDialog();
    const event = pointer(10, 10);
    dialog.onPointerDown(event);
    dialog.onPointerCancel();
    dialog.onClick(event);
    expect(dialog.onClose).not.toHaveBeenCalled();
  });

  it.each([{ busy: true }, { dismissOnOutsideClick: false }])(
    "keeps dismissal opt-in and protects pending writes: %o",
    (options) => {
      const dialog = renderDialog(options);
      const event = pointer(10, 10);
      dialog.onPointerDown(event);
      dialog.onClick(event);
      expect(dialog.onClose).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves Escape and native cancel busy=%s",
    (busy) => {
      const dialog = renderDialog({ busy });
      const preventDefault = vi.fn();
      dialog.onKeyDown({ key: "Escape", preventDefault });
      dialog.onCancel({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(dialog.onClose).toHaveBeenCalledTimes(busy ? 0 : 2);
      expect(dialog.html).toContain(`aria-busy="${busy}"`);
      dialog.onKeyDown({ key: "Enter", preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(2);
    },
  );
});
