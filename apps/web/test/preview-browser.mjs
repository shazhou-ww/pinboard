// Optional real-browser checks against the isolated Worker fixture (never production).
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:5191";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const output = resolve(
  process.env.PREVIEW_EVIDENCE ?? ".browser-tools/evidence",
);
await mkdir(output, { recursive: true });
process.env.TEMP = process.env.TMP = resolve(".browser-tools");
const { chromium } = await import(
  pathToFileURL(
    resolve(
      process.env.PLAYWRIGHT_MODULE ??
        ".browser-tools/node_modules/playwright-core/index.mjs",
    ),
  ).href
);
const browser = await chromium.launchPersistentContext(
  resolve(".browser-tools/profile-checks"),
  {
    executablePath:
      process.env.BROWSER_EXECUTABLE ??
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    viewport: { width: 1280, height: 900 },
    downloadsPath: resolve(".browser-tools/downloads"),
  },
);
const results = [];
const check = (name, detail) => results.push({ name, detail });
const pinData = await (await fetch(`${origin}/api/pins`)).json();
const portrait = pinData.pins.find((pin) => pin.name === "Portrait paper.pdf");
const landscape = pinData.pins.find(
  (pin) => pin.name === "Landscape paper.pdf",
);
const { publications } = await (
  await fetch(`${origin}/api/publications`)
).json();
const publication = publications.find(
  (item) => item.title === "Published portrait paper",
);
assert(portrait && landscape && publication);
const page = await browser.newPage();

async function loadedImages(scope) {
  await scope.locator("img").first().waitFor({ state: "visible" });
  await scope.locator("img").evaluateAll(async (images) => {
    await Promise.all(images.map((image) => image.decode()));
  });
}
async function paperGeometry(scope, label, withInfo = true) {
  const measurements = await scope.evaluate((root) => {
    const rect = (element) => element.getBoundingClientRect().toJSON();
    const image = root.querySelector(".preview-paper img");
    const badge = root.querySelector(".preview-type-badge");
    const paper = root.querySelector(".preview-paper");
    const info = root.querySelector(".pin-info");
    const publicationBadge = root.querySelector(".publication-badge");
    const isCard = root.matches(".pin-card");
    return {
      viewport: {
        width: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      },
      card: isCard ? rect(root) : null,
      grid: isCard ? rect(root.parentElement) : null,
      maxTrackWidth: isCard
        ? Math.max(
            ...getComputedStyle(root.parentElement)
              .gridTemplateColumns.split(" ")
              .map(Number.parseFloat),
          )
        : null,
      image: rect(image),
      badge: rect(badge),
      paper: rect(paper),
      info: info && rect(info),
      publicationBadge: publicationBadge && rect(publicationBadge),
      ratio: image.naturalWidth / image.naturalHeight,
      filter: getComputedStyle(image).filter,
      objectFit: getComputedStyle(image).objectFit,
    };
  });
  const {
    image,
    badge,
    paper,
    info,
    publicationBadge,
    ratio,
    viewport,
    card,
    grid,
    maxTrackWidth,
  } = measurements;
  assert(
    viewport.documentScrollWidth <= viewport.documentClientWidth,
    `${label}: document overflow`,
  );
  assert(
    viewport.bodyScrollWidth <= viewport.bodyClientWidth,
    `${label}: body overflow`,
  );
  if (card) {
    assert(
      card.left >= 0 && card.right <= viewport.width,
      `${label}: card outside viewport`,
    );
    assert(
      card.left >= grid.left - 0.5 && card.right <= grid.right + 0.5,
      `${label}: card outside grid`,
    );
    assert(
      card.width <= maxTrackWidth + 0.5,
      `${label}: card wider than its grid track`,
    );
    for (const [part, rect] of Object.entries({ paper, info })) {
      assert(
        rect.left >= card.left && rect.right <= card.right,
        `${label}: ${part} outside card`,
      );
      assert(
        rect.left >= 0 && rect.right <= viewport.width,
        `${label}: ${part} outside viewport`,
      );
    }
  }
  assert(image.width > 20 && image.height > 20, label);
  assert(
    Math.abs((image.width - 2) / (image.height - 2) - ratio) < 0.02,
    `${label}: page aspect`,
  );
  assert(
    image.top >= badge.bottom && image.bottom <= paper.bottom,
    `${label}: header and footer`,
  );
  assert(
    image.left >= paper.left && image.right <= paper.right,
    `${label}: horizontal bounds`,
  );
  assert.equal(measurements.objectFit, "contain");
  assert.equal(measurements.filter, "none");
  if (withInfo)
    assert(
      image.bottom <= info.top && badge.bottom <= info.top,
      `${label}: information band`,
    );
  if (publicationBadge)
    assert(badge.right < publicationBadge.left, `${label}: independent badges`);
  check(label, measurements);
}
async function noFailureUi(scope) {
  assert(
    !/unable to load|preview failed|preview unavailable|retry|retry scheduled/i.test(
      await scope.innerText(),
    ),
  );
  assert.equal(await scope.locator('[role="alert"]').count(), 0);
}

