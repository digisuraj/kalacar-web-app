import { expect, test } from "@playwright/test";
import { DEFAULT_HERO_SLIDE, DEFAULT_HOME, DEFAULT_PRODUCT_PAGE } from "../../src/data/site-content";
import { expectFits, mockShop, PRODUCTS, watchErrors } from "./mock-shop";

const review = (over: object) => ({ id: 1, productId: "ganesh", author: "Real Buyer", city: "Pune", rating: 4, text: "Lovely finish", photos: [], videoUrl: "", showOnHome: true, published: true, ...over });
const content = (home: object = {}, productPage: object = {}) => ({ home: { ...DEFAULT_HOME, ...home }, productPage: { ...DEFAULT_PRODUCT_PAGE, ...productPage }, collections: [{ name: "Ganesh", image: "", productCount: 1 }, { name: "Krishna", image: "", productCount: 1 }] });
/** A hero with one owner slide; `over` changes that slide. */
const heroWith = (over: object = {}, ...more: object[]) => ({ ...DEFAULT_HOME.hero, slides: [{ ...DEFAULT_HERO_SLIDE, title: "Owner Title", description: "Owner text", ...over }, ...more.map(slide => ({ ...DEFAULT_HERO_SLIDE, ...slide }))] });
const hero = heroWith();

test.describe("home page follows the dashboard", () => {
  test("shows the owner's hero", async ({ page }) => {
    const errors = watchErrors(page);
    await mockShop(page, { content: content({ hero: heroWith({ productId: "ganesh", buy: { show: true, label: "Buy today", showPrice: true } }) }) });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Owner Title" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Buy today · ₹999/ })).toBeVisible();
    await expectFits(page);
    expect(errors).toEqual([]);
  });
  test("defaults keep the page working if settings can't load", async ({ page }) => {
    await mockShop(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: DEFAULT_HERO_SLIDE.title })).toBeVisible();
    await expect(page.locator(".result-count")).toHaveText("3 items");
  });
  test("each checkbox hides its part", async ({ page }) => {
    await mockShop(page, { content: content({ hero: heroWith({ showDescription: false, buy: { ...DEFAULT_HERO_SLIDE.buy, show: false }, explore: { ...DEFAULT_HERO_SLIDE.explore, show: false } }) }) });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Owner Title" })).toBeVisible();
    await expect(page.getByText("Owner text")).toHaveCount(0);
    await expect(page.locator(".home-hero-explore")).toHaveCount(0);
  });
  test("Buy now with one colour adds to the bag and opens it", async ({ page }) => {
    await mockShop(page, { content: content({ hero: heroWith({ productId: "ganesh" }) }) });
    await page.goto("/");
    await page.locator(".home-hero-buy").click();
    await expect(page.getByRole("dialog").or(page.locator(".cart-drawer")).first()).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).toContain("ganesh");
    await expect(page).toHaveURL(/\/$/);
  });
  test("Buy now with several colours asks first, and stays on the page", async ({ page }) => {
    const krushna = PRODUCTS[0];
    const twoInStock = { ...krushna, variants: [...krushna.variants, { ...krushna.variants[0], id: "rose", name: "Rose" }] };
    await mockShop(page, { products: [twoInStock, ...PRODUCTS.slice(1)], content: content({ hero: heroWith({ productId: "krushna" }) }) });
    await page.goto("/");
    await page.locator(".home-hero-buy").click();
    const dialog = page.getByRole("dialog", { name: /Choose a colour/ });
    await expect(dialog.getByRole("button", { name: /White/ })).toBeDisabled();
    await dialog.getByRole("button", { name: /Gold/ }).click();
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).toContain("gold");
    await expect(page).toHaveURL(/\/$/);
  });
  test("First launch and Coming Soon show what was chosen, with no price on upcoming murtis", async ({ page }) => {
    await mockShop(page, { content: content({ hero, firstLaunch: { ...DEFAULT_HOME.firstLaunch, show: true, productIds: ["ganesh"] }, comingSoon: { ...DEFAULT_HOME.comingSoon, show: true, items: [{ name: "Upcoming Hanuman", image: "" }] } }) });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Our First Launch" })).toBeVisible();
    const soon = page.locator("section", { has: page.getByRole("heading", { name: "Coming Soon" }) });
    await expect(soon.getByText("Upcoming Hanuman")).toBeVisible();
    await expect(soon.getByText("Coming Soon", { exact: true }).last()).toBeVisible();
    await expect(soon.getByText("₹")).toHaveCount(0);
    await expect(soon.getByRole("button")).toHaveCount(0);
  });
  test("Categories are cards with a large first card, and filter the catalogue", async ({ page }, info) => {
    await mockShop(page, { content: { ...content({ hero, collections: { ...DEFAULT_HOME.collections, show: true } }), collections: ["Ganesh", "Krishna", "Shiva", "Frames"].map(name => ({ name, image: "", productCount: 1 })) } });
    await page.goto("/");
    const links = page.locator(".home-collections a");
    await expect(links).toHaveCount(4);
    const [first, second] = [await links.nth(0).boundingBox(), await links.nth(1).boundingBox()];
    expect(first?.height ?? 0).toBeGreaterThan((second?.height ?? 0) * 1.5);
    if (info.project.name === "phone") expect(first?.width ?? 0).toBeGreaterThan((second?.width ?? 0) * 1.5);
    await expectFits(page);
    await links.nth(0).click();
    await expect(page.locator(".result-count")).toHaveText("1 item");
  });
  test("no bottom app bar on phones", async ({ page }) => {
    await mockShop(page, { content: content({ hero }) });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Wishlist" })).toHaveCount(0);
  });
  test("Why us, reviews and Our Story appear only when filled in", async ({ page }) => {
    const on = { hero, why: { ...DEFAULT_HOME.why, show: true, items: [{ title: "Reason one", text: "Because" }] }, reviews: { ...DEFAULT_HOME.reviews, show: true }, story: { ...DEFAULT_HOME.story, show: true, text: "Our real story", founder: "Founder Name" } };
    await mockShop(page, { content: content(on), reviews: [review({})] });
    await page.goto("/");
    await expect(page.getByText("Reason one")).toBeVisible();
    await expect(page.getByText("Lovely finish")).toBeVisible();
    await expect(page.getByText("Our real story")).toBeVisible();
    await expectFits(page);
  });
  test("no newsletter section", async ({ page }) => {
    await mockShop(page);
    await page.goto("/");
    await expect(page.getByText(/newsletter|subscribe/i)).toHaveCount(0);
  });
});

