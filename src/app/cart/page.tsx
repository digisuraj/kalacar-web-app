import { ShopLogo } from "@/components/shop-logo";
import { MobileMenu } from "@/components/mobile-menu";
import Link from "next/link";
import BagFlow from "@/components/bag-flow";
import { SiteFooter } from "@/components/site-footer";
import { ArrowLeft, UserCircle } from "@/components/icons";

/** The full bag page, opened from the top bar's bag button, Account, or Proceed to checkout in the drawer. */
export default function CartPage() {
  return <main className="cart-page">
    <header className="detail-header">
      <MobileMenu /><ShopLogo />
      <div className="detail-header-links"><Link className="account-link" href="/account" aria-label="Your account" title="Your account"><UserCircle size={20} /><span>Account</span></Link><Link className="back-to-shop" href="/#catalogue"><ArrowLeft /> Continue shopping</Link></div>
    </header>
    <section className="cart-page-flow"><BagFlow /></section>
    <SiteFooter />
  </main>;
}