try {
  await page.goto(origin);
  await page.getByPlaceholder("Filter items...").fill("paper");
  await page.locator(".pin-card").first().waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".pin-card").length === 3,
  );
  const cards = page.locator(".pin-card");
  for (let i = 0; i < 3; i++) {
    const card = cards.nth(i);
    await loadedImages(card);
    await paperGeometry(card, `desktop-${i}`);
    await card.locator(".pin-info").hover();
    await page.waitForTimeout(250);
    await paperGeometry(card, `hover-expanded-${i}`);
    await card.locator(".pin-info").focus();
    await page.waitForTimeout(250);
    await paperGeometry(card, `keyboard-expanded-${i}`);
  }
  await page.screenshot({ path: resolve(output, "desktop-paper.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await paperGeometry(cards.first(), "dark-OS-preference");
  // The application currently ships light palettes only. This is a declared
  // dark-surface stress fixture, not a claim that a dark theme was added.
  await page.addStyleTag({
    content:
      ":root, :root[data-background] { --surface:#20242c; --subtle:#292f39; --text:#edf0f7; --muted:#c0c7d7; --border:#596273; --background-start:#181c24; --background-end:#181c24; --background-light:#20242c; --background-wash:#20242c; }",
  });
  assert.equal(
    await page
      .locator(".pin-preview.has-paper")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgb(41, 47, 57)",
  );
  for (let i = 0; i < 3; i++)
    await paperGeometry(cards.nth(i), `simulated-dark-surface-${i}`);
  await page.screenshot({ path: resolve(output, "dark-surface-fixture.png") });

  await page.goto(origin);
  await page.getByPlaceholder("Filter items...").fill("Portrait paper");
  await page.waitForFunction(
    () => document.querySelectorAll(".pin-card").length === 2,
  );
  const pinCard = page.locator(".pin-card").filter({
    has: page.locator(".pin-name", { hasText: "Portrait paper.pdf" }),
  });
  await pinCard.locator(".pin-open").click();
  const node = page.locator(".node-description-editor");
  await loadedImages(node);
  await paperGeometry(node, "private-node-details", false);
  const pdfImage = node.locator("img");
  await pdfImage.dispatchEvent("error");
  await node.locator('[aria-label="PDF preview"]').waitFor();
  await noFailureUi(node);
  await pdfImage.dispatchEvent("load");
  await pdfImage.waitFor({ state: "visible" });
  check(
    "node-error-and-successful-load",
    "Shared renderer returns to paper; no failure UI.",
  );
  const nodePath = `**/api/pins/${portrait.cid}/nodes/${portrait.cid}/description`;
  for (const status of [409, 403]) {
    await page.route(nodePath, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status, json: { error: `Synthetic save ${status}` } })
        : route.continue(),
    );
    await node.getByRole("button", { name: "Save description" }).click();
    await node.getByText(`Synthetic save ${status}`).waitFor();
    assert.equal(
      await node.locator(".pin-preview").count(),
      status === 409 ? 1 : 0,
    );
    check(
      `node-save-${status}`,
      status === 409
        ? "Conflict preserves editable data."
        : "Forbidden clears old preview.",
    );
    await page.unroute(nodePath);
  }

  const savedNode = await (
    await fetch(
      `${origin}/api/pins/${portrait.cid}/nodes/${portrait.cid}/description`,
    )
  ).json();
  for (const failure of [
    "500",
    "network",
    "401",
    "403",
    "404",
    "invalid",
    "malformed-json",
  ]) {
    let failPoll = false;
    let initialReads = 0;
    let failedReads = 0;
    await page.route(nodePath, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      if (!failPoll) {
        initialReads++;
        return route.fulfill({
          json: {
            ...savedNode,
            description: {
              ...savedNode.description,
              preview: {
                ...savedNode.description.preview,
                status: "pending",
                preview: null,
                truncated: false,
              },
            },
          },
        });
      }
      failedReads++;
      if (failure === "network") return route.abort("connectionreset");
      if (failure === "malformed-json")
        return route.fulfill({ contentType: "application/json", body: "{" });
      if (failure === "invalid")
        return route.fulfill({
          json: {
            ...savedNode,
            description: {
              ...savedNode.description,
              preview: {
                ...savedNode.description.preview,
                status: "ready",
                preview: null,
              },
            },
          },
        });
      return route.fulfill({
        status: Number(failure),
        json: { error: `Synthetic poll ${failure}` },
      });
    });
    await page.goto(origin);
    await page.getByPlaceholder("Filter items...").fill("Portrait paper");
    await page.waitForFunction(
      () => document.querySelectorAll(".pin-card").length === 2,
    );
    await pinCard.locator(".pin-open").click();
    const editor = page.locator(".node-description-editor");
    const textarea = editor.getByRole("textbox", {
      name: "User description (optional, plain text)",
    });
    await textarea.fill(`Unsaved draft survives ${failure}`);
    failPoll = true;
    await editor.getByRole("alert").waitFor();
    assert(
      initialReads >= 1,
      `node-poll-${failure}: initially loaded pending data`,
    );
    assert.equal(
      failedReads,
      1,
      `node-poll-${failure}: a background poll followed the initial pending response`,
    );
    if (failure === "500" || failure === "network") {
      assert(
        await textarea.isVisible(),
        `node-poll-${failure}: editable form remains`,
      );
      assert.equal(
        await textarea.inputValue(),
        `Unsaved draft survives ${failure}`,
      );
      assert.equal(await editor.locator(".pin-preview").count(), 1);
      check(`node-poll-${failure}`, {
        initialReads,
        failedReads,
        formVisible: true,
        draftRetained: true,
      });
    } else {
      assert.equal(await textarea.count(), 0);
      assert.equal(await editor.locator(".pin-preview").count(), 0);
      check(`node-poll-${failure}`, {
        initialReads,
        failedReads,
        formVisible: false,
        oldPreviewRetained: false,
      });
    }
    await page.unroute(nodePath);
  }

  await page.goto(`${origin}/p/${publication.id}`);
  await loadedImages(page.locator(".publication-page .pin-preview"));
  await paperGeometry(
    page.locator(".publication-page .pin-preview"),
    "public-publication-node",
    false,
  );
  await page
    .locator(".publication-page .pin-preview img")
    .dispatchEvent("error");
  await page
    .locator(".publication-page .pin-preview [aria-label='PDF preview']")
    .waitFor();
  await noFailureUi(page.locator(".publication-page .pin-preview"));
  check("public-node-image-error", "PDF type cover, not an error screen.");

  // Block real thumbnail requests: this exercises a browser network error, not
  // just synthetic event dispatch. It does not change the stored descriptor.
  await page.route("**/ipfs/**", (route) => route.abort());
  await page.goto(origin);
  await page.getByPlaceholder("Filter items...").fill("paper");
  await page.locator(".pin-card .preview-type-cover").first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".pin-card .preview-type-cover").length === 3,
  );
  await noFailureUi(page.locator(".pin-wall"));
  await page.screenshot({ path: resolve(output, "image-load-fallback.png") });
  await page.unroute("**/ipfs/**");
  await page.reload();
  await page.getByPlaceholder("Filter items...").fill("paper");
  await page.waitForFunction(
    () => document.querySelectorAll(".pin-card").length === 3,
  );
  await loadedImages(page.locator(".pin-wall"));
  check(
    "pin-network-failure-and-reload",
    "All 3 PDF cards fall back; fresh mount recovers without persisted failure.",
  );

  const publicPreviewPath = `**/api/public/publications/${publication.id}/preview/1`;
  for (const [status, response, message] of [
    [
      200,
      {
        version: 3,
        status: "ready",
        contentType: "application/pdf",
        preview: null,
        truncated: false,
      },
      "Invalid preview response",
    ],
    [
      401,
      { error: "Synthetic authorization expired" },
      "Synthetic authorization expired",
    ],
    [403, { error: "Synthetic forbidden" }, "Synthetic forbidden"],
    [
      404,
      { error: "Synthetic publication missing" },
      "Synthetic publication missing",
    ],
  ]) {
    await page.route(publicPreviewPath, (route) =>
      route.fulfill({ status, json: response }),
    );
    await page.goto(origin);
    await page.getByPlaceholder("Filter items...").fill("Published portrait");
    await page.waitForFunction(
      () => document.querySelectorAll(".pin-card").length === 1,
    );
    const cover = page.locator(".pin-card .pin-preview");
    await cover.getByText(message).waitFor();
    assert.equal(await cover.locator(".preview-type-cover, img").count(), 0);
    check(
      `public-api-${status}`,
      "Rejected as an API error, not a successful type cover.",
    );
    await page.unroute(publicPreviewPath);
  }

  // Same real thumbnail, alternate source semantics, and changed material
  // identity are tested through the actual shared React component.
  await page.evaluate(async () => {
    const ReactModule = await import("/node_modules/.vite/deps/react.js");
    const ReactDOM =
      await import("/node_modules/.vite/deps/react-dom_client.js");
    const React = ReactModule.default ?? ReactModule;
    const { createRoot } = ReactDOM.default ?? ReactDOM;
    const { PreviewContent, previewClassName } =
      await import("/src/pin-preview.tsx");
    const host = document.createElement("section");
    host.id = "material-check";
    document.body.replaceChildren(host);
    const root = createRoot(host);
    window.renderMaterial = (value) =>
      root.render(
        React.createElement(
          "div",
          {
            className: previewClassName(value),
          },
          React.createElement(PreviewContent, {
            preview: value,
            name: "same source material",
          }),
        ),
      );
  });
  const descriptor = await (
    await fetch(`${origin}/api/pins/${portrait.cid}/preview`)
  ).json();
  for (const contentType of ["image/jpeg", null, "video/mp4"]) {
    await page.evaluate((value) => window.renderMaterial(value), {
      ...descriptor,
      contentType,
    });
    await loadedImages(page.locator("#material-check"));
    assert.equal(await page.locator(".preview-paper").count(), 0);
    check(
      `material-with-${contentType ?? "unknown"}-source`,
      "Valid image shown without PDF decoration.",
    );
  }
  await page.evaluate((value) => window.renderMaterial(value), descriptor);
  await page.locator("#material-check .preview-paper").waitFor();
  await loadedImages(page.locator("#material-check"));
  await page.waitForTimeout(100);
  await page.locator("#material-check img").dispatchEvent("error");
  await page.locator("#material-check [aria-label='PDF preview']").waitFor();
  const otherDescriptor = await (
    await fetch(`${origin}/api/pins/${landscape.cid}/preview`)
  ).json();
  await page.evaluate((value) => window.renderMaterial(value), otherDescriptor);
  await loadedImages(page.locator("#material-check"));
  assert.equal(await page.locator(".preview-type-cover").count(), 0);
  check(
    "image-identity-recovery",
    "A different material CID/URL remounts and loads normally.",
  );
} finally {
  await browser.close();
}

