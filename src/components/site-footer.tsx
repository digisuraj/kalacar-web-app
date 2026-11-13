"use client";

import Image from "next/image";
import Link from "next/link";
import { SUPPORT_WHATSAPP, whatsappLink } from "@/data/support";
import { PolicyLinks } from "@/components/policy-links";
import { useLogo } from "@/components/shop-logo";

/** The shop footer, shared by every page so contact details and policy links are always there. */
export function SiteFooter() {
  const logo = useLogo();
  return <footer className="shop-footer">
    <Link className="wordmark footer-wordmark" href="/" aria-label="Kalacar home">
      <Image src={logo.src} alt="Kalacar — Small Devotional Murtis" width={180} height={77} className={logo.className} style={logo.style} />
    </Link>
    <p>Prices and availability reflect the current catalogue.</p>
    <a className="footer-whatsapp" href={whatsappLink("Hi Kalacar, I have a question about an order.")} target="_blank" rel="noreferrer">WhatsApp · {SUPPORT_WHATSAPP.display}</a>
    <PolicyLinks />
  </footer>;
}
