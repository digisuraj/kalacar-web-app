"use client";

import { ShopLogo } from "@/components/shop-logo";
import { MobileMenu } from "@/components/mobile-menu";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { trackShopEvent } from "@/components/tracking-tags";
import { requestShopFilter } from "@/lib/shop-filter";
import { useRouter } from "next/navigation";
import { AddToBagButton, CartLink, useCart } from "@/components/cart-provider";
import type { StoreItem } from "@/data/catalogue";
import { ProductDetailAccordions } from "@/components/product-detail-accordions";
import { DeliveryLine, ProductHighlights, SpecCards } from "@/components/product-facts";
import { RecommendedProducts } from "@/components/recommended-products";
import { ArrowLeft, UserCircle } from "@/components/icons";
import { BundleBox, CommonFaqs, EndOfPageLink, HowItsMade, LiveViewers, OfferBox, RecentSaleNotice, SoldThisWeek, StickyBuyBar, WhatsappHelp, useSocialProof } from "@/components/product-extras";
import { ProductReviews, RatingLine } from "@/components/reviews";
import { useSiteContent } from "@/components/site-content-provider";
import { SiteFooter } from "@/components/site-footer";

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const savePercent = (price: number, regular: number) => regular > price ? Math.round((1 - price / regular) * 100) : 0;