test("hero text and both side-by-side buttons are placed for each device", async ({ page }, info) => {
  await page.route("**/_next/image**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='900'/>" }));
  await mockShop(page, { content: content({ hero: heroWith({ productId: "ganesh", backgroundImage: "/uploads/a.png" }) }) });
  await page.goto("/");
  const [buy, explore] = [page.locator(".home-hero-buy"), page.locator(".home-hero-explore")];
  await expect(buy).toBeVisible();
  const [one, two] = [await buy.boundingBox(), await explore.boundingBox()];
  expect(Math.abs((one?.y ?? 0) - (two?.y ?? 99))).toBeLessThan(2);
  expect(two?.x).toBeGreaterThan((one?.x ?? 0) + (one?.width ?? 0) - 1);
  await expect(page.locator(".home-hero-copy")).toHaveCSS("text-align", "left");
  expect(info.project.name).toBeTruthy();
  await expectFits(page);
});

test.describe("product page follows the dashboard", () => {
  test("shows description, offer, how it's made, FAQs and WhatsApp", async ({ page }) => {
    const errors = watchErrors(page);
    const products = PRODUCTS.map(item => item.id === "ganesh" ? { ...item, description: "A long product description." } : item);
    await mockShop(page, { products, content: content({}, { offer: { show: true, title: "Offer", text: "₹200 off above ₹1,500" }, howMade: { ...DEFAULT_PRODUCT_PAGE.howMade, show: true, message: "Founder message" }, faqs: { show: true, title: "FAQs", items: [{ question: "Is it fragile?", answer: "Handle with care." }] } }) });
    await page.goto("/products/ganesh");
    await expect(page.getByText("A long product description.")).toBeVisible();
    await expect(page.getByText("₹200 off above ₹1,500")).toBeVisible();
    await expect(page.getByText("Founder message")).toBeVisible();
    await expect(page.getByText("Is it fragile?")).toBeVisible();
    await expect(page.locator("main > :not(footer)").getByRole("link", { name: /WhatsApp/ })).toBeVisible();
    await expectFits(page);
    expect(errors).toEqual([]);
  });
  test("stars and count come only from real reviews", async ({ page }) => {
    await mockShop(page, { content: content(), reviews: [review({}), review({ id: 2, rating: 5, text: "Great", author: "Second Buyer" }), review({ id: 3, productId: "krushna", rating: 1 })] });
    await page.goto("/products/ganesh");
    await expect(page.locator(".detail-copy .rating-line")).toContainText("4.5 (2 reviews)");
    await page.goto("/products/soldout");
    await expect(page.locator(".rating-line")).toHaveCount(0);
  });
  test("low stock message uses the real number", async ({ page }) => {
    await mockShop(page, { content: content({}, { lowStock: { threshold: 10, text: "Hurry! Only {count} left" } }) });
    await page.goto("/products/ganesh");
    await expect(page.getByText("Hurry! Only 8 left")).toBeVisible();
  });
  test("real figures appear only when turned on and above the minimum", async ({ page }) => {
    const proof = { recent: [{ productId: "ganesh", productName: "Test Ganesh", minutesAgo: 25, firstName: "" }], soldThisWeek: { ganesh: 5, krushna: 1 } };
    await mockShop(page, { proof, content: content({}, { soldThisWeek: { show: true, minimum: 3, hours: 12 } }) });
    await page.goto("/products/ganesh");
    await expect(page.locator(".detail-proof-row").getByText("5 sold in last 12 hours")).toBeVisible();
    await page.goto("/products/krushna");
    await expect(page.getByText(/sold in last/)).toHaveCount(0);
  });
  test("purchase pop-up: real sale with the murti's photo, after the owner's wait", async ({ page }) => {
    const proof = { recent: [{ productId: "krushna", productName: "Test Krushna", minutesAgo: 25, firstName: "" }], soldThisWeek: {} };
    await mockShop(page, { proof, content: content({}, { recentSales: { show: true, showFirstName: false, showImage: true, everyPage: false, delay: 3, duration: 8, size: "large" } }) });
    await page.goto("/products/ganesh");
    const popup = page.locator(".recent-sale");
    await expect(popup).toHaveCount(0);
    await expect(popup).toBeVisible({ timeout: 6000 });
    await expect(popup).toHaveClass(/size-large/);
    await expect(popup).toContainText("Someone has bought Test Krushna");
    await expect(popup).toContainText("25 minutes ago");
    await expect(popup.locator(".recent-sale-image img")).toHaveCount(1);
    await expectFits(page);
  });
  test("in-bag note has no View bag link", async ({ page }) => {
    await mockShop(page, { content: content() });
    await page.goto("/products/ganesh");
    await page.getByRole("button", { name: /add to bag/i }).first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".in-cart-note")).toHaveText("1 in your bag");
    await expect(page.getByRole("link", { name: /View bag/ })).toHaveCount(0);
  });
  test("no made-up viewer count without live data", async ({ page }) => {
    await mockShop(page, { content: content({}, { viewers: { show: true, minimum: 2 } }) });
    await page.goto("/products/ganesh");
    await page.waitForTimeout(1000);
    await expect(page.getByText(/people are viewing/)).toHaveCount(0);
  });
  test("bundle adds everything to the bag", async ({ page }) => {
    const products = PRODUCTS.map(item => item.id === "ganesh" ? { ...item, bundleIds: ["krushna", "soldout"] } : item);
    await mockShop(page, { products, content: content() });
    await page.goto("/products/ganesh");
    const bundle = page.locator(".bundle-box");
    await expect(bundle).toContainText("Test Krushna");
    await expect(bundle).not.toContainText("Test Soldout");
    await bundle.getByRole("button", { name: /Add all to bag · ₹1,998/ }).click();
    const bag = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(bag).toContain("ganesh");
    expect(bag).toContain("krushna");
  });
  test("sticky bar appears after scrolling past the buttons, with an end link", async ({ page }) => {
    await mockShop(page, { content: content() });
    await page.goto("/products/ganesh");
    await expect(page.getByRole("heading", { name: "Test Ganesh" })).toBeVisible();
    await expect(page.locator(".sticky-buy-bar")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator(".sticky-buy-bar")).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore more murtis" })).toBeVisible();
    await expectFits(page);
  });
});

