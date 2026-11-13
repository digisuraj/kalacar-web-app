"use client";

import { SUPPORT_WHATSAPP, whatsappLink } from "@/data/support";
import { ShopLogo } from "@/components/shop-logo";
import { useLiveLoad } from "@/lib/realtime-client";
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import AddressBook from "@/components/address-book";
import { COURIERS, isCourier } from "@/lib/couriers";
import type { CourierKey } from "@/lib/couriers";
import { useCart } from "@/components/cart-provider";
import { useSiteContent } from "@/components/site-content-provider";
import { SiteFooter } from "@/components/site-footer";
import { ArrowLeft, BagIcon, CheckMark, External } from "@/components/icons";

type User = { id: string; name: string; email: string; phone: string };
type Order = { id: string; createdAt: string; amount: number; status: string; fulfillmentStatus: string; trackingNote?: string; trackingCourier?: string; trackingId?: string; refundAmount?: number | null; cancelReason?: string; address: string; pincode: string; items: Array<{ id: string; name: string; variant?: string; price: number; quantity: number }>; giftWrap?: boolean; giftWrapPrice?: number; couponCode?: string; discount?: number };
type CheckoutOrder = { orderId: string; razorpayOrderId: string; amount: number; currency: string; keyId: string; customer: { name: string; email: string; phone: string } };
const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const noSubscribe = () => () => {};
const orderDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const DELIVERY_STEPS = ["Order placed", "Preparing", "Dispatched", "Delivered"];
const deliveryStep = (status: string) => ({ dispatched: 2, completed: 3 } as Record<string, number>)[status] ?? 1;
const waLink = (orderId?: string) => whatsappLink(orderId ? `Hi Kalacar, I need help with order ${orderId}. Please check its payment or delivery status.` : "Hi Kalacar, I have a question about an order.");

/** Shows the courier and ID. Trackon opens with the result; India Post needs a captcha, so the ID is copied for pasting. */
function TrackingCard({ courier, trackingId }: { courier: CourierKey; trackingId: string }) {
  const [status, setStatus] = useState("");
  const info = COURIERS[courier];
  async function copy(message: string) {
    try { await navigator.clipboard.writeText(trackingId); setStatus(message); }
    catch { setStatus("Couldn’t copy it automatically. Select the tracking ID above and copy it."); }
  }
  return <div className="tracking-card">
    <p className="tracking-card-label">Shipped with {info.label}</p>
    <p className="tracking-card-id"><span>Tracking ID</span><strong>{trackingId}</strong></p>
    <div className="tracking-card-actions">
      <button type="button" className="sync-order-button" onClick={() => void copy("Tracking ID copied.")}>Copy ID</button>
      {info.formField
        ? <form action={info.trackUrl} method="post" target="_blank" rel="noreferrer"><input type="hidden" name={info.formField} value={trackingId} /><button type="submit" className="retry-order-button">Track parcel</button></form>
        : <a className="retry-order-button" href={info.trackUrl} target="_blank" rel="noreferrer" onClick={() => void copy(`Tracking ID copied. Paste it on the ${info.label} page and enter its captcha.`)}>Track parcel</a>}
    </div>
    {status && <p className="tracking-card-status" role="status">{status}</p>}
  </div>;
}

