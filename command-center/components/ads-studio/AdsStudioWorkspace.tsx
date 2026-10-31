"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AD_FORMATS, type AdFormat, type AdVariant, type BrandKit,
  type Product, buildAdConcepts, normalizeWebsite,
} from "@/lib/ads-studio";
import styles from "./ads-studio.module.css";

const INITIAL_BRAND: BrandKit = {
  name: "Nightshift", website: "", headline: "Made for your next big idea",
  tagline: "Your studio. Your vision.", color: "#D9AA61",
  audience: "Creative businesses", tone: "Modern, cinematic",
};
const INITIAL_PRODUCTS: Product[] = [{
  id: "product-1", name: "Signature Product", price: "",
  sellingPoint: "Create something remarkable",
}];
const ALL_FORMATS = Object.keys(AD_FORMATS) as AdFormat[];

export function AdsStudioWorkspace() {
  const [brand, setBrand] = useState<BrandKit>(INITIAL_BRAND);
  const [products, setProducts] = useState<Product[]>(INITIAL_PRODUCTS);
  const [formats, setFormats] = useState<AdFormat[]>(["feed", "story"]);
  const [count, setCount] = useState(4);
  const [direction, setDirection] = useState<AdVariant["direction"]>("spotlight");
  const [concepts, setConcepts] = useState<AdVariant[]>([]);
  const [notice, setNotice] = useState("");
  const [active, setActive] = useState("concept-1");
  const selected = useMemo(() => concepts.find(x => x.id === active) || concepts[0], [concepts, active]);
  const patch = (values: Partial<BrandKit>) => setBrand(b => ({ ...b, ...values }));
  const makeConcepts = () => {
    const next = buildAdConcepts(brand, products.filter(x => x.name.trim()), formats, count, direction);
    setConcepts(next);
    setActive(next[0]?.id || "");
    setNotice(next.length ? "Concept previews generated locally. No AI images, credits or API calls were used." : "Add a brand, a product and at least one placement.");
  };
  const addProduct = () => {
    if (products.length >= 20) return;
    setProducts(p => [...p, { id: `product-${p.length + 1}`, name: "", price: "", sellingPoint: "" }]);
  };
  return <main className={styles.page}>
    <header className={styles.topbar}>
      <Link href="/" className={styles.wordmark}>N<span>IGHTSHIFT</span></Link>
      <div className={styles.headerRight}><span className={styles.previewTag}>LOCAL PREVIEW · NO AI BILLING</span><Link href="/studio">Studio</Link></div>
    </header>
    <div className={styles.hero}>
      <div className={styles.kicker}>CREATIVE SYSTEMS / 01 — AD STUDIO</div>
      <h1>From your brand to <em>campaign-ready concepts.</em></h1>
      <p>Build a reusable brand kit, organize products and plan multi-format advertising. Review concepts before connecting an image model.</p>
    </div>
    <div className={styles.shell}>
      <section className={styles.sidebar} aria-label="Campaign setup">
        <div className={styles.sectionHeading}><b>01 / Brand intelligence</b><span>Editable kit</span></div>
        <label>Website URL<input value={brand.website} placeholder="https://your-brand.com" onChange={e => patch({ website: e.target.value })}/></label>
        <div className={styles.smallInfo}>Automatic website scanning is not connected yet. Enter and approve your brand details manually.</div>
        {brand.website && !normalizeWebsite(brand.website) && <p className={styles.warning}>Enter a valid HTTPS website URL.</p>}
        <div className={styles.duo}>
          <label>Brand name<input value={brand.name} maxLength={80} onChange={e => patch({ name: e.target.value })}/></label>
          <label>Brand color<input type="color" value={brand.color} onChange={e => patch({ color: e.target.value })}/></label>
        </div>
        <label>Campaign headline<input value={brand.headline} maxLength={120} onChange={e => patch({ headline: e.target.value })}/></label>
        <label>Tagline<input value={brand.tagline} maxLength={120} onChange={e => patch({ tagline: e.target.value })}/></label>
        <div className={styles.duo}>
          <label>Audience<input value={brand.audience} maxLength={100} onChange={e => patch({ audience: e.target.value })}/></label>
          <label>Voice<input value={brand.tone} maxLength={100} onChange={e => patch({ tone: e.target.value })}/></label>
        </div>
        <div className={styles.sectionHeading}><b>02 / Products</b><button type="button" onClick={addProduct} disabled={products.length >= 20}>+ Add product</button></div>
        <div className={styles.products}>
          {products.map((product, index) => <div key={product.id} className={styles.productRow}>
            <div className={styles.rowTop}><span>PRODUCT {String(index + 1).padStart(2, "0")}</span><button type="button" onClick={() => setProducts(p => p.filter(x => x.id !== product.id))}>Remove</button></div>
            <input aria-label={`Product ${index + 1} name`} placeholder="Product name" maxLength={100} value={product.name} onChange={e => setProducts(p => p.map(x => x.id === product.id ? { ...x, name: e.target.value } : x))}/>
            <input aria-label={`Product ${index + 1} price`} placeholder="Price (optional)" maxLength={40} value={product.price || ""} onChange={e => setProducts(p => p.map(x => x.id === product.id ? { ...x, price: e.target.value } : x))}/>
            <input aria-label={`Product ${index + 1} selling point`} placeholder="Approved selling point" maxLength={120} value={product.sellingPoint || ""} onChange={e => setProducts(p => p.map(x => x.id === product.id ? { ...x, sellingPoint: e.target.value } : x))}/>
          </div>)}
        </div>
        <div className={styles.sectionHeading}><b>03 / Campaign format</b><span>1–12 concepts</span></div>
        <div className={styles.chips}>{ALL_FORMATS.map(format => <label key={format} className={formats.includes(format) ? styles.chipActive : styles.chip}><input type="checkbox" checked={formats.includes(format)} onChange={e => setFormats(current => e.target.checked ? [...current, format] : current.filter(x => x !== format))}/>{AD_FORMATS[format].ratio}</label>)}</div>
        <div className={styles.duo}>
          <label>Concept count<input type="number" min={1} max={12} value={count} onChange={e => setCount(Math.min(12, Math.max(1, Number(e.target.value) || 1)))}/></label>
          <label>Art direction<select value={direction} onChange={e => setDirection(e.target.value as AdVariant["direction"])}><option value="spotlight">Product spotlight</option><option value="editorial">Editorial</option><option value="minimal">Minimal</option></select></label>
        </div>
        <button type="button" className={styles.generate} onClick={makeConcepts}>Create campaign concepts <span>↗</span></button>
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
      </section>
      <section className={styles.preview} aria-label="Advertisement concept previews">
        <div className={styles.previewTop}><div><div className={styles.kicker}>CAMPAIGN WORKSPACE</div><h2>Creative direction</h2></div><span>{concepts.length} concepts</span></div>
        {selected ? <div className={styles.stage}>
          <div className={styles.canvas} style={{ aspectRatio: `${AD_FORMATS[selected.format].width} / ${AD_FORMATS[selected.format].height}`, borderColor: selected.color }}>
            <div className={styles.canvasGlow} style={{ background: selected.color }} />
            <div className={styles.canvasBrand}>{brand.name}</div>
            <div className={styles.canvasContent}>
              <span className={styles.canvasEyebrow}>{selected.direction.toUpperCase()} / {AD_FORMATS[selected.format].label}</span>
              <h3>{selected.headline}</h3>
              <p>{selected.product}</p>
              <span>{selected.subline}</span>
            </div>
            <div className={styles.canvasFooter}>NIGHTSHIFT ADS CONCEPT <span>{AD_FORMATS[selected.format].ratio}</span></div>
          </div>
          <div className={styles.canvasLabel}>Concept-only layout • Product photo and AI-generated assets are not rendered</div>
        </div> : <div className={styles.empty}><span>✳</span><h3>Your campaign starts here.</h3><p>Define a brand, add your products, select formats, then create your first concepts.</p></div>}
        {!!concepts.length && <div className={styles.thumbGrid}>{concepts.map(x => <button type="button" key={x.id} className={selected?.id === x.id ? styles.thumbActive : styles.thumb} onClick={() => setActive(x.id)}><strong>{x.product}</strong><span>{AD_FORMATS[x.format].ratio} · {x.direction}</span></button>)}</div>}
        <div className={styles.future}><b>NEXT IN PIPELINE</b><span>Consent-based brand scanner · Shopify catalog connector · direct model APIs · image generation · in-site editor · export · approval-gated publishing</span></div>
      </section>
    </div>
  </main>;
}
