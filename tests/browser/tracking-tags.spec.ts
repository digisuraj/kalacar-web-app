import { expect, test } from "@playwright/test";
import { mockShop } from "./mock-shop";
import { DEFAULT_BRAND, DEFAULT_FESTIVE, DEFAULT_HOME, DEFAULT_INSTAGRAM, DEFAULT_PRODUCT_PAGE } from "../../src/data/site-content";

const content = (tracking: unknown) => ({ home: DEFAULT_HOME, productPage: DEFAULT_PRODUCT_PAGE, collections: [], instagram: DEFAULT_INSTAGRAM, festive: DEFAULT_FESTIVE, brand: DEFAULT_BRAND, tracking });

test("saved Meta Pixel and Google tags load on the shop, and Meta hears about page changes", async ({ page }) => {
  await mockShop(page, { content: content({ metaPixelId: "4436512496660507", googleTagIds: ["GTM-KZJ27PVT", "GTM-PMJWSM6Z"] }) });
  const loaded: string[] = [];
  await page.route(/connect\.facebook\.net|googletagmanager\.com/, route => { loaded.push(route.request().url()); return route.fulfill({ contentType: "text/javascript", body: "" }); });
  await page.goto("/");
  await expect.poll(() => loaded.length).toBe(3);
  expect(loaded.some(url => url.includes("fbevents.js"))).toBe(true);
  expect(loaded.filter(url => /gtm\.js\?id=GTM-(KZJ27PVT|PMJWSM6Z)$/.test(url))).toHaveLength(2);
  const queue = () => page.evaluate(() => (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.map(args => args.join(" ")));
  expect(await queue()).toEqual(["init 4436512496660507", "track PageView"]);
  // Moving to another page inside the shop (no reload) counts as a new page view; the tags aren't loaded twice.
  await page.locator("footer").getByRole("link", { name: "About Kalacar" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect.poll(queue).toEqual(["init 4436512496660507", "track PageView", "track PageView"]);
  expect(loaded).toHaveLength(3);
});

test("no tags load when none are saved", async ({ page }) => {
  await mockShop(page, { content: content({ metaPixelId: "", googleTagIds: [] }) });
  const loaded: string[] = [];
  await page.route(/connect\.facebook\.net|googletagmanager\.com/, route => { loaded.push(route.request().url()); return route.fulfill({ contentType: "text/javascript", body: "" }); });
  await page.goto("/");
  await expect(page.locator("main").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(loaded).toEqual([]);
  expect(await page.evaluate(() => "fbq" in window)).toBe(false);
});

const ORDER = "22222222-2222-4222-8222-222222222222";
const USER = { id: "u1", name: "Test Buyer", email: "buyer@example.test", phone: "9876543210" };
const ADDRESS = { id: "a1", isDefault: true, label: "Home", fullName: "Test Buyer", phone: "9876543210", address: "1 Temple Road", city: "Pune", state: "Maharashtra", landmark: "", instructions: "", pincode: "411001" };
type Tracked = { meta: string[]; google: string[] };

test("shopping steps reach Meta and Google: view, add to bag, checkout, and one purchase with the paid amount", async ({ page }) => {
  const paid = { id: ORDER, createdAt: "2026-11-12T10:00:00Z", amount: 1798, status: "paid", email: USER.email, phone: USER.phone, address: "1 Temple Road", pincode: "411001", items: [{ id: "krushna", name: "Test Krushna", variant: "Gold", price: 999, quantity: 2 }] };
  await mockShop(page, { user: USER, orders: [paid], content: content({ metaPixelId: "4436512496660507", googleTagIds: ["GTM-KZJ27PVT"] }) });
  await page.route(/connect\.facebook\.net|googletagmanager\.com/, route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/api/account/addresses", route => route.fulfill({ json: { addresses: [ADDRESS] } }));
  await page.route("**/api/checkout/orders", route => route.fulfill({ json: { orderId: ORDER, razorpayOrderId: "order_new", amount: 179800, currency: "INR", keyId: "rzp_test_x" } }));
  await page.route("**/api/checkout/verify", route => route.fulfill({ json: { status: "paid" } }));
  await page.route("https://checkout.razorpay.com/**", route => route.fulfill({ contentType: "text/javascript", body: "window.Razorpay = class { constructor(o) { this.o = o; } on() {} open() { this.o.handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_new', razorpay_signature: 'sig' }); } };" }));
  const tracked = () => page.evaluate((): Tracked => {
    const w = window as unknown as { fbq?: { queue: unknown[][] }; dataLayer?: Record<string, unknown>[] };
    if (!w.fbq || !w.dataLayer) return { meta: [], google: [] };
    return {
      meta: w.fbq.queue.filter(args => args[0] === "track" && args[1] !== "PageView").map(args => `${args[1]} ${(args[2] as { value: number }).value}${args[3] ? ` ${(args[3] as { eventID: string }).eventID}` : ""}`),
      google: w.dataLayer.filter(entry => typeof entry.event === "string" && !String(entry.event).startsWith("gtm")).map(entry => `${entry.event} ${(entry.ecommerce as { value: number }).value}`),
    };
  });
  await page.goto("/products/krushna");
  await expect.poll(tracked).toEqual({ meta: ["ViewContent 999"], google: ["view_item 999"] });
  await page.locator(".product-buy-row, .detail-copy").getByRole("button", { name: "Buy now" }).first().click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole("button", { name: /^Pay / }).click();
  await expect(page.getByText("Thank you, your order is confirmed")).toBeVisible();
  // Buy now adds to the bag too. The purchase carries the amount paid and the order ID, so Meta can drop repeats.
  await expect.poll(tracked).toEqual({
    meta: ["ViewContent 999", "AddToCart 999", "InitiateCheckout 999", `Purchase 1798 purchase-${ORDER}`],
    google: ["view_item 999", "add_to_cart 999", "begin_checkout 999", "purchase 1798"],
  });
  // Showing the confirmation again doesn't report the purchase twice.
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("kalacar.tracked-purchases.v1") ?? "[]"))).toEqual([ORDER]);
});

test("adding to the bag is reported with the quantity added", async ({ page }) => {
  await mockShop(page, { content: content({ metaPixelId: "4436512496660507", googleTagIds: [] }) });
  await page.route(/connect\.facebook\.net/, route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/products/krushna");
  await page.locator(".detail-copy, .product-buy-row").getByRole("button", { name: "Add to bag" }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.filter(args => args[1] === "AddToCart").map(args => (args[2] as { content_ids: string[]; num_items: number; value: number })))).toEqual([{ content_ids: ["krushna"], content_type: "product", contents: [{ id: "krushna", quantity: 1 }], num_items: 1, value: 999, currency: "INR" }]);
});