test("a clean Buy label fits one line on phones, and shows the price", async ({ page }, info) => {
  test.skip(info.project.name !== "phone");
  await mockShop(page, { content: content({ hero: heroWith({ productId: "ganesh", backgroundImage: "/uploads/a.png" }) }) });
  await page.goto("/");
  const buy = page.locator(".home-hero-buy");
  await expect(buy).toContainText("₹999");
  expect((await buy.boundingBox())?.height ?? 99).toBeLessThanOrEqual(44);
});

test("video reviews are matching cards that load the player only on press", async ({ page }) => {
  const videos = [review({ id: 1, videoUrl: "https://www.youtube.com/watch?v=abc123DEF_-" }), review({ id: 2, videoUrl: "https://www.instagram.com/reel/ABC_123/", photos: ["/placeholder.png"] })];
  await page.route("https://i.ytimg.com/**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='9' height='16'/>" }));
  await mockShop(page, { content: content({ hero, reviews: { ...DEFAULT_HOME.reviews, show: true } }), reviews: videos });
  await page.route(/youtube-nocookie\.com|instagram\.com\/p\//, route => route.fulfill({ status: 200, contentType: "text/html", body: "<p>player</p>" }));
  await page.goto("/");
  const cards = page.locator(".video-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator("iframe")).toHaveCount(0);
  await expect(cards.nth(0).locator("img")).toHaveAttribute("src", /i\.ytimg\.com\/vi\/abc123DEF_-/);
  await expect(cards.nth(1).locator("iframe.video-card-preview")).toHaveCount(1);
  await expect(cards.nth(1).locator("img")).toHaveCount(0);
  const [one, two] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(Math.round(one?.height ?? 0)).toBe(Math.round(two?.height ?? 1));
  await expect(page.getByRole("link", { name: "View product" })).toHaveCount(2);
  await cards.nth(0).getByRole("button").click();
  await expect(cards.nth(0).locator("iframe")).toHaveAttribute("src", /youtube-nocookie.*autoplay=1/);
  await expect(cards.nth(0).locator("iframe")).not.toHaveAttribute("sandbox");
  await expectFits(page);
});

