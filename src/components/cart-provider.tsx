"use client";

import { useLiveLoad } from "@/lib/realtime-client";
import { trackShopEvent } from "@/components/tracking-tags";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BagIcon } from "@/components/icons";
import type { StoreColour, StoreItem } from "@/data/catalogue";

/** A cart line is one colour of one product. Old saved carts have no variantId: they use the first colour. */
export type CartLine = { id: string; variantId?: string; quantity: number };
export type ResolvedLine = { key: string; line: CartLine; product: StoreItem; colour: StoreColour };
type CartContextValue = {
  lines: CartLine[];
  resolved: ResolvedLine[];
  count: number;
  subtotal: number;
  add: (id: string, variantId?: string, quantity?: number) => boolean;
  setQuantity: (key: string, quantity: number) => void;
  remove: (key: string) => void;
  changeColour: (key: string, variantId: string) => void;
  canAdd: (id: string, variantId?: string) => boolean;
  colourOf: (product: StoreItem, variantId?: string) => StoreColour | undefined;
  products: StoreItem[];
  catalogueLoading: boolean;
  catalogueError: string;
  clear: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: (leaveHistory?: boolean) => void;
  giftOffer: GiftOffer | null;
  wantGift: boolean;
  setWantGift: (want: boolean) => void;
};

export type GiftOffer = { price: number; title: string; description: string };
const GIFT_KEY = "kalacar.want-gift.v1";