const touch = await chromium.launchPersistentContext(
  resolve(".browser-tools/profile-touch"),
  {
    executablePath:
      process.env.BROWSER_EXECUTABLE ??
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    downloadsPath: resolve(".browser-tools/downloads"),
  },
);
try {
  const page = await touch.newPage();
  await page.goto(origin);
  await page.getByPlaceholder("Filter items...").fill("paper");
  await page.waitForFunction(
    () => document.querySelectorAll(".pin-card").length === 3,
  );
  const cards = page.locator(".pin-card");
  for (let i = 0; i < 3; i++) {
    await cards.nth(i).scrollIntoViewIfNeeded();
    await loadedImages(cards.nth(i));
    await paperGeometry(cards.nth(i), `narrow-touch-expanded-${i}`);
  }
  await cards.first().scrollIntoViewIfNeeded();
  await page.evaluate(() => document.body.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, "narrow-touch.png") });
  await page.setViewportSize({ width: 320, height: 720 });
  for (let i = 0; i < 3; i++)
    await paperGeometry(cards.nth(i), `small-320px-touch-${i}`);
  await page.evaluate(() => document.body.scrollTo(0, 0));
  await page.screenshot({ path: resolve(output, "small-320px-touch.png") });
} finally {
  await touch.close();
}
await writeFile(
  resolve(output, "browser-results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(`PASS ${results.length} browser checks; evidence: ${output}`);