test("Customer love has a Follow on Instagram button beside its title; no band on the home page", async ({ page }) => {
  const videos = [review({ id: 1, videoUrl: "https://www.youtube.com/watch?v=abc123DEF_-" })];
  await page.route("https://i.ytimg.com/**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='9' height='16'/>" }));
  await mockShop(page, { content: { ...content({ hero, reviews: { ...DEFAULT_HOME.reviews, show: true } }), instagram: { show: false, username: "kalacar.in" } }, reviews: videos });
  await page.goto("/");
  await expect(page.locator(".video-card")).toHaveCount(1);
  await expect(page.locator(".instagram-band")).toHaveCount(0);
  await expect(page.locator(".reviews-follow")).toHaveCount(0);
  await mockShop(page, { content: { ...content({ hero, reviews: { ...DEFAULT_HOME.reviews, show: true } }), instagram: { show: true, username: "kalacar.in" } }, reviews: videos });
  await page.goto("/");
  const follow = page.locator(".home-reviews-top .reviews-follow");
  await expect(follow).toHaveAttribute("href", "https://www.instagram.com/kalacar.in/");
  await expect(follow).toHaveAttribute("target", "_blank");
  await expect(page.locator(".instagram-band")).toHaveCount(0);
  await expectFits(page);
});

test("inner pages show the real logo, not broken text", async ({ page }) => {
  await mockShop(page);
  for (const path of ["/cart", "/account", "/about", "/products/ganesh"]) {
    await page.goto(path);
    await expect(page.locator(".detail-header .shop-logo img, .cart-page .shop-logo img").first()).toBeVisible();
    await expect(page.locator("header").getByText("SMALL DEVOTIONAL MURTIS")).toHaveCount(0);
  }
});