function validLines(saved: unknown): CartLine[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter((line): line is CartLine =>
    Boolean(line) && typeof line.id === "string" && /^[a-z0-9-]{1,64}$/.test(line.id) &&
    (line.variantId === undefined || (typeof line.variantId === "string" && /^[a-z0-9-]{1,80}$/.test(line.variantId))) &&
    Number.isInteger(line.quantity) && line.quantity > 0,
  );
}

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = "kalacar-demo-cart-v1";
export const lineKey = (line: CartLine) => `${line.id}:${line.variantId ?? ""}`;

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const [products, setProducts] = useState<StoreItem[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef(false);
  const [giftOffer, setGiftOffer] = useState<GiftOffer | null>(null);
  const [wantGift, setWantGiftState] = useState(false);

  // Opening adds a history step, so a phone's Back button closes the drawer instead of leaving the page.
  const openDrawer = useCallback(() => {
    if (!drawerRef.current && window.location.pathname !== "/cart") window.history.pushState({ kalacarDrawer: true }, "");
    drawerRef.current = true;
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback((leaveHistory = false) => {
    drawerRef.current = false;
    setDrawerOpen(false);
    if (!leaveHistory && (window.history.state as { kalacarDrawer?: boolean } | null)?.kalacarDrawer) window.history.back();
  }, []);
  useEffect(() => {
    const onHistory = () => { if (!(window.history.state as { kalacarDrawer?: boolean } | null)?.kalacarDrawer) { drawerRef.current = false; setDrawerOpen(false); } };
    window.addEventListener("popstate", onHistory);
    return () => window.removeEventListener("popstate", onHistory);
  }, []);

  // The one bag: drawer, bag page and product pages all read this state, and other tabs follow through storage events.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      try { setLines(validLines(JSON.parse(event.newValue ?? "[]"))); } catch { setLines([]); }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const giftReload = useRef<() => unknown>(() => undefined);
  const setWantGift = useCallback((want: boolean) => {
    setWantGiftState(want);
    try { if (want) sessionStorage.setItem(GIFT_KEY, "1"); else sessionStorage.removeItem(GIFT_KEY); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    let active = true;
    try { if (sessionStorage.getItem(GIFT_KEY)) window.setTimeout(() => { if (active) setWantGiftState(true); }); } catch { /* storage unavailable */ }
    const load = () => fetch("/api/settings", { cache: "no-store" }).then(r => r.json()).then((data: { giftWrap?: GiftOffer | null }) => { if (active) setGiftOffer(data.giftWrap ?? null); }).catch(() => undefined);
    void load();
    giftReload.current = load;
    return () => { active = false; };
  }, []);
  useLiveLoad("store", () => giftReload.current());

  // The one product request for the whole shop.
  const loadedProducts = useRef(false);
  const loadProducts = useCallback(async () => {
    try {
      const response = await fetch("/api/products", { cache: "no-store" });
      // A closed shop must stop showing products; other failures keep what's already on screen.
      if (response.status === 403) { loadedProducts.current = false; setProducts([]); }
      if (!response.ok) throw new Error("Catalogue is temporarily unavailable.");
      const data = await response.json() as { products: StoreItem[] };
      loadedProducts.current = true;
      setProducts(data.products); setCatalogueError("");
    } catch (error) { if (!loadedProducts.current) setCatalogueError(error instanceof Error ? error.message : "Catalogue is temporarily unavailable."); }
    finally { setCatalogueLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- first load of the catalogue
  useEffect(() => { void loadProducts(); }, [loadProducts]);
  useLiveLoad(["products", "store"], loadProducts);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      setLines(validLines(saved));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Skip identical writes, so a change that came from another tab isn't sent back to it.
    const next = JSON.stringify(lines);
    if (localStorage.getItem(STORAGE_KEY) !== next) localStorage.setItem(STORAGE_KEY, next);
  }, [lines, ready]);

  const colourOf = useCallback((product: StoreItem, variantId?: string) =>
    (variantId ? product.variants.find(v => v.id === variantId) : undefined) ?? product.variants[0], []);

  /** Quantity already in the cart for this exact colour. */
  const inCart = useCallback((current: CartLine[], id: string, colourId: string, products: StoreItem[]) => {
    const product = products.find(p => p.id === id);
    return current.filter(line => line.id === id && product && colourOf(product, line.variantId)?.id === colourId).reduce((sum, line) => sum + line.quantity, 0);
  }, [colourOf]);

  const add = useCallback((id: string, variantId?: string, quantity = 1) => {
    const product = products.find(item => item.id === id);
    const colour = product && colourOf(product, variantId);
    if (!product || !colour) return false;
    const adding = Math.min(quantity, colour.stock - inCart(lines, id, colour.id, products));
    if (adding >= 1) trackShopEvent("add_to_cart", [{ id: product.id, name: product.name, variant: colour.name, price: colour.price, quantity: adding }]);
    let added = false;
    setLines(current => {
      const have = inCart(current, id, colour.id, products);
      const amount = Math.min(quantity, colour.stock - have);
      if (amount < 1) return current;
      added = true;
      const key = `${id}:${colour.id}`;
      const found = current.find(line => lineKey(line) === key);
      return found ? current.map(line => lineKey(line) === key ? { ...line, quantity: line.quantity + amount } : line) : [...current, { id, variantId: colour.id, quantity: amount }];
    });
    return added || colour.stock > inCart(lines, id, colour.id, products);
  }, [products, colourOf, inCart, lines]);

  const setQuantity = useCallback((key: string, quantity: number) => {
    if (quantity <= 0) { setLines(current => current.filter(line => lineKey(line) !== key)); return; }
    setLines(current => current.map(line => {
      if (lineKey(line) !== key) return line;
      const product = products.find(item => item.id === line.id);
      const colour = product && colourOf(product, line.variantId);
      // Never above live stock, but a lower quantity is always allowed.
      return { ...line, quantity: colour && quantity > line.quantity ? Math.min(quantity, Math.max(line.quantity, colour.stock)) : quantity };
    }));
  }, [products, colourOf]);

  const remove = useCallback((key: string) => setLines(current => current.filter(line => lineKey(line) !== key)), []);

  /** Switch a cart line to another colour of the same product, merging with that colour's line and capping at its stock. */
  const changeColour = useCallback((key: string, variantId: string) => {
    setLines(current => {
      const line = current.find(item => lineKey(item) === key);
      const product = line && products.find(p => p.id === line.id);
      const colour = product?.variants.find(v => v.id === variantId);
      if (!line || !product || !colour) return current;
      const rest = current.filter(item => lineKey(item) !== key);
      const targetKey = `${line.id}:${colour.id}`;
      const existing = rest.find(item => lineKey(item) === targetKey);
      const quantity = Math.min(colour.stock, line.quantity + (existing?.quantity ?? 0));
      if (quantity < 1) return current;
      return existing ? rest.map(item => lineKey(item) === targetKey ? { ...item, quantity } : item) : [...rest, { id: line.id, variantId: colour.id, quantity }];
    });
  }, [products]);

  const value = useMemo(() => {
    const resolved: ResolvedLine[] = lines.flatMap(line => {
      const product = products.find(item => item.id === line.id);
      const colour = product && colourOf(product, line.variantId);
      return product && colour ? [{ key: lineKey(line), line, product, colour }] : [];
    });
    const count = lines.reduce((sum, line) => sum + line.quantity, 0);
    const subtotal = resolved.reduce((sum, item) => sum + item.colour.price * item.line.quantity, 0);
    const canAdd = (id: string, variantId?: string) => {
      const product = products.find(item => item.id === id);
      const colour = product && colourOf(product, variantId);
      return Boolean(colour) && inCart(lines, id, colour!.id, products) < colour!.stock;
    };
    const clear = () => setLines([]);
    return { lines, resolved, count, subtotal, add, setQuantity, remove, changeColour, canAdd, colourOf, products, clear, catalogueLoading, catalogueError, drawerOpen, openDrawer, closeDrawer, giftOffer, wantGift, setWantGift };
  }, [lines, products, add, setQuantity, remove, changeColour, colourOf, inCart, catalogueLoading, catalogueError, drawerOpen, openDrawer, closeDrawer, giftOffer, wantGift, setWantGift]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart must be used within CartProvider");
  return cart;
}

export function AddToBagButton({ id, variantId, quantity = 1, className = "add-button", disabled = false, label = "Add to bag" }: { id: string; variantId?: string; quantity?: number; className?: string; disabled?: boolean; label?: string }) {
  const { add, canAdd, openDrawer, products, colourOf } = useCart();
  const product = products.find(item => item.id === id);
  const stock = (product && colourOf(product, variantId)?.stock) ?? 0;
  const soldOut = disabled || stock < 1;
  const allInBag = !soldOut && !canAdd(id, variantId);
  return (
    <button
      className={className}
      type="button"
      disabled={soldOut}
      onClick={() => {
        if (allInBag) openDrawer();
        else if (add(id, variantId, quantity)) openDrawer();
      }}
    >
      {soldOut ? "Out of stock" : allInBag ? "In your bag" : label}
    </button>
  );
}

/** The top bar's bag button opens the full bag page. */
export function CartLink() {
  const { count } = useCart();
  return <Link className="bag-link" href="/cart" aria-label={`Open your bag, ${count} ${count === 1 ? "item" : "items"}`}>
    <BagIcon size={21} />
    {count > 0 && <span className="bag-link-count">{count > 99 ? "99+" : count}</span>}
  </Link>;
}
