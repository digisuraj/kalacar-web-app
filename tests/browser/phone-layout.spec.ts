import { expect, test } from "@playwright/test";
import { mockShop } from "./mock-shop";

// Pages must fit a small phone with no sideways scroll, and every page has the shop footer.
const USER = { id: "u1", name: "Test Buyer", email: "buyer@example.test", phone: "9876543210" };
const PAGES = ["/", "/cart", "/products/krushna", "/account", "/about"];

for (const width of [360, 390]) {
  test(`no page scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockShop(page, { user: USER });
    await page.addInitScript(() => localStorage.setItem("kalacar-demo-cart-v1", JSON.stringify([{ id: "krushna", variantId: "gold", quantity: 2 }])));
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      await page.waitForTimeout(300);
      // Everything in the top bar, including the menu button, sits fully on screen.
      const cut = await page.evaluate(() => [...document.querySelectorAll("main > header *")].filter(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.right > document.documentElement.clientWidth + 1 || box.left < -1);
      }).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`).slice(0, 5));
      expect(cut, `${path} header is cut off`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${path} scrolls sideways`).toBe(true);
    }
  });
}

test("every page has the shop footer", async ({ page }) => {
  await mockShop(page, { user: USER });
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("footer.shop-footer"), path).toBeVisible();
    await expect(page.locator("footer.shop-footer").getByRole("link", { name: /WhatsApp/ }), path).toBeVisible();
  }
});

test("checkout says order updates go to the email and the delivery phone", async ({ page }) => {
  await mockShop(page, { user: USER });
  await page.route("**/api/account/addresses", route => route.fulfill({ json: { addresses: [] } }));
  await page.addInitScript(() => localStorage.setItem("kalacar-demo-cart-v1", JSON.stringify([{ id: "krushna", variantId: "gold", quantity: 1 }])));
  await page.goto("/cart");
  await expect(page.getByText("Order updates go to buyer@example.test and 9876543210.")).toBeVisible();
});