test.describe("info pages", () => {
  test("Contact form sends a message, and ignores spam bots", async ({ page }) => {
    const state = await mockShop(page);
    await page.goto("/contact");
    await page.getByLabel("Name").fill("Asha");
    await page.getByLabel("Email").fill("asha@example.test");
    await page.getByLabel("Message").fill("Is this in stock?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/We've received your message/)).toBeVisible();
    expect(state.contactBodies[0]).toMatchObject({ name: "Asha", website: "" });
  });
  for (const [path, heading] of [["/about", "About Kalacar"], ["/faq", "FAQs"], ["/contact", "Contact us"]] as const) {
    test(`${path} opens and fits`, async ({ page }) => {
      await mockShop(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
      await expectFits(page);
    });
  }
  test("undecided pages show a draft notice and stay out of Google", async ({ page }) => {
    await mockShop(page);
    await page.goto("/privacy");
    await expect(page.locator(".policy-draft:visible")).toContainText("Draft, owner review");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
  test("footer links come from the dashboard", async ({ page }) => {
    await mockShop(page);
    await page.goto("/");
    await expect(page.locator(".shop-footer").getByRole("link", { name: "About Kalacar" })).toBeVisible();
    await expect(page.locator(".shop-footer").getByRole("link", { name: "Terms" })).toHaveCount(0);
  });
});

test.describe("hero slides", () => {
  const three = heroWith({ title: "First slide", backgroundImage: "/uploads/a.png" }, { title: "Second slide", backgroundImage: "/uploads/b.png" }, { title: "Third slide", backgroundImage: "" });
  test("one slide has no dots and no carousel", async ({ page }) => {
    await mockShop(page, { content: content({ hero }) });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Owner Title" })).toBeVisible();
    await expect(page.locator(".hero-carousel")).toHaveCount(0);
    await expect(page.locator(".hero-dots")).toHaveCount(0);
  });
  test("several slides: dots move between them, only the first title is the page heading, no arrows", async ({ page }) => {
    const errors = watchErrors(page);
    await mockShop(page, { content: content({ hero: { ...three, autoplay: false } }) });
    await page.goto("/");
    await expect(page.locator(".hero-dots button")).toHaveCount(3);
    await expect(page.locator(".hero-arrow")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("First slide");
    await expect(page.locator(".home-hero h2", { hasText: "Second slide" })).toBeAttached();
    await page.getByRole("button", { name: "Show slide 2" }).click();
    await expect(page.getByRole("button", { name: "Show slide 2" })).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".home-hero[aria-hidden='true']")).toHaveCount(2);
    await page.getByRole("button", { name: "Show slide 3" }).click();
    await expect(page.getByRole("button", { name: "Show slide 3" })).toHaveAttribute("aria-current", "true");
    await expectFits(page);
    expect(errors).toEqual([]);
  });
  test("timer moves to the next slide, and stays put when turned off", async ({ page }) => {
    await mockShop(page, { content: content({ hero: { ...three, autoplay: true, interval: 3 } }) });
    await page.goto("/");
    await page.mouse.move(1, 1);
    await expect(page.getByRole("button", { name: "Show slide 2" })).toHaveAttribute("aria-current", "true", { timeout: 6000 });
  });
  test("timer off: no movement", async ({ page }) => {
    await mockShop(page, { content: content({ hero: { ...three, autoplay: false, interval: 3 } }) });
    await page.goto("/");
    await page.mouse.move(1, 1);
    await page.waitForTimeout(4000);
    await expect(page.getByRole("button", { name: "Show slide 1" })).toHaveAttribute("aria-current", "true");
  });
  test("a server still sending the old single hero shows it as one slide", async ({ page }) => {
    const errors = watchErrors(page);
    const { slides, ...rest } = hero;
    await mockShop(page, { content: content({ hero: { show: rest.show, ...slides[0], title: "Old shape title" } }) });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Old shape title" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
