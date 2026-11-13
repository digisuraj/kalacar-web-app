"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSiteContent } from "@/components/site-content-provider";

// Loads the Meta Pixel and Google tags saved in dashboard Settings, once, on every shop page.
type MetaPixel = ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue: unknown[]; push: MetaPixel; loaded: boolean; version: string };
declare global { interface Window { fbq?: MetaPixel; _fbq?: MetaPixel; dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void } }

export type TrackedItem = { id: string; name: string; variant?: string; price: number; quantity: number };
type ShopEvent = "view_item" | "add_to_cart" | "begin_checkout" | "purchase";
const META_NAMES: Record<ShopEvent, string> = { view_item: "ViewContent", add_to_cart: "AddToCart", begin_checkout: "InitiateCheckout", purchase: "Purchase" };

// Events wait here until the saved tags start; if none are saved they are dropped.
let tags: { meta: boolean; gtm: boolean; gtag: boolean } | null = null;
type Extra = { orderId?: string; value?: number };
let waiting: [ShopEvent, TrackedItem[], Extra][] = [];

function send(event: ShopEvent, items: TrackedItem[], { orderId, value = items.reduce((sum, item) => sum + item.price * item.quantity, 0) }: Extra) {
  if (!tags) return;
  if (tags.meta) window.fbq?.("track", META_NAMES[event], { content_ids: items.map(item => item.id), content_type: "product", contents: items.map(item => ({ id: item.id, quantity: item.quantity })), num_items: items.reduce((sum, item) => sum + item.quantity, 0), value, currency: "INR" }, orderId ? { eventID: `${event}-${orderId}` } : undefined);
  const ecommerce = { currency: "INR", value, ...(orderId ? { transaction_id: orderId } : {}), items: items.map(item => ({ item_id: item.id, item_name: item.name, item_variant: item.variant ?? "", price: item.price, quantity: item.quantity })) };
  // Tag Manager reads plain dataLayer events; gtag.js IDs get the same event through gtag().
  if (tags.gtm) { window.dataLayer?.push({ ecommerce: null }); window.dataLayer?.push({ event, ecommerce }); }
  if (tags.gtag) window.gtag?.("event", event, ecommerce);
}

/** Tells Meta and Google about a shopping step. Safe to call before the tags load or when none are set up.
 *  Purchases pass the order ID (so Meta can drop repeats) and the amount actually paid. */
export function trackShopEvent(event: ShopEvent, items: TrackedItem[], extra: Extra = {}) {
  if (!items.length) return;
  if (tags) send(event, items, extra); else waiting.push([event, items, extra]);
}

function startEvents(next: { meta: boolean; gtm: boolean; gtag: boolean }) {
  tags = next.meta || next.gtm || next.gtag ? next : null;
  const queued = waiting; waiting = [];
  for (const [event, items, extra] of queued) send(event, items, extra);
}

function addScript(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const script = document.createElement("script");
  script.async = true; script.src = src;
  document.head.appendChild(script);
}

/** Meta's own base code: calls wait in a queue until fbevents.js arrives. */
function startMetaPixel(id: string) {
  if (window.fbq) return;
  const fbq = function (...args: unknown[]) { if (fbq.callMethod) fbq.callMethod(...args); else fbq.queue.push(args); } as MetaPixel;
  fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0"; fbq.queue = [];
  window.fbq = fbq; window._fbq ??= fbq;
  addScript("https://connect.facebook.net/en_US/fbevents.js");
  fbq("init", id);
  fbq("track", "PageView");
}

/** GTM-… IDs load as a tag container (as Google's install code does); G-/AW-/… IDs load gtag.js and are configured. */
function startGoogleTags(ids: string[]) {
  window.dataLayer = window.dataLayer || [];
  // gtag must push the arguments object itself, as Google's code does.
  // eslint-disable-next-line prefer-rest-params
  window.gtag ??= function () { window.dataLayer!.push(arguments); };
  window.gtag("js", new Date());
  const direct = ids.filter(id => !id.startsWith("GTM-"));
  for (const id of ids.filter(id => id.startsWith("GTM-"))) addScript(`https://www.googletagmanager.com/gtm.js?id=${id}`);
  if (direct.length) addScript(`https://www.googletagmanager.com/gtag/js?id=${direct[0]}`);
  for (const id of direct) window.gtag("config", id);
}

export function TrackingTags() {
  const { tracking, ready } = useSiteContent();
  const pathname = usePathname();
  const started = useRef(false);
  const lastPath = useRef(pathname);
  const metaId = tracking?.metaPixelId ?? "", googleIds = (tracking?.googleTagIds ?? []).join(",");
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true; lastPath.current = pathname;
    const ids = googleIds ? googleIds.split(",") : [];
    if (metaId) startMetaPixel(metaId);
    if (ids.length) startGoogleTags(ids);
    startEvents({ meta: Boolean(metaId), gtm: ids.some(id => id.startsWith("GTM-")), gtag: ids.some(id => !id.startsWith("GTM-")) });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- start once, when the settings first arrive
  }, [ready, metaId, googleIds]);
  // Moving between pages doesn't reload the site, so Meta is told about each new page. Google tags see it themselves.
  useEffect(() => {
    if (!started.current || lastPath.current === pathname) return;
    lastPath.current = pathname;
    window.fbq?.("track", "PageView");
  }, [pathname]);
  return null;
}
