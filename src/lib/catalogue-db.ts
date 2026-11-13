import mysql, { type RowDataPacket } from "mysql2/promise";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ProductAccordion } from "@/data/catalogue";
import { CouponError, applyCoupon } from "@/lib/coupons";

const scrypt = promisify(scryptCallback);

const allowedDatabase = "u480209824_temp_db";
const allowedUser = "u480209824_shreyasdamase";
let pool: mysql.Pool | undefined;
let ready: Promise<void> | undefined;

function database() {
  const databaseName = process.env.DB_NAME;
  const user = process.env.DB_USER;
  if (databaseName !== allowedDatabase || user !== allowedUser) {
    throw new Error("Kalacar inventory database configuration is missing or outside the approved temporary database.");
  }
  if (!process.env.DB_HOST || !process.env.DB_PASSWORD) throw new Error("Database connection settings are incomplete.");
  return pool ??= mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user,
    password: process.env.DB_PASSWORD, database: databaseName,
    waitForConnections: true, connectionLimit: 4, queueLimit: 0, charset: "utf8mb4",
  });
}

async function initialize() {
  const db = database();
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_products (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL, deity VARCHAR(80) NOT NULL,
    image VARCHAR(500) NOT NULL, gallery TEXT NULL, image_alt VARCHAR(255) NOT NULL, placement VARCHAR(255) NOT NULL,
    price INT UNSIGNED NOT NULL, original_price INT UNSIGNED NOT NULL, stock INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [galleryColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'gallery'");
  if (galleryColumns.length === 0) await db.execute("ALTER TABLE kalacar_products ADD COLUMN gallery TEXT NULL AFTER image");
  const [accordionColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'accordions'");
  if (accordionColumns.length === 0) await db.execute("ALTER TABLE kalacar_products ADD COLUMN accordions JSON NULL AFTER placement");
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_orders (
    id CHAR(36) PRIMARY KEY, idempotency_key CHAR(36) NOT NULL UNIQUE, razorpay_order_id VARCHAR(64) NULL UNIQUE,
    razorpay_payment_id VARCHAR(64) NULL UNIQUE, amount INT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(32) NOT NULL, customer_name VARCHAR(160) NOT NULL, email VARCHAR(190) NOT NULL,
    phone VARCHAR(32) NOT NULL, address TEXT NOT NULL, pincode VARCHAR(12) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [fulfillmentColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'fulfillment_status'");
  if (!fulfillmentColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN fulfillment_status VARCHAR(24) NOT NULL DEFAULT 'unfulfilled' AFTER status");
  const [lifecycleColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'tracking_note'");
  if (!lifecycleColumns.length) await db.execute(`ALTER TABLE kalacar_orders
    ADD COLUMN tracking_note VARCHAR(300) NULL AFTER fulfillment_status,
    ADD COLUMN cancel_reason VARCHAR(300) NULL AFTER tracking_note,
    ADD COLUMN cancelled_at DATETIME NULL AFTER cancel_reason,
    ADD COLUMN refund_amount INT UNSIGNED NULL AFTER cancelled_at,
    ADD COLUMN refund_reason VARCHAR(300) NULL AFTER refund_amount,
    ADD COLUMN refund_reference VARCHAR(64) NULL AFTER refund_reason,
    ADD COLUMN refunded_at DATETIME NULL AFTER refund_reference,
    ADD COLUMN stock_restored TINYINT(1) NOT NULL DEFAULT 0 AFTER refunded_at`);
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_order_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL,
    product_id VARCHAR(64) NOT NULL, product_name VARCHAR(160) NOT NULL,
    unit_price INT UNSIGNED NOT NULL, quantity INT UNSIGNED NOT NULL,
    KEY order_items_order_id (order_id),
    CONSTRAINT kalacar_order_items_order_fk FOREIGN KEY (order_id) REFERENCES kalacar_orders(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_users (
    id CHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE,
    phone VARCHAR(32) NOT NULL DEFAULT '', password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY sessions_user_id (user_id),
    CONSTRAINT kalacar_sessions_user_fk FOREIGN KEY (user_id) REFERENCES kalacar_users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_webhook_events (
    event_id VARCHAR(100) PRIMARY KEY, event_type VARCHAR(80) NOT NULL,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [googleColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_users LIKE 'google_sub'");
  if (!googleColumns.length) await db.execute("ALTER TABLE kalacar_users ADD COLUMN google_sub VARCHAR(64) NULL AFTER password_hash, ADD UNIQUE KEY users_google_sub (google_sub)");
  // Product presentation managed from the dashboard
  const [badgeColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'badge'");
  if (!badgeColumns.length) await db.execute("ALTER TABLE kalacar_products ADD COLUMN badge VARCHAR(40) NULL AFTER deity, ADD COLUMN tagline VARCHAR(120) NULL AFTER badge");
  // Categories beyond the main one (`deity`), so a murti can appear under several.
  const [extraCategoryColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'extra_categories'");
  if (!extraCategoryColumns.length) await db.execute("ALTER TABLE kalacar_products ADD COLUMN extra_categories JSON NULL AFTER deity");
  const [specColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'specs'");
  if (!specColumns.length) await db.execute("ALTER TABLE kalacar_products ADD COLUMN specs JSON NULL AFTER accordions, ADD COLUMN highlights JSON NULL AFTER specs");
  // Colours (variants): the real source of photos, price and stock. The product row keeps a summary.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_product_variants (
    id VARCHAR(80) PRIMARY KEY, product_id VARCHAR(64) NOT NULL, name VARCHAR(60) NOT NULL, swatch CHAR(7) NOT NULL DEFAULT '#b08d57',
    gallery JSON NOT NULL, price INT UNSIGNED NOT NULL, original_price INT UNSIGNED NOT NULL, stock INT UNSIGNED NOT NULL DEFAULT 0,
    sort SMALLINT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY variants_product (product_id, sort),
    CONSTRAINT kalacar_variants_product_fk FOREIGN KEY (product_id) REFERENCES kalacar_products(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Every product without colours gets one default colour carrying its current photos, price and stock.
  await db.execute(`INSERT INTO kalacar_product_variants (id,product_id,name,gallery,price,original_price,stock,sort,active)
    SELECT CONCAT(p.id,'-standard'), p.id, 'Standard', COALESCE(p.gallery, JSON_ARRAY(p.image)), p.price, p.original_price, p.stock, 0, 1
    FROM kalacar_products p WHERE NOT EXISTS (SELECT 1 FROM kalacar_product_variants v WHERE v.product_id=p.id)`);
  const [variantItemColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_order_items LIKE 'variant_id'");
  if (!variantItemColumns.length) await db.execute("ALTER TABLE kalacar_order_items ADD COLUMN variant_id VARCHAR(80) NULL AFTER product_name, ADD COLUMN variant_name VARCHAR(60) NULL AFTER variant_id");
  // Store settings managed from the dashboard (e.g. gift packaging).
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_settings (
    name VARCHAR(60) PRIMARY KEY, value JSON NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [giftColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'gift_wrap'");
  if (!giftColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN gift_wrap TINYINT(1) NOT NULL DEFAULT 0 AFTER amount, ADD COLUMN gift_wrap_price INT UNSIGNED NOT NULL DEFAULT 0 AFTER gift_wrap");
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_addresses (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, label VARCHAR(10) NOT NULL DEFAULT 'Home',
    full_name VARCHAR(160) NOT NULL, phone VARCHAR(32) NOT NULL, address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL, state VARCHAR(100) NOT NULL, landmark VARCHAR(200) NOT NULL DEFAULT '',
    instructions VARCHAR(300) NOT NULL DEFAULT '', pincode CHAR(6) NOT NULL, is_default TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY addresses_user_id (user_id),
    CONSTRAINT kalacar_addresses_user_fk FOREIGN KEY (user_id) REFERENCES kalacar_users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [userColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'user_id'");
  if (!userColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN user_id CHAR(36) NULL AFTER id, ADD KEY orders_user_id (user_id)");
  // Coupons managed from the dashboard. Orders keep the coupon id plus a snapshot of the code and discount.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_coupons (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, type VARCHAR(10) NOT NULL,
    amount INT UNSIGNED NOT NULL, max_discount INT UNSIGNED NULL, min_spend INT UNSIGNED NOT NULL DEFAULT 0,
    usage_limit INT UNSIGNED NULL, once_per_customer TINYINT(1) NOT NULL DEFAULT 1,
    starts_on DATE NULL, expires_on DATE NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Categories the owner manages in Settings; products store the category's name in `deity`.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_categories (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [trackingColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'tracking_id'");
  if (!trackingColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN tracking_courier VARCHAR(20) NULL AFTER tracking_note, ADD COLUMN tracking_id VARCHAR(30) NULL AFTER tracking_courier");
  // Lets the dashboard ask "has any order changed?" without loading every order.
  const [orderChangeColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'updated_at'");
  if (!orderChangeColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ADD KEY orders_updated_at (updated_at)");
  // Editable info and policy pages, and messages from the Contact page.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_pages (
    slug VARCHAR(40) PRIMARY KEY, title VARCHAR(120) NOT NULL, intro VARCHAR(300) NOT NULL DEFAULT '', content MEDIUMTEXT NOT NULL,
    seo_title VARCHAR(70) NOT NULL DEFAULT '', seo_description VARCHAR(170) NOT NULL DEFAULT '', published TINYINT(1) NOT NULL DEFAULT 1,
    in_footer TINYINT(1) NOT NULL DEFAULT 1, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_inquiries (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL, phone VARCHAR(20) NOT NULL DEFAULT '',
    message TEXT NOT NULL, handled TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Real customer reviews entered by the owner. A review with no product is for the shop in general.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_reviews (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, product_id VARCHAR(64) NULL, author VARCHAR(80) NOT NULL, city VARCHAR(80) NOT NULL DEFAULT '',
    rating TINYINT UNSIGNED NOT NULL, body TEXT NOT NULL, photos JSON NULL, video_url VARCHAR(300) NOT NULL DEFAULT '', show_on_home TINYINT(1) NOT NULL DEFAULT 0,
    published TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY reviews_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [descriptionColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_products LIKE 'description'");
  if (!descriptionColumns.length) await db.execute("ALTER TABLE kalacar_products ADD COLUMN description TEXT NULL AFTER placement, ADD COLUMN bundle_ids JSON NULL AFTER description");
  const [categoryImageColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_categories LIKE 'image'");
  if (!categoryImageColumns.length) await db.execute("ALTER TABLE kalacar_categories ADD COLUMN image VARCHAR(300) NULL AFTER name");
  // Devices the owner turned on browser alerts for. Owner-only; holds no customer details.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_push_devices (
    endpoint_hash CHAR(64) PRIMARY KEY, endpoint VARCHAR(1000) NOT NULL, p256dh VARCHAR(200) NOT NULL, auth VARCHAR(100) NOT NULL,
    owner_email VARCHAR(190) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Product photos live here so they survive redeploys and every server sees them.
  await db.execute(`CREATE TABLE IF NOT EXISTS kalacar_photos (
    file_name VARCHAR(190) PRIMARY KEY, content_type VARCHAR(40) NOT NULL, bytes MEDIUMBLOB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [couponColumns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM kalacar_orders LIKE 'coupon_id'");
  if (!couponColumns.length) await db.execute("ALTER TABLE kalacar_orders ADD COLUMN coupon_id INT UNSIGNED NULL AFTER gift_wrap_price, ADD COLUMN coupon_code VARCHAR(32) NULL AFTER coupon_id, ADD COLUMN discount INT UNSIGNED NOT NULL DEFAULT 0 AFTER coupon_code, ADD KEY orders_coupon_id (coupon_id)");
}

export async function ensureCatalogue() {
  ready ??= initialize();
  try { await ready; } catch (error) { ready = undefined; throw error; }
}

export async function savePhoto(fileName: string, contentType: string, bytes: Buffer) {
  await ensureCatalogue();
  await database().execute("INSERT INTO kalacar_photos (file_name,content_type,bytes) VALUES (?,?,?)", [fileName, contentType, bytes]);
}

export async function deletePhotos(fileNames: string[]) {
  if (!fileNames.length) return;
  await ensureCatalogue();
  await database().query("DELETE FROM kalacar_photos WHERE file_name IN (?)", [fileNames]);
}

export async function findPhoto(fileName: string) {
  await ensureCatalogue();
  const [rows] = await database().execute<RowDataPacket[]>("SELECT content_type,bytes FROM kalacar_photos WHERE file_name=?", [fileName]);
  return rows.length ? { contentType: String(rows[0].content_type), bytes: rows[0].bytes as Buffer } : null;
}

export type { VariantRow };
/** Pool for modules that keep their own queries (e.g. saved addresses, colours), after tables exist. */
export async function addressDb() {
  await ensureCatalogue();
  return database();
}

/** Stores a phone on accounts that have none yet (e.g. Google sign-ins), so checkout can prefill it. */
export async function fillMissingCustomerPhone(userId: string, phone: string) {
  await ensureCatalogue();
  await database().execute("UPDATE kalacar_users SET phone=? WHERE id=? AND phone=''", [phone, userId]);
}

type ProductRow = RowDataPacket & { description?: string | null; bundle_ids?: unknown; id: string; name: string; deity: string; extra_categories: unknown; badge: string | null; tagline: string | null; specs: unknown; highlights: unknown; image: string; gallery: string | null; image_alt: string; placement: string; accordions: string | ProductAccordion[] | null; price: number; original_price: number; stock: number; updated_at: Date };

function parseAccordions(value: ProductRow["accordions"]): ProductAccordion[] {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as ProductAccordion[] : [];
  } catch { return []; }
}

type VariantRow = RowDataPacket & { id: string; product_id: string; name: string; swatch: string; gallery: string | string[]; price: number; original_price: number; stock: number; sort: number; active: number };
export type ProductVariant = { id: string; name: string; swatch: string; gallery: string[]; price: number; originalPrice: number; stock: number; sort: number; active: boolean };
const parseGallery = (value: string | string[] | null, fallback: string[] = []) => {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed as string[] : fallback; } catch { return fallback; }
};
const toVariant = (row: VariantRow): ProductVariant => ({ id: row.id, name: row.name, swatch: row.swatch, gallery: parseGallery(row.gallery), price: Number(row.price), originalPrice: Number(row.original_price), stock: Number(row.stock), sort: Number(row.sort), active: Boolean(row.active) });

/** Products with their colours. The shop gets visible colours only; the dashboard passes includeHidden. */
export type ProductSpec = { label: string; value: string };
const readJson = (value: unknown) => { if (value == null) return null; if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown; } catch { return null; } };
const parseSpecs = (value: unknown): ProductSpec[] => { const list = readJson(value); return Array.isArray(list) ? list.filter((s): s is ProductSpec => Boolean(s) && typeof s.label === "string" && typeof s.value === "string") : []; };
const parseHighlights = (value: unknown): string[] => { const list = readJson(value); return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : []; };
/** The main category first, then any others, without repeats. */
export const productCategories = (deity: string, extra: unknown) => [...new Set([deity, ...parseHighlights(extra)])];

function parseBundleIds(value: unknown) {
  try {
    const list = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(0, 2) : [];
  } catch { return []; }
}

export async function listProducts({ includeHidden = false } = {}) {
  await ensureCatalogue();
  const [rows] = await database().query<ProductRow[]>("SELECT id,name,deity,extra_categories,badge,tagline,image,gallery,image_alt,placement,description,bundle_ids,accordions,specs,highlights,price,original_price,stock,updated_at FROM kalacar_products ORDER BY updated_at DESC, id");
  const [variantRows] = await database().query<VariantRow[]>(`SELECT * FROM kalacar_product_variants ${includeHidden ? "" : "WHERE active=1"} ORDER BY sort, name`);
  return rows.map(row => {
    const gallery = parseGallery(row.gallery, [row.image]);
    const variants = variantRows.filter(variant => variant.product_id === row.id).map(toVariant);
    return { id: row.id, name: row.name, deity: row.deity, categories: productCategories(row.deity, row.extra_categories), badge: row.badge ?? "", tagline: row.tagline ?? "", specs: parseSpecs(row.specs), highlights: parseHighlights(row.highlights), image: row.image, gallery, imageAlt: row.image_alt, placement: row.placement, description: row.description ?? "", bundleIds: parseBundleIds(row.bundle_ids), accordions: parseAccordions(row.accordions), price: Number(row.price), originalPrice: Number(row.original_price), stock: Number(row.stock), variants, updatedAt: row.updated_at };
  }).filter(product => includeHidden || product.variants.length > 0);
}

/**
 * Recomputes the product's summary from its visible colours: total stock, lowest price (and that
 * colour's regular price), and the first colour's photos. Call inside the same transaction.
 */
export async function syncProductSummary(connection: mysql.PoolConnection, productId: string) {
  const [variants] = await connection.execute<VariantRow[]>("SELECT * FROM kalacar_product_variants WHERE product_id=? AND active=1 ORDER BY sort, name", [productId]);
  if (!variants.length) { await connection.execute("UPDATE kalacar_products SET stock=0 WHERE id=?", [productId]); return; }
  const cheapest = [...variants].sort((a, b) => Number(a.price) - Number(b.price))[0];
  const gallery = parseGallery(variants[0].gallery);
  await connection.execute("UPDATE kalacar_products SET stock=?, price=?, original_price=?, image=?, gallery=? WHERE id=?",
    [variants.reduce((sum, v) => sum + Number(v.stock), 0), Number(cheapest.price), Number(cheapest.original_price), gallery[0] ?? "", JSON.stringify(gallery), productId]);
}


export async function createProduct(product: { id: string; name: string; deity: string; badge?: string; tagline?: string; image: string; gallery: string[]; placement: string; accordions: ProductAccordion[]; price: number; originalPrice: number; stock: number }) {
  await ensureCatalogue();
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO kalacar_products (id,name,deity,badge,tagline,image,gallery,image_alt,placement,accordions,price,original_price,stock) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [product.id, product.name, product.deity, product.badge || null, product.tagline || null, product.image, JSON.stringify(product.gallery), `${product.name} product photo`, product.placement, JSON.stringify(product.accordions), product.price, product.originalPrice, product.stock],
    );
    // A new product starts with one colour; more are added in Edit details.
    await connection.execute("INSERT INTO kalacar_product_variants (id,product_id,name,gallery,price,original_price,stock,sort,active) VALUES (?,?,?,?,?,?,?,0,1)",
      [`${product.id}-standard`, product.id, "Standard", JSON.stringify(product.gallery), product.price, product.originalPrice, product.stock]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

type CheckoutLine = { id: string; variantId?: string; quantity: number };
type CheckoutCustomer = { name: string; email: string; phone: string; address: string; pincode: string };
type OrderRow = RowDataPacket & { tracking_courier: string | null; tracking_id: string | null; id: string; user_id: string | null; idempotency_key: string; razorpay_order_id: string | null; razorpay_payment_id: string | null; amount: number; status: string; fulfillment_status: string; gift_wrap: number; gift_wrap_price: number; coupon_code: string | null; discount: number; tracking_note: string | null; cancel_reason: string | null; cancelled_at: Date | null; refund_amount: number | null; refund_reason: string | null; refund_reference: string | null; refunded_at: Date | null; stock_restored: number; customer_name: string; email: string; phone: string; address: string; pincode: string; created_at: Date };

export type OrderStatusFilter = "all" | "pending_payment" | "processing" | "on_hold" | "dispatched" | "completed" | "cancelled" | "refunded";
type OrderStatusCounts = Record<OrderStatusFilter, number>;
const orderStatusConditions: Record<Exclude<OrderStatusFilter, "all">, string> = {
  pending_payment: "status='payment_pending'",
  processing: "status='paid' AND fulfillment_status IN ('unfulfilled','processing')",
  on_hold: "status IN ('payment_failed','payment_setup_failed','paid_after_cancel')",
  dispatched: "status='paid' AND fulfillment_status='dispatched'",
  completed: "status='paid' AND fulfillment_status='completed'",
  cancelled: "status IN ('payment_cancelled','cancelled')",
  refunded: "status='refunded'",
};

export async function getOrderStatusCounts(): Promise<OrderStatusCounts> {
  await ensureCatalogue();
  const [rows] = await database().query<(RowDataPacket & Record<string, number | string>)[]>(`SELECT COUNT(*) AS all_count,
    ${Object.entries(orderStatusConditions).map(([key, condition]) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS ${key}`).join(",\n    ")}
    FROM kalacar_orders`);
  const counts = rows[0] ?? {};
  return {
    all: Number(counts.all_count ?? 0),
    pending_payment: Number(counts.pending_payment ?? 0),
    processing: Number(counts.processing ?? 0),
    on_hold: Number(counts.on_hold ?? 0),
    dispatched: Number(counts.dispatched ?? 0),
    completed: Number(counts.completed ?? 0),
    cancelled: Number(counts.cancelled ?? 0),
    refunded: Number(counts.refunded ?? 0),
  };
}

export async function reserveOrder(key: string, lines: CheckoutLine[], customer: CheckoutCustomer, userId: string, giftWrapPrice: number | null = null, couponCode: string | null = null) {
  await ensureCatalogue();
  const db = database();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE idempotency_key=? FOR UPDATE", [key]);
    if (existingRows[0]) {
      if (existingRows[0].user_id !== userId) throw new Error("ORDER_OWNER_MISMATCH");
      await connection.commit();
      const existing = existingRows[0];
      return { id: existing.id, amount: Number(existing.amount), razorpayOrderId: existing.razorpay_order_id, status: existing.status, reused: true };
    }
    // Lock in a fixed order (product, then colour) so concurrent checkouts can't deadlock.
    const requested = [...lines].sort((a, b) => a.id.localeCompare(b.id) || (a.variantId ?? "").localeCompare(b.variantId ?? ""));
    const items: Array<{ id: string; name: string; variantId: string; variantName: string; price: number; quantity: number }> = [];
    let amount = 0;
    for (const line of requested) {
      const [rows] = await connection.execute<ProductRow[]>("SELECT id,name FROM kalacar_products WHERE id=? FOR UPDATE", [line.id]);
      const product = rows[0];
      if (!product) throw new Error("INSUFFICIENT_STOCK");
      // Old carts without a colour use the product's first visible colour.
      const [variants] = await connection.execute<VariantRow[]>(
        line.variantId ? "SELECT * FROM kalacar_product_variants WHERE id=? AND product_id=? AND active=1 FOR UPDATE" : "SELECT * FROM kalacar_product_variants WHERE product_id=? AND active=1 ORDER BY sort, name LIMIT 1 FOR UPDATE",
        line.variantId ? [line.variantId, line.id] : [line.id]);
      const variant = variants[0];
      if (!variant || Number(variant.stock) < line.quantity) throw new Error("INSUFFICIENT_STOCK");
      const [result] = await connection.execute<mysql.ResultSetHeader>("UPDATE kalacar_product_variants SET stock=stock-? WHERE id=? AND stock>=?", [line.quantity, variant.id, line.quantity]);
      if (result.affectedRows !== 1) throw new Error("INSUFFICIENT_STOCK");
      amount += Number(variant.price) * line.quantity;
      items.push({ id: line.id, name: product.name, variantId: variant.id, variantName: variant.name, price: Number(variant.price), quantity: line.quantity });
    }
    for (const productId of new Set(items.map(item => item.id))) await syncProductSummary(connection, productId);
    // Coupon: checked again here with its row locked, so the last remaining use can't be taken twice.
    // The discount applies to the murtis only (not gift packaging).
    const coupon = couponCode ? await applyCoupon(connection, couponCode, userId, amount, giftWrapPrice ?? 0) : null;
    if (coupon && !coupon.ok) throw new CouponError(coupon.error);
    const discount = coupon?.ok ? coupon.discount : 0;
    amount -= discount;
    // Gift packaging price comes from dashboard settings at the moment of checkout and is part of the charged total.
    if (giftWrapPrice !== null) amount += giftWrapPrice;
    const id = randomUUID();
    await connection.execute("INSERT INTO kalacar_orders (id,user_id,idempotency_key,amount,gift_wrap,gift_wrap_price,coupon_id,coupon_code,discount,status,customer_name,email,phone,address,pincode) VALUES (?,?,?,?,?,?,?,?,?,'payment_pending',?,?,?,?,?)", [id, userId, key, amount, giftWrapPrice !== null ? 1 : 0, giftWrapPrice ?? 0, coupon?.ok ? coupon.coupon.id : null, coupon?.ok ? coupon.coupon.code : null, discount, customer.name, customer.email, customer.phone, customer.address, customer.pincode]);
    for (const item of items) await connection.execute("INSERT INTO kalacar_order_items (order_id,product_id,product_name,variant_id,variant_name,unit_price,quantity) VALUES (?,?,?,?,?,?,?)", [id, item.id, item.name, item.variantId, item.variantName, item.price, item.quantity]);
    await connection.commit();
    signalOrder(id, true);
    return { id, amount, razorpayOrderId: null, status: "payment_pending", reused: false };
  } catch (error) {
    await connection.rollback();
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      const [duplicates] = await db.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE idempotency_key=?", [key]);
      if (duplicates[0]) {
        const duplicate = duplicates[0];
        if (duplicate.user_id !== userId) throw new Error("ORDER_OWNER_MISMATCH");
        return { id: duplicate.id, amount: Number(duplicate.amount), razorpayOrderId: duplicate.razorpay_order_id, status: duplicate.status, reused: true };
      }
    }
    throw error;
  } finally { connection.release(); }
}

/** Item total for a cart at today's prices (no locks; for the coupon preview only — checkout recomputes it). */
export async function quoteItemsSubtotal(lines: CheckoutLine[]) {
  await ensureCatalogue();
  let total = 0;
  for (const line of lines) {
    const [variants] = await database().execute<VariantRow[]>(
      line.variantId ? "SELECT * FROM kalacar_product_variants WHERE id=? AND product_id=? AND active=1" : "SELECT * FROM kalacar_product_variants WHERE product_id=? AND active=1 ORDER BY sort, name LIMIT 1",
      line.variantId ? [line.variantId, line.id] : [line.id]);
    if (!variants[0]) return null;
    total += Number(variants[0].price) * line.quantity;
  }
  return total;
}

/** Returns order items to their colour's stock (falls back to the product's first colour for old orders). */
async function returnItemsToStock(connection: mysql.PoolConnection, orderId: string) {
  const [items] = await connection.execute<(RowDataPacket & { product_id: string; variant_id: string | null; quantity: number })[]>("SELECT product_id,variant_id,quantity FROM kalacar_order_items WHERE order_id=?", [orderId]);
  for (const item of items) {
    const [result] = item.variant_id ? await connection.execute<mysql.ResultSetHeader>("UPDATE kalacar_product_variants SET stock=stock+? WHERE id=?", [item.quantity, item.variant_id]) : [{ affectedRows: 0 } as mysql.ResultSetHeader];
    if (!result.affectedRows) await connection.execute("UPDATE kalacar_product_variants SET stock=stock+? WHERE product_id=? ORDER BY sort, name LIMIT 1", [item.quantity, item.product_id]);
  }
  for (const productId of new Set(items.map(item => item.product_id))) await syncProductSummary(connection, productId);
}

export async function attachRazorpayOrder(id: string, razorpayOrderId: string) {
  await ensureCatalogue();
  await database().execute("UPDATE kalacar_orders SET razorpay_order_id=? WHERE id=? AND status='payment_pending'", [razorpayOrderId, id]);
}

export async function releaseOrderAfterPaymentSetupFailure(id: string) {
  await ensureCatalogue();
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=? FOR UPDATE", [id]);
    const order = orders[0];
    if (!order || order.status !== "payment_pending" || order.razorpay_order_id) { await connection.rollback(); return; }
    await returnItemsToStock(connection, id);
    await connection.execute("UPDATE kalacar_orders SET status='payment_setup_failed' WHERE id=? AND status='payment_pending'", [id]);
    await connection.commit();
    signalOrder(id, true);
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function findOrder(id: string) {
  await ensureCatalogue();
  const [rows] = await database().execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=?", [id]);
  const order = rows[0];
  if (!order) return null;
  const [items] = await database().execute<(RowDataPacket & { product_id: string; product_name: string; variant_name: string | null; unit_price: number; quantity: number })[]>("SELECT product_id,product_name,variant_name,unit_price,quantity FROM kalacar_order_items WHERE order_id=?", [id]);
  return { id: order.id, userId: order.user_id, razorpayOrderId: order.razorpay_order_id, paymentId: order.razorpay_payment_id, amount: Number(order.amount), status: order.status, items: items.map(item => ({ id: item.product_id, name: item.product_name, variant: item.variant_name ?? "", price: Number(item.unit_price), quantity: Number(item.quantity) })) };
}

const statusLabels: Record<string, string> = { payment_pending: "Awaiting payment", paid: "Paid", paid_after_cancel: "Paid after cancel", payment_failed: "Payment failed", payment_setup_failed: "Payment setup failed", payment_cancelled: "Cancelled", cancelled: "Cancelled", refunded: "Refunded" };
const statusLabel = (status: string) => statusLabels[status] ?? status.replaceAll("_", " ");
const lifecycle = (order: OrderRow) => ({
  giftWrap: Boolean(order.gift_wrap), giftWrapPrice: Number(order.gift_wrap_price ?? 0),
  couponCode: order.coupon_code ?? "", discount: Number(order.discount ?? 0),
  rawStatus: order.status, trackingNote: order.tracking_note ?? "", trackingCourier: order.tracking_courier ?? "", trackingId: order.tracking_id ?? "", cancelReason: order.cancel_reason ?? "", cancelledAt: order.cancelled_at,
  refundAmount: order.refund_amount === null ? null : Number(order.refund_amount), refundReason: order.refund_reason ?? "",
  refundReference: order.refund_reference ?? "", refundedAt: order.refunded_at, stockRestored: Boolean(order.stock_restored),
});

export async function getAdminOrderDetails(id: string) {
  await ensureCatalogue();
  const [rows] = await database().execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=?", [id]);
  const order = rows[0];
  if (!order) return null;
  const [items] = await database().execute<(RowDataPacket & { product_id: string; product_name: string; variant_name: string | null; unit_price: number; quantity: number })[]>("SELECT product_id,product_name,variant_name,unit_price,quantity FROM kalacar_order_items WHERE order_id=? ORDER BY id", [id]);
  const status = statusLabel(order.status);
  return {
    ...lifecycle(order),
    id: order.id,
    date: order.created_at,
    customer: order.customer_name,
    email: order.email,
    phone: order.phone,
    address: order.address,
    pincode: order.pincode,
    total: Number(order.amount),
    status,
    fulfillmentStatus: order.fulfillment_status,
    items: items.map(item => ({ id: item.product_id, name: item.product_name, variant: item.variant_name ?? "", price: Number(item.unit_price), quantity: Number(item.quantity) })),
  };
}

export async function createCustomer(name: string, email: string, phone: string, password: string) {
  await ensureCatalogue();
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  const passwordHash = `${salt.toString("hex")}:${derived.toString("hex")}`;
  const id = randomUUID();
  await database().execute("INSERT INTO kalacar_users (id,name,email,phone,password_hash) VALUES (?,?,?,?,?)", [id, name, email, phone, passwordHash]);
  return { id, name, email, phone };
}

export async function authenticateCustomer(email: string, password: string) {
  await ensureCatalogue();
  const [rows] = await database().execute<(RowDataPacket & { id: string; name: string; email: string; phone: string; password_hash: string })[]>("SELECT id,name,email,phone,password_hash FROM kalacar_users WHERE email=?", [email]);
  const user = rows[0];
  if (!user) return null;
  const [saltHex, hashHex] = user.password_hash.split(":");
  const expected = Buffer.from(hashHex || "", "hex");
  const actual = await scrypt(password, Buffer.from(saltHex || "", "hex"), expected.length || 64) as Buffer;
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id: user.id, name: user.name, email: user.email, phone: user.phone };
}

/**
 * Find the account for a verified Google identity: by Google ID first, then by
 * verified email (linking an existing password account), else create one.
 * Google-only accounts get a password hash that can never match.
 */
export async function upsertGoogleCustomer(googleSub: string, email: string, name: string) {
  await ensureCatalogue();
  type UserRow = RowDataPacket & { id: string; name: string; email: string; phone: string; google_sub: string | null };
  const db = database();
  const [bySub] = await db.execute<UserRow[]>("SELECT id,name,email,phone,google_sub FROM kalacar_users WHERE google_sub=? LIMIT 1", [googleSub]);
  if (bySub[0]) return { id: bySub[0].id, name: bySub[0].name, email: bySub[0].email, phone: bySub[0].phone };
  const [byEmail] = await db.execute<UserRow[]>("SELECT id,name,email,phone,google_sub FROM kalacar_users WHERE email=? LIMIT 1", [email]);
  if (byEmail[0]) {
    if (byEmail[0].google_sub && byEmail[0].google_sub !== googleSub) throw new Error("This email is linked to a different Google account.");
    await db.execute("UPDATE kalacar_users SET google_sub=? WHERE id=? AND google_sub IS NULL", [googleSub, byEmail[0].id]);
    return { id: byEmail[0].id, name: byEmail[0].name, email: byEmail[0].email, phone: byEmail[0].phone };
  }
  const id = randomUUID();
  await db.execute("INSERT INTO kalacar_users (id,name,email,phone,password_hash,google_sub) VALUES (?,?,?,?,?,?)", [id, name.slice(0, 160), email, "", "google-oauth-only", googleSub]);
  return { id, name: name.slice(0, 160), email, phone: "" };
}

export async function createCustomerSession(userId: string) {
  await ensureCatalogue();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await database().execute("INSERT INTO kalacar_sessions (token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))", [tokenHash, userId]);
  return token;
}

export async function findCustomerBySession(token: string) {
  await ensureCatalogue();
  const hash = createHash("sha256").update(token).digest("hex");
  const [rows] = await database().execute<(RowDataPacket & { id: string; name: string; email: string; phone: string })[]>("SELECT u.id,u.name,u.email,u.phone FROM kalacar_sessions s JOIN kalacar_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP()", [hash]);
  return rows[0] ?? null;
}

export async function deleteCustomerSession(token: string) {
  await ensureCatalogue();
  const hash = createHash("sha256").update(token).digest("hex");
  await database().execute("DELETE FROM kalacar_sessions WHERE token_hash=?", [hash]);
}

export async function listCustomerOrders(userId: string) {
  await ensureCatalogue();
  const [orders] = await database().execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [userId]);
  return Promise.all(orders.map(async (order) => {
    const [items] = await database().execute<(RowDataPacket & { product_id: string; product_name: string; variant_name: string | null; unit_price: number; quantity: number })[]>("SELECT product_id,product_name,variant_name,unit_price,quantity FROM kalacar_order_items WHERE order_id=?", [order.id]);
    return { id: order.id, createdAt: order.created_at, amount: Number(order.amount), status: order.status, fulfillmentStatus: order.fulfillment_status, trackingCourier: order.tracking_courier ?? "", trackingId: order.tracking_id ?? "", giftWrap: Boolean(order.gift_wrap), giftWrapPrice: Number(order.gift_wrap_price ?? 0), couponCode: order.coupon_code ?? "", discount: Number(order.discount ?? 0), trackingNote: order.tracking_note ?? "", refundAmount: order.refund_amount === null ? null : Number(order.refund_amount), cancelReason: order.cancel_reason ?? "", email: order.email, phone: order.phone, address: order.address, pincode: order.pincode, razorpayOrderId: order.razorpay_order_id, paymentId: order.razorpay_payment_id, items: items.map(item => ({ id: item.product_id, name: item.product_name, variant: item.variant_name ?? "", price: Number(item.unit_price), quantity: Number(item.quantity) })) };
  }));
}

export async function findCustomerOrder(id: string, userId: string) {
  await ensureCatalogue();
  const [rows] = await database().execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=? AND user_id=?", [id, userId]);
  if (!rows[0]) return null;
  return findOrder(id);
}

export async function markOrderPaymentFailed(id: string, userId: string, paymentId: string) {
  await ensureCatalogue();
  await database().execute("UPDATE kalacar_orders SET status='payment_failed',razorpay_payment_id=? WHERE id=? AND user_id=? AND status='payment_pending'", [paymentId, id, userId]);
  signalOrder(id);
}

/** Tells open pages after the change is saved. Loaded late to keep this file free of it. */
function signalOrder(orderId: string, stockChanged = false) {
  void import("@/lib/realtime").then(live => live.announceOrder(orderId, stockChanged)).catch(() => undefined);
}

/** Runs only when an order first becomes paid, so each order alerts once. Loaded late to keep the database code free of it. */
function alertOwners(orderId: string) {
  void import("@/lib/owner-alerts").then(alerts => alerts.alertNewPaidOrder(orderId)).catch(() => undefined);
}

export async function recordRazorpayWebhook(eventId: string, eventType: string, payment: { id: string; order_id: string; amount: number; currency: string; status: string }) {
  await ensureCatalogue();
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [orderRows] = await connection.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE razorpay_order_id=? FOR UPDATE", [payment.order_id]);
    const order = orderRows[0];
    let newlyPaid = false;
    await connection.execute("INSERT IGNORE INTO kalacar_webhook_events (event_id,event_type) VALUES (?,?)", [eventId, eventType]);
    if (order && payment.amount === Number(order.amount) * 100 && payment.currency === "INR" && payment.status === "captured") {
      const [paid] = await connection.execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET status='paid',razorpay_payment_id=? WHERE id=? AND status IN ('payment_pending','payment_failed')", [payment.id, order.id]);
      // Money arrived for an order the owner already cancelled: hold it for a refund instead of silently reopening it.
      const [late] = await connection.execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET status='paid_after_cancel',razorpay_payment_id=? WHERE id=? AND status='cancelled'", [payment.id, order.id]);
      newlyPaid = paid.affectedRows > 0 || late.affectedRows > 0;
    }
    else if (order && payment.status === "failed") await connection.execute("UPDATE kalacar_orders SET status='payment_failed',razorpay_payment_id=? WHERE id=? AND status='payment_pending'", [payment.id, order.id]);
    await connection.commit();
    if (newlyPaid) alertOwners(order.id);
    if (order) signalOrder(order.id);
    return Boolean(order);
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function markOrderPaid(id: string, razorpayOrderId: string, paymentId: string) {
  await ensureCatalogue();
  // Only unpaid orders become paid. A cancelled order that gets paid is held for a refund; refunded orders never change.
  const [paid] = await database().execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET status='paid',razorpay_payment_id=? WHERE id=? AND razorpay_order_id=? AND status IN ('payment_pending','payment_failed')", [paymentId, id, razorpayOrderId]);
  const [late] = await database().execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET status='paid_after_cancel',razorpay_payment_id=? WHERE id=? AND razorpay_order_id=? AND status='cancelled'", [paymentId, id, razorpayOrderId]);
  if (paid.affectedRows > 0 || late.affectedRows > 0) { alertOwners(id); signalOrder(id); }
  const order = await findOrder(id);
  return order?.status === "paid";
}

/** Changes whenever an order is added or updated. */
export async function getOrdersStamp() {
  await ensureCatalogue();
  const [rows] = await database().query<(RowDataPacket & { total: number; latest: string | null })[]>("SELECT COUNT(*) AS total,CAST(MAX(updated_at) AS CHAR) AS latest FROM kalacar_orders");
  return `${rows[0]?.total ?? 0}:${rows[0]?.latest ?? ""}`;
}

/** Recent unpaid orders that have started a Razorpay payment, newest first. */
export async function listOrdersToRecheck() {
  await ensureCatalogue();
  const [rows] = await database().query<(RowDataPacket & { id: string; razorpay_order_id: string; amount: number; user_id: string })[]>("SELECT id,razorpay_order_id,amount,user_id FROM kalacar_orders WHERE status IN ('payment_pending','payment_failed') AND razorpay_order_id IS NOT NULL AND created_at > NOW() - INTERVAL 2 HOUR ORDER BY created_at DESC LIMIT 5");
  return rows.map(row => ({ id: row.id, razorpayOrderId: row.razorpay_order_id, amount: Number(row.amount), userId: row.user_id }));
}

/** Unpaid orders placed more than `minutes` ago, oldest first. */
export async function listExpiredUnpaidOrders(minutes: number) {
  await ensureCatalogue();
  const [rows] = await database().query<(RowDataPacket & { id: string; razorpay_order_id: string | null; amount: number; user_id: string | null })[]>("SELECT id,razorpay_order_id,amount,user_id FROM kalacar_orders WHERE status IN ('payment_pending','payment_failed') AND created_at < NOW() - INTERVAL ? MINUTE ORDER BY created_at LIMIT 20", [minutes]);
  return rows.map(row => ({ id: row.id, razorpayOrderId: row.razorpay_order_id, amount: Number(row.amount), userId: row.user_id ?? "" }));
}

export async function listOrders(filter: OrderStatusFilter = "all") {
  await ensureCatalogue();
  const condition = filter === "all" ? "" : `WHERE ${orderStatusConditions[filter]}`;
  const [orders] = await database().query<OrderRow[]>(`SELECT * FROM kalacar_orders ${condition} ORDER BY created_at DESC LIMIT 100`);
  return Promise.all(orders.map(async order => {
    const [items] = await database().execute<(RowDataPacket & { product_name: string; variant_name: string | null; quantity: number })[]>("SELECT product_name,variant_name,quantity FROM kalacar_order_items WHERE order_id=?", [order.id]);
    const status = statusLabel(order.status);
    return { rawStatus: order.status, id: order.id, date: order.created_at, customer: order.customer_name, email: order.email, phone: order.phone, address: order.address, pincode: order.pincode, total: Number(order.amount), status, fulfillmentStatus: order.fulfillment_status, trackingNote: order.tracking_note ?? "", trackingCourier: order.tracking_courier ?? "", trackingId: order.tracking_id ?? "", giftWrap: Boolean(order.gift_wrap), item: items.map(row => `${row.product_name}${row.variant_name && row.variant_name !== "Standard" ? ` (${row.variant_name})` : ""} · ${row.quantity}`).join(", ") };
  }));
}

export async function getAdminMetrics() {
  await ensureCatalogue();
  const connection = await database().getConnection();
  const configuredThreshold = Number(process.env.KALACAR_LOW_STOCK_THRESHOLD ?? "3");
  const lowStockThreshold = Number.isSafeInteger(configuredThreshold) && configuredThreshold >= 1 && configuredThreshold <= 1_000_000 ? configuredThreshold : 3;
  let originalTimeZone: string | undefined;
  let reusableConnection = true;
  try {
    const [timeZoneRows] = await connection.query<(RowDataPacket & { session_time_zone: string })[]>("SELECT @@session.time_zone AS session_time_zone");
    const sessionTimeZone = String(timeZoneRows[0]?.session_time_zone ?? "");
    if (!/^(SYSTEM|[+-]\d{2}:\d{2}|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*)$/.test(sessionTimeZone)) throw new Error("Database session timezone is not recognized.");
    originalTimeZone = sessionTimeZone;
    await connection.query("SET SESSION time_zone = '+05:30'");

    const [orderRows] = await connection.query<(RowDataPacket & {
      total_orders: number | string;
      paid_orders: number | string;
      revenue_today: number | string;
      revenue_month: number | string;
      paid_revenue: number | string;
      fulfillment_needed: number | string;
      payment_recovery: number | string;
    })[]>(`SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS paid_orders,
      COALESCE(SUM(CASE WHEN status='paid' AND DATE(created_at)=CURRENT_DATE THEN amount ELSE 0 END),0) AS revenue_today,
      COALESCE(SUM(CASE WHEN status='paid' AND YEAR(created_at)=YEAR(CURRENT_DATE) AND MONTH(created_at)=MONTH(CURRENT_DATE) THEN amount ELSE 0 END),0) AS revenue_month,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_revenue,
      COALESCE(SUM(CASE WHEN status='paid' AND fulfillment_status='unfulfilled' THEN 1 ELSE 0 END),0) AS fulfillment_needed,
      COALESCE(SUM(CASE WHEN status IN ('payment_failed','payment_setup_failed') THEN 1 ELSE 0 END),0) AS payment_recovery
      FROM kalacar_orders`);
    const [productRows] = await connection.execute<(RowDataPacket & { low_stock_products: number | string; out_of_stock_products: number | string })[]>(`SELECT
      COALESCE(SUM(CASE WHEN stock > 0 AND stock <= ? THEN 1 ELSE 0 END),0) AS low_stock_products,
      COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END),0) AS out_of_stock_products
      FROM kalacar_product_variants WHERE active=1`, [lowStockThreshold]);
    const orderStats = orderRows[0];
    const paidOrders = Number(orderStats?.paid_orders ?? 0);
    const paidRevenue = Number(orderStats?.paid_revenue ?? 0);
    return {
      todayRevenue: Number(orderStats?.revenue_today ?? 0),
      monthRevenue: Number(orderStats?.revenue_month ?? 0),
      totalOrders: Number(orderStats?.total_orders ?? 0),
      paidOrders,
      averageOrderValue: paidOrders ? Math.round((paidRevenue / paidOrders) * 100) / 100 : 0,
      lowStockProducts: Number(productRows[0]?.low_stock_products ?? 0),
      outOfStockProducts: Number(productRows[0]?.out_of_stock_products ?? 0),
      lowStockThreshold,
      fulfillmentNeeded: Number(orderStats?.fulfillment_needed ?? 0),
      paymentRecovery: Number(orderStats?.payment_recovery ?? 0),
    };
  } finally {
    if (originalTimeZone !== undefined) {
      try { await connection.query(`SET SESSION time_zone = '${originalTimeZone}'`); }
      catch { connection.destroy(); reusableConnection = false; }
    }
    if (reusableConnection) connection.release();
  }
}

export type FulfillmentStatus = "unfulfilled" | "processing" | "dispatched" | "completed";

/** The owner may set any delivery status on a paid order, and go back to correct a mistake. Refuses if it changed since the owner last saw it. */
export async function updateOrderFulfillment(id: string, fulfillmentStatus: FulfillmentStatus, expected: FulfillmentStatus) {
  await ensureCatalogue();
  const [result] = await database().execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET fulfillment_status=? WHERE id=? AND status='paid' AND fulfillment_status=?", [fulfillmentStatus, id, expected]);
  if (result.affectedRows > 0) signalOrder(id);
  return result.affectedRows > 0;
}



/** Puts an order's items back into stock once (guarded by stock_restored). Call inside a transaction holding the order row lock. */
async function restoreOrderStock(connection: mysql.PoolConnection, orderId: string) {
  await returnItemsToStock(connection, orderId);
  await connection.execute("UPDATE kalacar_orders SET stock_restored=1 WHERE id=?", [orderId]);
}

type LifecycleResult = { ok: true } | { ok: false; error: string; status: number };

/** Owner cancels an unpaid order: releases its reserved stock. Paid orders must be refunded instead. */
export async function cancelUnpaidOrder(id: string, reason: string): Promise<LifecycleResult> {
  await ensureCatalogue();
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=? FOR UPDATE", [id]);
    const order = rows[0];
    if (!order) { await connection.rollback(); return { ok: false, error: "Order not found.", status: 404 }; }
    if (!["payment_pending", "payment_failed", "payment_setup_failed"].includes(order.status)) {
      await connection.rollback();
      return { ok: false, error: order.status === "paid" ? "This order is paid. Record a refund instead of cancelling." : "Only unpaid orders can be cancelled.", status: 409 };
    }
    // payment_setup_failed orders already released their stock when setup failed.
    if (!order.stock_restored && order.status !== "payment_setup_failed") await restoreOrderStock(connection, id);
    await connection.execute("UPDATE kalacar_orders SET status='cancelled',cancel_reason=?,cancelled_at=UTC_TIMESTAMP() WHERE id=?", [reason || null, id]);
    await connection.commit();
    signalOrder(id, true);
    return { ok: true };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

/**
 * Records a refund the owner has issued in the Razorpay dashboard. Does not move money itself.
 * Optionally restocks items that were never dispatched.
 */
export async function recordOrderRefund(id: string, refund: { amount: number; reason: string; reference: string; restock: boolean }): Promise<LifecycleResult> {
  await ensureCatalogue();
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<OrderRow[]>("SELECT * FROM kalacar_orders WHERE id=? FOR UPDATE", [id]);
    const order = rows[0];
    if (!order) { await connection.rollback(); return { ok: false, error: "Order not found.", status: 404 }; }
    if (!["paid", "paid_after_cancel"].includes(order.status)) { await connection.rollback(); return { ok: false, error: "Only paid orders can be refunded.", status: 409 }; }
    if (!Number.isSafeInteger(refund.amount) || refund.amount < 1 || refund.amount > Number(order.amount)) { await connection.rollback(); return { ok: false, error: `Refund must be between ₹1 and ₹${order.amount}.`, status: 400 }; }
    const notShipped = ["unfulfilled", "processing"].includes(order.fulfillment_status);
    if (refund.restock && !notShipped) { await connection.rollback(); return { ok: false, error: "Items already dispatched can't be restocked automatically. Adjust stock in Products when they come back.", status: 409 }; }
    // A paid-after-cancel order already gave its stock back when it was cancelled.
    if (refund.restock && !order.stock_restored && order.status === "paid") await restoreOrderStock(connection, id);
    await connection.execute("UPDATE kalacar_orders SET status='refunded',refund_amount=?,refund_reason=?,refund_reference=?,refunded_at=UTC_TIMESTAMP() WHERE id=?", [refund.amount, refund.reason, refund.reference || null, id]);
    await connection.commit();
    signalOrder(id, true);
    return { ok: true };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

/** Courier/tracking note shown to the customer. Only for paid orders. Empty text clears it. */
export async function setOrderTracking(id: string, tracking: { note: string; courier: string | null; trackingId: string | null }) {
  await ensureCatalogue();
  const [result] = await database().execute<mysql.ResultSetHeader>("UPDATE kalacar_orders SET tracking_note=?,tracking_courier=?,tracking_id=? WHERE id=? AND status='paid'", [tracking.note || null, tracking.courier, tracking.trackingId, id]);
  if (result.affectedRows > 0) signalOrder(id);
  return result.affectedRows > 0;
}