export default function AccountPanel() {
  const { testPayments } = useSiteContent();
  const { count } = useCart();
  const [user, setUser] = useState<User | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [showEmail, setShowEmail] = useState(false);
  const [view, setView] = useState<"orders" | "addresses">("orders");
  // Where to return after sign-in (e.g. back to the bag). The server renders the default, so hydration matches.
  const nextPath = useSyncExternalStore(noSubscribe, () => { const value = new URLSearchParams(window.location.search).get("next"); return value && /^\/(?!\/)/.test(value) ? value : "/account"; }, () => "/account");
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const googleErrorFromUrl = () => {
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("auth_error");
    if (!reason) return "";
    url.searchParams.delete("auth_error");
    window.history.replaceState(null, "", url);
    const messages: Record<string, string> = {
      cancelled: "Google sign-in was cancelled.",
      expired: "Google sign-in expired. Please try again.",
      unverified: "Your Google email isn’t verified, so we couldn’t sign you in.",
      google: "Google sign-in didn’t work. Please try again, or use email and password.",
    };
    return messages[reason] ?? "Google sign-in is unavailable right now. Please try again.";
  };

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const session = await response.json().catch(() => null) as { user?: User | null; error?: string } | null;
    if (!response.ok || !session) {
      setUser(null); setOrders([]);
      setError(session?.error || "Sign-in isn't available right now. Please try again in a few minutes.");
      return;
    }
    setError(googleErrorFromUrl());
    setUser(session.user ?? null);
    if (session.user) {
      const ordersResponse = await fetch("/api/account/orders", { cache: "no-store" });
      if (ordersResponse.ok) {
        const savedOrders = (await ordersResponse.json() as { orders: Order[] }).orders;
        setOrders(savedOrders);
        const pending = savedOrders.filter(order => ["payment_pending", "payment_failed"].includes(order.status)).slice(0, 3);
        if (pending.length) {
          const statuses = await Promise.all(pending.map(async order => {
            try {
              const response = await fetch(`/api/account/orders/${order.id}/sync`, { method: "POST", cache: "no-store" });
              const data = await response.json() as { status?: string };
              return response.ok && data.status ? [order.id, data.status] as const : null;
            } catch { return null; }
          }));
          setOrders(current => current.map(order => {
            const update = statuses.find(result => result?.[0] === order.id);
            return update ? { ...order, status: update[1] } : order;
          }));
        }
      }
    } else setOrders([]);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // Keeps payment, delivery and tracking current without a reload. This customer's own channel only.
  useLiveLoad("orders", refresh, user?.id ?? null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/auth/${mode === "login" ? "login" : "register"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json().catch(() => null) as { user?: User; error?: string } | null;
      if (!response.ok) throw new Error(data?.error || "Could not sign in.");
      const next = new URLSearchParams(window.location.search).get("next");
      if (next?.startsWith("/") && !next.startsWith("//")) { window.location.assign(next); return; }
      setUser(data?.user || null); setForm({ name: "", email: "", phone: "", password: "" }); setNotice("You’re signed in. Your orders are saved to this account.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not sign in."); }
    finally { setBusy(false); }
  }

  async function sync(order: Order) {
    setSyncing(order.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/account/orders/${order.id}/sync`, { method: "POST" });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not check payment status.");
      setNotice(data.status === "paid" ? `Payment confirmed for order ${order.id.slice(0, 8)}.` : `Latest status: ${data.status?.replaceAll("_", " ")}. Your order remains saved.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check payment status."); }
    finally { setSyncing(""); }
  }

  async function cancel(order: Order) {
    if (!window.confirm(`Cancel unpaid order ${order.id.slice(0, 8).toUpperCase()}?`)) return;
    setSyncing(order.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/account/orders/${order.id}/cancel`, { method: "POST" });
      const data = await response.json().catch(() => ({})) as { status?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not cancel the order.");
      setNotice(data.status === "paid" ? `Order ${order.id.slice(0, 8).toUpperCase()} is already paid, so it wasn't cancelled.` : `Order ${order.id.slice(0, 8).toUpperCase()} is cancelled. Nothing was charged.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel the order."); }
    finally { setSyncing(""); }
  }

  async function retry(order: Order) {
    setSyncing(order.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/account/orders/${order.id}/retry`, { method: "POST" });
      const checkout = await response.json() as CheckoutOrder & { status?: string; error?: string };
      if (!response.ok) throw new Error(checkout.error || "Could not reopen payment.");
      if (checkout.status === "cancelled") { setNotice(`Order ${order.id.slice(0, 8).toUpperCase()} was cancelled because it wasn't paid within 1 hour. Nothing was charged.`); await refresh(); return; }
      if (checkout.status === "paid") { setNotice(`This order is already paid. Payment confirmed for order ${order.id.slice(0, 8)}.`); await refresh(); return; }
      if (!window.Razorpay) {
        const script = document.createElement("script"); script.src = "https://checkout.razorpay.com/v1/checkout.js";
        await new Promise<void>((resolve, reject) => { script.onload = () => resolve(); script.onerror = () => reject(new Error("Razorpay Checkout could not load.")); document.body.appendChild(script); });
      }
      if (!window.Razorpay) throw new Error("Razorpay Checkout could not load.");
      const instance = new window.Razorpay({ key: checkout.keyId, amount: checkout.amount, currency: checkout.currency, name: "Kalacar", order_id: checkout.razorpayOrderId, prefill: { name: checkout.customer.name, email: checkout.customer.email, contact: checkout.customer.phone }, handler: async payment => {
        try {
          const verify = await fetch("/api/checkout/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: checkout.orderId, ...payment }) });
          const result = await verify.json() as { status?: string; error?: string };
          if (!verify.ok || result.status !== "paid") setError(result.error || "Payment received. We're still confirming it, so please check the status again shortly.");
          else setNotice(`Payment confirmed for order ${order.id.slice(0, 8)}.`);
        } catch { setError("We could not confirm payment just now. Your order remains saved; use Check payment status before retrying."); }
        await refresh();
      }, modal: { backdropclose: false, escape: false, handleback: false, confirm_close: true, ondismiss: () => { setNotice("Payment window closed. Your order is kept for 1 hour: use Retry payment to pay, or Cancel order."); void sync(order); } } });
      instance.on("payment.failed", response => setError(response.error?.description || "Payment did not complete. Your order remains saved and can be retried."));
      instance.open();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not reopen payment."); }
    finally { setSyncing(""); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }); setUser(null); setOrders([]); setNotice("You have signed out.");
  }

  return <main className="account-page">
    <header className="detail-header"><ShopLogo /><Link className="back-to-shop" href="/#catalogue"><ArrowLeft /> Continue shopping</Link></header>
    <section className="account-content">
      <p className="eyebrow">KALACAR CUSTOMER ACCOUNT</p>
      <h1>{user ? `Namaste, ${user.name.split(" ")[0]}` : "Your orders, in one place."}</h1>
      <p className="account-lede">{user ? "Track your orders and manage your delivery addresses." : "Sign in to track your orders and save delivery addresses."}</p>
      {testPayments && <p className="account-demo-banner">Test mode: no real payment is taken.</p>}
      {error && <p className="account-message error" role="alert">{error}</p>}{notice && <p className="account-message" role="status">{notice}</p>}
      {!user ? <div className="account-card">
        <a className="google-signin primary" href={`/api/auth/google/start?next=${encodeURIComponent(nextPath)}`}><svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>Continue with Google</a>
        <p className="account-signin-note">Quickest and needs no new password. By continuing, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy</Link> policy.</p>
        <button type="button" className="account-email-toggle" aria-expanded={showEmail} onClick={() => setShowEmail(open => !open)}>{showEmail ? "Hide email sign-in" : "Use email and password instead"}</button>
        {showEmail && <div className="account-email-area">
        <div className="account-tabs"><button className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button><button className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(""); }}>Create account</button></div>
        <form className="account-form" onSubmit={submit}>
          {mode === "register" && <><label>Your name<input required minLength={2} maxLength={160} autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label>Mobile number<input required type="tel" minLength={10} autoComplete="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label></>}
          <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label>Password<input required type="password" minLength={10} autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
          <button className="checkout-demo-button" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        </div>}
      </div> : <>
        <div className="account-card account-profile-card">
          <span className="account-avatar" aria-hidden="true">{user.name.trim().charAt(0).toUpperCase()}</span>
          <div className="account-profile-text"><strong>{user.name}</strong><span>{user.email}</span>{user.phone && <span>{user.phone}</span>}</div>
          <button type="button" className="account-signout" onClick={() => void logout()}>Sign out</button>
        </div>
        <div className="account-views" role="group" aria-label="Account sections">
          <button type="button" className={view === "orders" ? "selected" : ""} aria-pressed={view === "orders"} onClick={() => setView("orders")}>Orders{orders.length > 0 && <b>{orders.length}</b>}</button>
          <button type="button" className={view === "addresses" ? "selected" : ""} aria-pressed={view === "addresses"} onClick={() => setView("addresses")}>Addresses</button>
          <Link className="account-bag-link" href="/cart"><BagIcon size={16} />Your bag{count > 0 && <b>{count}</b>}</Link>
        </div>
        <div className="account-card" hidden={view !== "addresses"}><AddressBook defaultName={user.name} defaultPhone={user.phone} /></div>
        <div hidden={view !== "orders"}>
        {orders.length === 0 ? <div className="account-card account-empty"><p>You haven&apos;t placed an order yet.</p><Link className="checkout-demo-button" href="/#catalogue">Browse murtis</Link></div> : <div className="account-orders">{orders.map(order => {
          const status = order.status.replaceAll("_", " ");
          const step = deliveryStep(order.fulfillmentStatus);
          return <article className="account-order" key={order.id}>
            <div className="order-heading"><div><span>Order {order.id.slice(0, 8).toUpperCase()}</span><small>{orderDate(order.createdAt)}</small></div><div className="order-heading-side"><strong>{money(order.amount)}</strong><span className={`order-status ${order.status === "paid" ? "paid" : ["refunded", "cancelled"].includes(order.status) ? "closed" : "pending"}`}>{({ paid_after_cancel: "On hold", payment_pending: "Awaiting payment" } as Record<string, string>)[order.status] ?? status}</span></div></div>
            <ul className="order-lines">{order.items.map((item, index) => <li key={`${item.id}-${index}`}><span>{item.name}{item.variant && item.variant !== "Standard" ? ` (${item.variant})` : ""}</span><span>× {item.quantity}</span></li>)}{order.giftWrap && <li><span>Gift packaging</span>{order.giftWrapPrice ? <span>{money(order.giftWrapPrice)}</span> : null}</li>}{order.couponCode && order.discount ? <li><span>Coupon {order.couponCode}</span><span>−{money(order.discount)}</span></li> : null}</ul>
            {order.status === "paid" && <ol className="delivery-steps" aria-label={`Delivery progress: ${DELIVERY_STEPS[step]}`}>{DELIVERY_STEPS.map((label, index) => <li key={label} className={index < step || order.fulfillmentStatus === "completed" ? "done" : index === step ? "current" : ""} aria-current={index === step ? "step" : undefined}><i>{(index < step || order.fulfillmentStatus === "completed") && <CheckMark />}</i><span>{label}</span></li>)}</ol>}
            {order.status === "paid" && order.trackingId && isCourier(order.trackingCourier) && <TrackingCard courier={order.trackingCourier} trackingId={order.trackingId} />}
            {order.status === "paid" && order.trackingNote && <p className="customer-tracking"><span>Note from Kalacar</span>{order.trackingNote}</p>}
            {order.status === "refunded" && <p className="customer-order-note">Refunded {order.refundAmount ? money(order.refundAmount) : ""}{order.refundAmount && order.refundAmount < order.amount ? ` of ${money(order.amount)}` : ""}. Refunds usually reach your account in 5–7 working days.</p>}
            {(order.status === "cancelled" || order.status === "paid_after_cancel") && <p className="customer-order-note">{order.status === "cancelled" ? "This order was cancelled. No payment was taken." : "This order was cancelled, but a payment arrived afterwards. We’ll refund it; message us on WhatsApp if you have questions."}</p>}
            <details className="order-delivery"><summary>Delivery address</summary><p>{order.address} · PIN {order.pincode}</p></details>
            <div className="order-status-row">{["payment_pending", "payment_failed"].includes(order.status) && <><button type="button" className="retry-order-button" disabled={syncing === order.id} onClick={() => void retry(order)}>Retry payment</button><button type="button" className="sync-order-button" disabled={syncing === order.id} onClick={() => void sync(order)}>{syncing === order.id ? "Checking…" : "Check payment status"}</button><button type="button" className="sync-order-button" disabled={syncing === order.id} onClick={() => void cancel(order)}>Cancel order</button></>}<a className="order-whatsapp" href={waLink(order.id)} target="_blank" rel="noreferrer">WhatsApp help <External /></a></div>
          </article>;
        })}</div>}
        </div>
      </>}
      <a className="account-contact" href={waLink()} target="_blank" rel="noreferrer">Questions about an order? WhatsApp Kalacar · {SUPPORT_WHATSAPP.display}</a>
    </section>
    <SiteFooter />
  </main>;
}
