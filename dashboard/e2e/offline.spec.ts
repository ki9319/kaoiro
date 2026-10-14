// Issue #545: the offline section lists more agents than fit, and the operator
// must still reach the last tile with real input. The check is by wheel and
// hit test, never by scrollIntoView or Locator.click: an `overflow: hidden` box
// is scrollable by script, so those pass on a layout the user cannot scroll.
import { expect, test, type Locator, type Page } from "@playwright/test";

const APP = "/e2e/harness/index.html?view=app&offline=30&live=3";
const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

/** The element's centre is inside the viewport and is what a click there hits. */
function reachable(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    return el.contains(document.elementFromPoint(x, y));
  });
}

async function allReachable(locator: Locator): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    results.push(await reachable(locator.nth(index)));
  }
  return results;
}

async function boxes(locator: Locator): Promise<unknown[]> {
  const found: unknown[] = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    found.push(await locator.nth(index).boundingBox());
  }
  return found;
}

// Tiles rise in with a staggered animation (60 ms apart, 30 tiles); a position
// read before it ends is up to 0.6rem off.
async function waitForTilesToSettle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            !(animation instanceof CSSAnimation) ||
            !animation.animationName.includes("rise"),
        ),
  );
}

for (const size of SIZES) {
  test(`${size.name}: the last offline tile is reachable and nothing else moves`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(APP);

    const live = page.locator(".live-dashboard ul.agents > li");
    const offline = page.locator("details.offline");
    const summary = offline.locator("> summary");
    const tiles = offline.locator("ul.agents > li");
    const launch = page.locator("header").getByRole("button", { name: /起動/ });
    await expect(live).toHaveCount(3);
    await expect(offline).toBeVisible();
    // At narrow widths the centre of the summary is the restore-all button,
    // whose handler cancels the toggle: click the summary's left edge.
    await summary.click({ position: { x: 8, y: 8 } });
    await expect(offline).toHaveAttribute("open", "");
    // Without this the spec would pass on an empty page.
    await expect(tiles).toHaveCount(30);
    await waitForTilesToSettle(page);

    // Before any input: the live grid and the header control are usable, and
    // the list really does overflow, so reaching its end is a result of the
    // scroll. (At narrow widths the live region is short and scrolls its own
    // cards, so only the first live card is asserted reachable.)
    expect(await reachable(live.first())).toBe(true);
    expect(await reachable(launch)).toBe(true);
    expect(await reachable(tiles.last())).toBe(false);
    const liveBefore = await boxes(live);
    const regionsBefore = await boxes(page.locator(".live-dashboard, details.offline"));

    const first = await tiles.first().boundingBox();
    expect(first).not.toBeNull();
    await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
    for (let step = 0; step < 40; step += 1) await page.mouse.wheel(0, 400);
    await expect.poll(() => reachable(tiles.last())).toBe(true);

    const last = tiles.last();
    const lastBox = (await last.boundingBox())!;
    const offlineBox = (await offline.boundingBox())!;
    expect(lastBox.y).toBeGreaterThanOrEqual(offlineBox.y);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(offlineBox.y + offlineBox.height + 1);
    // The tile's own actions and the section's bulk actions stay usable.
    const lastButtons = await allReachable(last.getByRole("button"));
    expect(lastButtons.length).toBeGreaterThanOrEqual(2);
    expect(lastButtons.every(Boolean)).toBe(true);
    expect(await reachable(summary)).toBe(true);
    const bulk = await allReachable(summary.getByRole("button"));
    expect(bulk).toHaveLength(2);
    expect(bulk.every(Boolean)).toBe(true);

    // The rest of the page is where it was: no page scroll, the live cards and
    // both regions have not moved or resized, the first live card and the
    // header control are still usable, the two regions do not overlap, and the
    // offline section keeps its half-height cap.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
    expect(await boxes(live)).toEqual(liveBefore);
    expect(await boxes(page.locator(".live-dashboard, details.offline"))).toEqual(regionsBefore);
    expect(await reachable(live.first())).toBe(true);
    expect(await reachable(launch)).toBe(true);
    const liveRegion = (await page.locator(".live-dashboard").boundingBox())!;
    expect(liveRegion.y + liveRegion.height).toBeLessThanOrEqual(offlineBox.y + 1);
    const dashboard = (await page.locator(".dashboard").boundingBox())!;
    expect(offlineBox.height).toBeLessThanOrEqual(dashboard.height / 2 + 1);
  });
}