/** `initialColour` comes from ?colour= so a shared link (or "change" from the cart) opens that colour. */
export default function ProductDetailClient({ slug, initialColour = "" }: { slug: string; initialColour?: string }) {
  const { products, catalogueLoading, catalogueError, add, lines, openDrawer, canAdd } = useCart();
  const { productPage, reviews } = useSiteContent();
  const proof = useSocialProof(productPage.recentSales.show || productPage.soldThisWeek.show);
  const buyButtons = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const item: StoreItem | undefined = products.find(product => product.id === slug);
  const [chosenId, setChosenId] = useState(initialColour);
  const [imageIndex, setImageIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  // One product view per product opened, reported once its details have loaded.
  const viewed = item?.id ?? "";
  useEffect(() => {
    const shown = products.find(product => product.id === viewed);
    const first = shown?.variants.find(c => c.id === initialColour) ?? shown?.variants[0];
    if (shown) trackShopEvent("view_item", [{ id: shown.id, name: shown.name, variant: first?.name, price: first?.price ?? shown.price, quantity: 1 }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per product, not on every stock refresh
  }, [viewed]);

  if (!item) return <main className="product-page"><header className="detail-header"><ShopLogo /></header><section className="cart-content"><h1>{catalogueError || (catalogueLoading ? "Loading product…" : "Product not found in the current catalogue.")}</h1><Link href="/#catalogue"><ArrowLeft /> Back to all murtis</Link></section><SiteFooter /></main>;

  const itemReviews = reviews.filter(review => review.productId === item.id);
  const colours = item.variants;
  const colour = colours.find(c => c.id === chosenId) ?? colours.find(c => c.stock > 0) ?? colours[0];
  const gallery = colour?.gallery.length ? colour.gallery : item.gallery?.length ? item.gallery : [item.image];
  const shownImage = gallery[Math.min(imageIndex, gallery.length - 1)];
  const inCart = lines.filter(line => line.id === item.id && (line.variantId ?? colours[0]?.id) === colour?.id).reduce((sum, line) => sum + line.quantity, 0);
  const canBuy = Math.max(0, Math.min(10, (colour?.stock ?? 0) - inCart));
  const qty = Math.max(1, Math.min(quantity, canBuy || 1));
  const save = colour ? savePercent(colour.price, colour.originalPrice) : 0;
  const pricesDiffer = new Set(colours.map(c => c.price)).size > 1;
  const choose = (id: string) => {
    setChosenId(id); setImageIndex(0); setQuantity(1);
    try { const url = new URL(window.location.href); url.searchParams.set("colour", id); window.history.replaceState(null, "", url); } catch { /* address bar unchanged */ }
  };
  const stockMessage = !colour || colour.stock < 1 ? { tone: "out", text: colours.some(option => option.stock > 0) ? `${colour?.name ?? "This colour"} is out of stock. Try another colour.` : "This murti is currently out of stock." }
    : canBuy < 1 ? { tone: "low", text: `All ${colour.stock} available ${colour.stock === 1 ? "is" : "are"} in your bag.` }
    : colour.stock - inCart <= productPage.lowStock.threshold ? { tone: "low", text: inCart > 0 ? `Only ${colour.stock - inCart} more available` : productPage.lowStock.text.replaceAll("{count}", String(colour.stock)) } : { tone: "ok", text: "In stock" };
  // Add and Buy now only work for pieces not already in the bag; what's in the bag is reachable from the note below.
  const buyNow = () => { if (canBuy < 1) return; add(item.id, colour.id, qty); router.push("/cart"); };

  return <main className="product-page">
    {process.env.NODE_ENV === "development" && <p className="local-data-notice" role="note">Local development · Confirm this database product’s details, price, and stock before launch. Payments remain in test mode.</p>}
    <header className="detail-header"><MobileMenu /><ShopLogo /><div className="detail-header-links"><Link className="account-link" href="/account" aria-label="Your account" title="Your account"><UserCircle size={20} /><span>Account</span></Link><CartLink /><Link className="back-to-shop" href="/#catalogue"><ArrowLeft /> Back to all murtis</Link></div></header>
    {/* "Murtis" opens the home catalogue on All murtis; the category opens it on that category. */}
    <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/">Home</Link><span>/</span><Link href="/#catalogue" onClick={event => { event.preventDefault(); requestShopFilter({ category: "All murtis", search: "" }, href => router.push(href)); }}>Murtis</Link><span>/</span><Link href="/#catalogue" onClick={event => { event.preventDefault(); requestShopFilter({ category: item.deity, search: "" }, href => router.push(href)); }}>{item.deity}</Link><span>/</span><span>{item.name}</span></nav>
    <section className="detail-layout">
      <div className="detail-gallery">
        <div className="detail-main-image">
          <Image key={shownImage} src={shownImage} alt={`${item.name}${colours.length > 1 ? ` in ${colour?.name}` : ""}`} fill priority sizes="(max-width: 760px) 100vw, 58vw" />
          {(item.badge || save > 0) && <div className="detail-image-badges">{item.badge && <span className="badge-chip">{item.badge}</span>}{save > 0 && <span className="badge-chip save">Save {save}%</span>}</div>}
        </div>
        {gallery.length > 1 && <div className="detail-thumbnails" role="group" aria-label={`${item.name} photos`}>{gallery.map((image, index) => <button type="button" className={`detail-thumbnail${image === shownImage ? " selected" : ""}`} key={image} aria-label={`Show photo ${index + 1}`} aria-pressed={image === shownImage} onClick={() => setImageIndex(index)}><Image src={image} alt="" fill sizes="120px" /></button>)}</div>}
      </div>
      <div className="detail-copy">
        <p className="eyebrow">{item.deity} · SMALL DEVOTIONAL MURTI</p>
        <h1>{item.name}</h1>
        <div className="detail-proof-row"><RatingLine reviews={itemReviews} /><SoldThisWeek count={proof.soldThisWeek[item.id] ?? 0} /></div>
        {item.tagline && <p className="detail-tagline">{item.tagline}</p>}
        {item.placement && <p className="detail-placement">{item.placement}</p>}
        <p className="detail-price">{money(colour?.price ?? item.price)}{save > 0 && <><del>{money(colour.originalPrice)}</del><span className="save-chip">Save {save}%</span></>}</p>
        <p className="detail-tax-note">Prices include all taxes.</p>
        <LiveViewers productId={item.id} />

        {item.description && <p className="detail-description">{item.description}</p>}
        {colours.length > 1 && <fieldset className="colour-picker">
          <legend>Colour: <b>{colour?.name}</b></legend>
          <div className="colour-options">{colours.map(option => <label key={option.id} className={`colour-option${option.id === colour?.id ? " selected" : ""}${option.stock < 1 ? " sold-out" : ""}`}>
            <input type="radio" name="colour" value={option.id} checked={option.id === colour?.id} onChange={() => choose(option.id)} />
            <span className="colour-dot" style={{ background: option.swatch }} aria-hidden="true" />
            <span>{option.name}</span>
            {(pricesDiffer || option.stock < 1) && <small>{option.stock < 1 ? "Sold out" : money(option.price)}</small>}
          </label>)}</div>
        </fieldset>}

        <div className="buy-box">
          <div className="quantity-row">
            <span className="quantity-label">Quantity</span>
            <div className="quantity-control" aria-label="Quantity">
              <button type="button" aria-label="Decrease quantity" disabled={qty <= 1} onClick={() => setQuantity(qty - 1)}>−</button>
              <span aria-live="polite">{qty}</span>
              <button type="button" aria-label="Increase quantity" disabled={qty >= canBuy} onClick={() => setQuantity(qty + 1)}>+</button>
            </div>
            {inCart > 0 && <span className="in-cart-note">{inCart} in your bag</span>}
          </div>
          <p className={`stock-message ${stockMessage.tone}`} role="status">{stockMessage.text}</p>
          <div className="buy-buttons" ref={buyButtons}>
            <AddToBagButton id={item.id} variantId={colour?.id} quantity={qty} className="detail-add-button" label="Add to bag" />
            <button type="button" className="buy-now-button" disabled={canBuy < 1} onClick={buyNow}>Buy now</button>
          </div>
          <OfferBox />
          <DeliveryLine />
          <ProductHighlights items={item.highlights ?? []} />
        </div>
      </div>
    </section>
    {/* Computers: specifications left, product details right. Phones: one after the other. */}
    <section className="detail-lower" aria-label="Specifications and product details">
      <SpecCards specs={item.specs ?? []} />
      <div className="detail-facts">
        <h2>Product details</h2>
        <dl className="product-facts"><div><dt>Category</dt><dd>{(item.categories?.length ? item.categories : [item.deity]).join(", ")}</dd></div>{colours.length > 1 && <div><dt>Colours</dt><dd>{colours.map(c => c.name).join(", ")}</dd></div>}<div><dt>Availability</dt><dd>{colour && colour.stock > 0 ? `${colour.stock} in stock${colours.length > 1 ? ` in ${colour.name}` : ""}` : "Out of stock"}</dd></div></dl>
      </div>
    </section>
    <ProductDetailAccordions sections={item.accordions ?? []} />
    <div className="detail-more">
      <HowItsMade />
      <BundleBox item={item} products={products} />
      <ProductReviews reviews={itemReviews} />
      <CommonFaqs />
      <WhatsappHelp />
    </div>
    <RecommendedProducts current={item} products={products} />
    <EndOfPageLink />
    {colour && <StickyBuyBar item={item} price={colour.price} watch={buyButtons} disabled={canBuy < 1} inBag={inCart > 0} onAdd={() => { if (canBuy >= 1 && canAdd(item.id, colour.id)) add(item.id, colour.id, qty); openDrawer(); }} onBuy={buyNow} />}
    <RecentSaleNotice proof={proof} products={products} />
    <SiteFooter />
  </main>;
}
