import { ShopLogo } from "@/components/shop-logo";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ContactForm } from "@/components/contact-form";
import { ArrowLeft } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { cleanPageHtml, defaultPage, getPage } from "@/lib/pages";

/** If the database can't be reached, the page's starting text is shown, so it's never blank. */
async function load(slug: string) {
  await connection();
  return await getPage(slug).catch(() => defaultPage(slug));
}

export async function pageMetadata(slug: string): Promise<Metadata> {
  const page = await load(slug);
  if (!page) return {};
  return { title: page.seoTitle || `${page.title} — Kalacar`, description: page.seoDescription, robots: page.draft || !page.published ? { index: false, follow: true } : undefined };
}

async function Body({ slug }: { slug: string }) {
  const page = await load(slug);
  if (!page || !page.published) notFound();
  return <article className="policy-content">
    <h1>{page.title}</h1>
    {page.intro && <p className="policy-intro">{page.intro}</p>}
    {page.draft && <p className="policy-draft" role="note"><b>Draft, owner review before launch.</b> Highlighted items are not decided yet and are not promises.</p>}
    {/* Cleaned on save and again here, so only simple formatting can appear. */}
    <div className="managed-page-body" dangerouslySetInnerHTML={{ __html: cleanPageHtml(page.content) }} />
    {page.hasForm && <ContactForm />}
  </article>;
}

export function ManagedPage({ slug }: { slug: string }) {
  return <main className="policy-page">
    <header className="detail-header"><ShopLogo /><Link className="back-to-shop" href="/"><ArrowLeft /> Back to the shop</Link></header>
    <Suspense fallback={<article className="policy-content"><p>Loading…</p></article>}><Body slug={slug} /></Suspense>
    <SiteFooter />
  </main>;
}
