import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsDialog, settingsTabTarget } from "../src/settings.js";

function markup(category: "General" | "Access tokens", busy = false) {
  return renderToStaticMarkup(
    <SettingsDialog
      open
      busy={busy}
      category={category}
      onCategory={() => {}}
      onClose={() => {}}
      secretPending
      error="Example request failure"
      panels={{
        General: <p>Browser content</p>,
        "Access tokens": <input value="fixture-only-secret" readOnly />,
        "OAuth authorizations": <p>OAuth content</p>,
        "Recently deleted": <p>Recovery content</p>,
      }}
    />,
  );
}

describe("Settings categories", () => {
  it("keeps four labeled panels mounted with only the selected one visible", () => {
    const html = markup("General");
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/hidden=""/g)).toHaveLength(3);
    expect(html.match(/role="tab"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(
      [...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["General", "Tokens", "OAuth", "Trash"]);
    expect(html).toContain("OAuth content");
    expect(html).toContain("Recovery content");
    expect(html).toContain("fixture-only-secret");
    expect(html).toContain("Return to copy token");
    expect(html).toContain("Example request failure");
    expect(html).toContain('aria-label="Close Pinboard Settings"');
    expect(html).toContain('title="Close Pinboard Settings"');
    expect(html).toContain("<h2>Pinboard Settings</h2>");
    expect(markup("Access tokens")).not.toContain("Return to copy token");
  });
  it("keeps pending operation and request feedback visible across categories", () => {
    const html = markup("Access tokens", true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Settings cannot close yet.");
    expect(html).toContain('role="alert"');
  });
  it.each([false, true])(
    "supports oriented arrows, wrapping, Home and End: horizontal=%s",
    (horizontal) => {
      expect(
        settingsTabTarget(
          horizontal ? "ArrowRight" : "ArrowDown",
          3,
          horizontal,
        ),
      ).toBe(0);
      expect(
        settingsTabTarget(horizontal ? "ArrowLeft" : "ArrowUp", 0, horizontal),
      ).toBe(3);
      expect(settingsTabTarget("Home", 2, horizontal)).toBe(0);
      expect(settingsTabTarget("End", 0, horizontal)).toBe(3);
      expect(
        settingsTabTarget(
          horizontal ? "ArrowDown" : "ArrowRight",
          1,
          horizontal,
        ),
      ).toBeNull();
      expect(settingsTabTarget("Tab", 1, horizontal)).toBeNull();
    },
  );
});
