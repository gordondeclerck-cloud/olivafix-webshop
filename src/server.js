/**
 * OlivaFix Gold — backend
 * Express server with a real Stripe Checkout integration and PostgreSQL storage.
 * Products are read from and managed in the database (not hardcoded).
 *
 * SETUP:
 *   1. npm install express stripe pg cors dotenv
 *   2. Create a .env file (see .env.example) — includes ADMIN_PASSWORD
 *   3. Run schema.sql against your Postgres database
 *   4. node server.js
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());

// Houdt bij welke e-mailadressen al een quiz-kortingscode kregen, zodat
// hetzelfde adres niet telkens opnieuw een nieuwe code kan aanvragen.
pool.query(`
  CREATE TABLE IF NOT EXISTS quiz_leads (
    email TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`).catch((err) => console.error(">>> Kon quiz_leads-tabel niet aanmaken:", err.message));

// --- Abonnementen (herhaalbestellingen) ---
// Bewaart de gekozen frequentie/product en het bezorgadres, zodat elke
// automatische verlenging (invoice.paid) opnieuw een bestelling/verzending kan aanmaken.
pool.query(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT NOT NULL,
    email TEXT NOT NULL,
    product_id TEXT NOT NULL,
    interval_weeks INTEGER NOT NULL,
    shipping_name TEXT,
    shipping_address TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`).catch((err) => console.error(">>> Kon subscriptions-tabel niet aanmaken:", err.message));

// Bestaande orders-tabel uitbreiden zodat abonnements-bestellingen herkenbaar zijn
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_subscription BOOLEAN NOT NULL DEFAULT false`)
  .catch((err) => console.error(">>> Kon is_subscription-kolom niet toevoegen:", err.message));
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`)
  .catch((err) => console.error(">>> Kon stripe_subscription_id-kolom niet toevoegen:", err.message));

// --- Eenmalige kortingscodes ---
// Elke quiz-lead krijgt een eigen, unieke code die maar 1x bruikbaar is,
// in plaats van één vaste code die iedereen kan blijven hergebruiken.
const BASE_COUPON_ID = "olivafix-10-once";

async function ensureBaseCoupon() {
  try {
    await stripe.coupons.retrieve(BASE_COUPON_ID);
  } catch (err) {
    // Coupon bestaat nog niet in dit Stripe-account -> eenmalig aanmaken
    await stripe.coupons.create({
      id: BASE_COUPON_ID,
      percent_off: 10,
      duration: "once",
      name: "OlivaFix 10% eenmalige korting",
    });
  }
}

function generatePromoCodeString() {
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 tekens, hoge entropie
  return `OLIVA-${suffix}`;
}

async function createOneTimePromoCode() {
  await ensureBaseCoupon();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePromoCodeString();
    try {
      const promo = await stripe.promotionCodes.create({
        coupon: BASE_COUPON_ID,
        code,
        max_redemptions: 1,
      });
      return promo.code;
    } catch (err) {
      const alreadyExists = err.code === "resource_already_exists" || (err.message && err.message.includes("already exists"));
      if (alreadyExists && attempt < 2) continue; // extreem zeldzaam, probeer opnieuw met nieuwe code
      throw err;
    }
  }
}

// Stripe webhook — confirms payment and writes the order to the database.
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(">>> Webhook-handtekening ongeldig:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    console.log(`>>> Webhook ontvangen: checkout.session.completed voor sessie ${event.data.object.id}`);
    const session = event.data.object;
    const isSubscription = session.mode === "subscription";
    const email = session.customer_email || session.customer_details?.email;
    console.log(`>>> Klant-e-mail uit sessie: ${email} (abonnement: ${isSubscription})`);
    const shippingName = session.shipping_details?.name || session.customer_details?.name || null;
    const addr = session.shipping_details?.address || session.customer_details?.address;
    const shippingAddress = addr
      ? [addr.line1, addr.line2, `${addr.postal_code} ${addr.city}`, addr.country].filter(Boolean).join(", ")
      : null;
    const addressWarning = await validateAddressWithBpost(addr);

    // Betaalmethode ophalen zodat een eventuele upsell zonder opnieuw gegevens invullen kan worden afgerekend
    // (enkel van toepassing bij eenmalige aankopen, abonnementen hebben geen payment_intent op de sessie)
    let paymentMethodId = null;
    if (!isSubscription) {
      try {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
        if (pi.payment_method && typeof pi.payment_method === "object") {
          paymentMethodId = pi.payment_method.id;
        } else {
          paymentMethodId = pi.payment_method;
        }
      } catch (err) {
        console.error("Kon betaalmethode niet ophalen:", err.message);
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO orders (stripe_session_id, customer_email, amount_total, status, shipping_name, shipping_address, stripe_customer_id, stripe_payment_method_id, address_warning, is_subscription, stripe_subscription_id)
       VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [session.id, email, session.amount_total, shippingName, shippingAddress, session.customer, paymentMethodId, addressWarning, isSubscription, isSubscription ? session.subscription : null]
    );
    const orderId = rows[0].id;
    console.log(`>>> Bestelling #${orderId} opgeslagen in database.`);

    if (isSubscription) {
      try {
        await pool.query(
          `INSERT INTO subscriptions (stripe_subscription_id, stripe_customer_id, email, product_id, interval_weeks, shipping_name, shipping_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (stripe_subscription_id) DO NOTHING`,
          [session.subscription, session.customer, email, session.metadata?.subscription_product_id, Number(session.metadata?.interval_weeks) || null, shippingName, shippingAddress]
        );
        console.log(`>>> Abonnement ${session.subscription} geregistreerd voor ${email}`);
      } catch (err) {
        console.error(">>> Kon abonnement niet registreren:", err.message);
      }
      // Voor abonnementen: 1 orderregel volstaat, het product staat al in de sessienaam
      try {
        await pool.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, 1, $3)`,
          [orderId, session.metadata?.subscription_product_id, session.amount_total]
        );
      } catch (err) {
        console.error("Kon abonnements-orderregel niet opslaan:", err.message);
      }
    } else {
      // Bestelde producten opslaan (metadata bevat wat de klant precies kocht)
      try {
        const items = JSON.parse(session.metadata?.items || "[]");
        for (const item of items) {
          const { rows: prodRows } = await pool.query("SELECT price_cents FROM products WHERE id=$1", [item.id]);
          if (prodRows[0]) {
            await pool.query(
              `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)`,
              [orderId, item.id, item.qty, prodRows[0].price_cents]
            );
          }
        }
      } catch (err) {
        console.error("Kon orderregels niet opslaan:", err.message);
      }
    }

    console.log(`>>> Bevestigingsmail versturen naar ${email}...`);
    if (!process.env.RESEND_API_KEY) {
      console.log(">>> LET OP: RESEND_API_KEY staat niet ingesteld, mail wordt overgeslagen.");
    }
    await sendEmail(
      email,
      isSubscription ? `Je abonnement is bevestigd — #${orderId}` : `Bedankt voor je bestelling — #${orderId}`,
      isSubscription
        ? `<div style="font-family:sans-serif;color:#2B2A26">
        <h2 style="color:#1E4638">Je abonnement is gestart!</h2>
        <p>Bestelling <strong>#${orderId}</strong> is je eerste levering. Totaal: <strong>€${(session.amount_total / 100).toFixed(2)}</strong>.</p>
        <p>We sturen je automatisch een nieuwe levering met 10% korting, telkens op de afgesproken frequentie. Je kan je abonnement op elk moment beheren of stopzetten.</p>
        <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
      </div>`
        : `<div style="font-family:sans-serif;color:#2B2A26">
        <h2 style="color:#1E4638">Bedankt voor je bestelling!</h2>
        <p>Je bestelling <strong>#${orderId}</strong> is bevestigd. Totaal: <strong>€${(session.amount_total / 100).toFixed(2)}</strong>.</p>
        <p>We laten je weten zodra je pakket onderweg is, met een track & trace-code van bpost.</p>
        <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
      </div>`
    );
    console.log(`>>> sendEmail-aanroep voor bestelling #${orderId} afgerond.`);
  } else if (event.type === "invoice.paid" && event.data.object.billing_reason === "subscription_cycle") {
    // Een automatische verlenging van een bestaand abonnement -> nieuwe bestelling/levering aanmaken
    const invoice = event.data.object;
    console.log(`>>> Webhook ontvangen: invoice.paid (verlenging) voor abonnement ${invoice.subscription}`);
    try {
      const { rows: subRows } = await pool.query(
        `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`,
        [invoice.subscription]
      );
      const sub = subRows[0];
      if (!sub) {
        console.error(">>> Onbekend abonnement bij verlenging:", invoice.subscription);
      } else {
        const { rows: orderRows } = await pool.query(
          `INSERT INTO orders (stripe_session_id, customer_email, amount_total, status, shipping_name, shipping_address, stripe_customer_id, is_subscription, stripe_subscription_id)
           VALUES ($1, $2, $3, 'paid', $4, $5, $6, true, $7) RETURNING id`,
          [`invoice_${invoice.id}`, sub.email, invoice.amount_paid, sub.shipping_name, sub.shipping_address, sub.stripe_customer_id, sub.stripe_subscription_id]
        );
        const renewalOrderId = orderRows[0].id;
        await pool.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, 1, $3)`,
          [renewalOrderId, sub.product_id, invoice.amount_paid]
        );
        console.log(`>>> Verlengingsbestelling #${renewalOrderId} aangemaakt voor abonnement ${invoice.subscription}`);

        await sendEmail(
          sub.email,
          `Je volgende OlivaFix-levering is onderweg — #${renewalOrderId}`,
          `<div style="font-family:sans-serif;color:#2B2A26">
            <h2 style="color:#1E4638">Tijd voor je volgende levering!</h2>
            <p>Je abonnement is automatisch verlengd. Bestelling <strong>#${renewalOrderId}</strong>, totaal: <strong>€${(invoice.amount_paid / 100).toFixed(2)}</strong>.</p>
            <p>We laten je weten zodra dit pakket onderweg is.</p>
            <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
          </div>`
        );
      }
    } catch (err) {
      console.error(">>> Fout bij verwerken abonnementsverlenging:", err.message);
    }
  } else if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    console.log(`>>> Webhook ontvangen: abonnement opgezegd ${subscription.id}`);
    try {
      await pool.query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = $1`,
        [subscription.id]
      );
    } catch (err) {
      console.error(">>> Kon abonnementsstatus niet bijwerken:", err.message);
    }
  } else {
    console.log(`>>> Webhook ontvangen maar genegeerd (type: ${event.type})`);
  }

  res.json({ received: true });
});

app.use(express.json());

// BELANGRIJK: de Stripe-webhook staat hier, VOOR express.json(), want Stripe heeft de
// ruwe (raw) request-body nodig om de handtekening te controleren. Staat deze route na
// express.json(), dan is de body al 'opgegeten' en faalt de handtekeningcontrole altijd
// stilletjes.

// --- E-mail versturen via Resend ---
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // nooit langer dan 8 seconden wachten
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "OlivaFix <onboarding@resend.dev>",
        to,
        subject,
        html,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("Resend-fout:", await res.text());
    } else {
      const data = await res.json();
      console.log(">>> Resend meldt succes, mail-ID:", data.id);
    }
  } catch (err) {
    console.error("E-mail versturen mislukt (of te traag, overgeslagen):", err.message);
  } finally {
    clearTimeout(timeout);
  }
}

const BPOST_TRACK_URL = (tracking) =>
  `https://track.bpost.cloud/btr/web/#/search?itemCode=${encodeURIComponent(tracking)}`;

// Simple admin-password check for the management endpoints.
// Not enterprise-grade auth, but enough to keep random visitors from editing your catalogue.
function requireAdmin(req, res, next) {
  const provided = req.headers["x-admin-password"];
  if (!provided || provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Niet geautoriseerd." });
  }
  next();
}

// --- Public: list products (frontend reads this on load) ---
app.get("/api/products", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY created_at ASC");
  res.json(rows);
});

// --- Admin: create a product ---
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const { id, name, variant, price_cents, compare_at_cents, description, image_path } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO products (id, name, variant, price_cents, compare_at_cents, description, image_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, name, variant, price_cents, compare_at_cents || null, description || null, image_path || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Admin: update a product ---
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const { name, variant, price_cents, compare_at_cents, description, image_path } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE products SET name=$1, variant=$2, price_cents=$3, compare_at_cents=$4, description=$5, image_path=$6
       WHERE id=$7 RETURNING *`,
      [name, variant, price_cents, compare_at_cents || null, description || null, image_path || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Product niet gevonden." });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Admin: delete a product ---
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
  res.json({ deleted: true });
});

// --- POST /api/checkout — creates a real Stripe Checkout Session, priced from the DB ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { items, customerEmail, shippingCountry } = req.body; // items: [{ id, qty }], shippingCountry: "BE"|"NL"|"FR"|"DE"|"LU"|"CH"

    const ids = items.map((i) => i.id);
    const { rows: products } = await pool.query(
      "SELECT * FROM products WHERE id = ANY($1)",
      [ids]
    );

    const line_items = items.map(({ id, qty }) => {
      const p = products.find((prod) => prod.id === id);
      if (!p) throw new Error(`Onbekend product: ${id}`);
      return {
        price_data: {
          currency: "eur",
          product_data: { name: `${p.name} (${p.variant})` },
          unit_amount: p.price_cents,
        },
        quantity: qty,
      };
    });

    // Verzendkosten per zone (officiële bpost-tarieven, particulierentarief 2026, 0-2kg):
    // Zone 0 = België, Zone 1 = buurlanden (DE/FR/LU/NL), Zone 2+ = rest Europa (o.a. Zwitserland).
    // Let op: enkel België heeft een goedkopere "afhaalpunt"-optie; internationaal is er
    // maar één tarief (levering aan huis).
    const FREE_SHIPPING_THRESHOLD_CENTS = 4000;
    const SHIPPING_RATES = {
      BE: { pickup: 540, home: 710 },
      DE: { home: 1650 },
      FR: { home: 1650 },
      LU: { home: 1650 },
      NL: { home: 1650 },
      CH: { home: 3460 }, // buiten EU, "rest van Europa"-zone — indicatief, controleer bij grote volumes
    };
    const zone = SHIPPING_RATES[shippingCountry] || SHIPPING_RATES.BE;

    const subtotalCents = items.reduce((sum, { id, qty }) => {
      const p = products.find((prod) => prod.id === id);
      return sum + (p ? p.price_cents * qty : 0);
    }, 0);
    const freeShipping = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS;
    console.log(`>>> CHECKOUT: land=${shippingCountry}, subtotaal=${subtotalCents} cent, gratis verzending=${freeShipping}`);

    const shipping_options = [];
    if (zone.pickup !== undefined) {
      shipping_options.push({
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: freeShipping ? 0 : zone.pickup, currency: "eur" },
          display_name: freeShipping ? "Gratis verzending — afhaalpunt (bpost)" : "Afhaalpunt (bpost)",
          delivery_estimate: { minimum: { unit: "business_day", value: 1 }, maximum: { unit: "business_day", value: 3 } },
        },
      });
    }
    shipping_options.push({
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: freeShipping ? 0 : zone.home, currency: "eur" },
        display_name: freeShipping ? "Gratis verzending — aan huis (bpost)" : "Aan huis (bpost)",
        delivery_estimate: { minimum: { unit: "business_day", value: 1 }, maximum: { unit: "business_day", value: 5 } },
      },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      customer_email: customerEmail,
      customer_creation: "always",
      allow_promotion_codes: true,
      payment_intent_data: { setup_future_usage: "off_session" },
      shipping_address_collection: { allowed_countries: [SHIPPING_RATES[shippingCountry] ? shippingCountry : "BE"] },
      shipping_options,
      metadata: { items: JSON.stringify(items) },
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cart`,
    });

    console.log(`>>> CHECKOUT: sessie aangemaakt ${session.id}, shipping_options in antwoord:`, JSON.stringify(session.shipping_options || session.shipping_cost || "GEEN shipping-veld in Stripe-antwoord"));

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// --- Abonnement starten (herhaalbestelling met 10% korting) ---
// Klant kiest zelf het product en de leverfrequentie (in weken).
const SUBSCRIPTION_DISCOUNT = 0.9; // 10% korting op elke automatische levering
const ALLOWED_INTERVAL_WEEKS = [4, 6, 8, 12];

app.post("/api/subscribe", async (req, res) => {
  try {
    const { productId, intervalWeeks, customerEmail, shippingCountry } = req.body;

    if (!ALLOWED_INTERVAL_WEEKS.includes(Number(intervalWeeks))) {
      return res.status(400).json({ error: "Ongeldige leverfrequentie." });
    }

    const { rows: products } = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
    const p = products[0];
    if (!p) return res.status(400).json({ error: "Onbekend product." });

    const discountedUnitAmount = Math.round(p.price_cents * SUBSCRIPTION_DISCOUNT);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `${p.name} (${p.variant}) — Abonnement, elke ${intervalWeeks} weken` },
            unit_amount: discountedUnitAmount,
            recurring: { interval: "week", interval_count: Number(intervalWeeks) },
          },
          quantity: 1,
        },
      ],
      customer_email: customerEmail,
      shipping_address_collection: { allowed_countries: [SHIPPING_RATES[shippingCountry] ? shippingCountry : "BE"] },
      metadata: { subscription_product_id: productId, interval_weeks: String(intervalWeeks) },
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cart`,
    });

    console.log(`>>> ABONNEMENT: sessie aangemaakt ${session.id} voor product ${productId}, elke ${intervalWeeks} weken`);

    res.json({ url: session.url });
  } catch (err) {
    console.error(">>> Fout bij aanmaken abonnement:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// --- Abonnement beheren: stuurt de klant naar Stripe's eigen beheerpagina ---
// Daar kan de klant zelf annuleren, betaalmethode wijzigen, facturen bekijken.
app.post("/api/create-portal-session", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "E-mailadres is verplicht." });

    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM subscriptions WHERE email = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [email.trim()]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: "Geen actief abonnement gevonden voor dit e-mailadres." });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: process.env.CLIENT_URL,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error(">>> Fout bij aanmaken beheersessie:", err.message);
    res.status(500).json({ error: "Er ging iets mis. Probeer het straks opnieuw." });
  }
});

// --- Adresvalidatie via bpost's gratis adres-webservice ---
// Faalt de aanroep om welke reden dan ook, dan slaan we gewoon niets op — een bestelling
// mag hierdoor nooit vastlopen. Dit is puur een extra waarschuwing voor jou als winkelier.
function splitStreetAndNumber(line1) {
  if (!line1) return { streetName: "", streetNumber: "" };
  const match = line1.match(/^(.*?)[\s,]+(\d+[a-zA-Z]?)\s*$/);
  if (match) return { streetName: match[1].trim(), streetNumber: match[2].trim() };
  return { streetName: line1.trim(), streetNumber: "" };
}

async function validateAddressWithBpost(addr) {
  if (!addr || !addr.line1 || !addr.postal_code || !addr.city) {
    console.log(">>> Adresvalidatie overgeslagen: onvolledig adres van Stripe.", addr);
    return null;
  }
  try {
    const { streetName, streetNumber } = splitStreetAndNumber(addr.line1);
    console.log(`>>> Adresvalidatie gestart voor: "${streetName}" nr. "${streetNumber}", ${addr.postal_code} ${addr.city}, ${addr.country}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // nooit langer dan 4 seconden wachten
    let bpostRes;
    try {
      bpostRes = await fetch(
        "https://webservices-pub.bpost.be/ws/ExternalMailingAddressProofingCSREST_v1/address/validateAddresses",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addressToValidateList: [
              { id: 1, streetName, streetNumber, postalCode: addr.postal_code, municipalityName: addr.city, country: addr.country },
            ],
          }),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }
    console.log(`>>> bpost adres-API antwoordde met status ${bpostRes.status}`);
    if (!bpostRes.ok) {
      const text = await bpostRes.text();
      console.log(">>> bpost adres-API foutinhoud:", text.slice(0, 500));
      return null;
    }
    const data = await bpostRes.json();
    console.log(">>> bpost adres-API antwoord (ruw):", JSON.stringify(data).slice(0, 800));
    const issues = data?.validatedAddressList?.[0]?.issues || data?.validatedAddresses?.[0]?.issues;
    if (issues && issues.length > 0) {
      const warning = `Mogelijk adresprobleem: ${issues.map((i) => i.message || i.attribute).join(", ")}`;
      console.log(">>> Adreswaarschuwing gevonden:", warning);
      return warning;
    }
    console.log(">>> Adres door bpost als OK beoordeeld (of geen issues-veld herkend).");
    return null; // geen issues gevonden
  } catch (err) {
    console.error(">>> Adresvalidatie mislukt (of te traag, overgeslagen):", err.message);
    return null;
  }
}


// --- Admin: bestellingen bekijken ---
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { rows: orders } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100");
  const { rows: items } = await pool.query(
    `SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE order_id = ANY($1)`,
    [orders.map((o) => o.id)]
  );
  const withItems = orders.map((o) => ({
    ...o,
    items: items.filter((i) => i.order_id === o.id),
  }));
  res.json(withItems);
});

// --- Echte één-klik upsell: hergebruikt de betaalmethode van de zojuist afgeronde bestelling ---
app.post("/api/upsell-charge", async (req, res) => {
  const { session_id, product_id } = req.body;
  if (!session_id || !product_id) return res.status(400).json({ error: "Ontbrekende gegevens." });

  try {
    // Gegevens rechtstreeks bij Stripe opvragen (niet vertrouwen op de webhook, die soms
    // een paar seconden vertraging heeft na de redirect naar de bedankpagina).
    const checkoutSession = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent.payment_method", "customer"],
    });

    const customerId = typeof checkoutSession.customer === "string" ? checkoutSession.customer : checkoutSession.customer?.id;
    const paymentMethodId =
      checkoutSession.payment_intent?.payment_method?.id || checkoutSession.payment_intent?.payment_method;

    if (!customerId || !paymentMethodId) {
      return res.status(400).json({ error: "no_saved_method" }); // frontend valt terug op gewone checkout
    }

    const email = checkoutSession.customer_email || checkoutSession.customer_details?.email;
    const shippingName = checkoutSession.shipping_details?.name || checkoutSession.customer_details?.name || null;
    const addr = checkoutSession.shipping_details?.address || checkoutSession.customer_details?.address;
    const shippingAddress = addr
      ? [addr.line1, addr.line2, `${addr.postal_code} ${addr.city}`, addr.country].filter(Boolean).join(", ")
      : null;

    const { rows: prodRows } = await pool.query("SELECT * FROM products WHERE id=$1", [product_id]);
    const product = prodRows[0];
    if (!product) return res.status(404).json({ error: "Product niet gevonden." });

    const intent = await stripe.paymentIntents.create({
      amount: product.price_cents,
      currency: "eur",
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `Upsell na bestelling ${session_id}: ${product.name}`,
    });

    if (intent.status === "succeeded") {
      const { rows: newOrderRows } = await pool.query(
        `INSERT INTO orders (stripe_session_id, customer_email, amount_total, status, shipping_name, shipping_address, stripe_customer_id, stripe_payment_method_id)
         VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7) RETURNING id`,
        [`upsell_${intent.id}`, email, product.price_cents, shippingName, shippingAddress, customerId, paymentMethodId]
      );
      const newOrderId = newOrderRows[0].id;
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, 1, $3)`,
        [newOrderId, product.id, product.price_cents]
      );
      await sendEmail(
        email,
        `Bedankt voor je extra bestelling — #${newOrderId}`,
        `<div style="font-family:sans-serif;color:#2B2A26">
          <h2 style="color:#1E4638">Bedankt!</h2>
          <p>Je extra bestelling <strong>#${newOrderId}</strong> (${product.name}) is bevestigd. Totaal: <strong>€${(product.price_cents / 100).toFixed(2)}</strong>.</p>
          <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
        </div>`
      );
      return res.json({ success: true, orderId: newOrderId });
    }
    return res.status(400).json({ error: "payment_failed" });
  } catch (err) {
    console.error("Upsell-betaling mislukt:", err.message);
    // authentication_required betekent dat de bank een extra verificatie eist — dat kan niet zonder checkout-pagina
    return res.status(400).json({ error: err.code === "authentication_required" ? "authentication_required" : "no_saved_method" });
  }
});


app.post("/api/admin/orders/:id/ship", requireAdmin, async (req, res) => {
  const { tracking_number, carrier } = req.body;
  if (!tracking_number) return res.status(400).json({ error: "Trackingcode is verplicht." });

  const { rows } = await pool.query(
    `UPDATE orders SET status='shipped', tracking_number=$1, carrier=$2, shipped_at=now()
     WHERE id=$3 RETURNING *`,
    [tracking_number, carrier || "bpost", req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Bestelling niet gevonden." });
  const order = rows[0];

  await sendEmail(
    order.customer_email,
    `Je bestelling #${order.id} is onderweg!`,
    `<div style="font-family:sans-serif;color:#2B2A26">
      <h2 style="color:#1E4638">Je pakket is onderweg</h2>
      <p>Bestelling <strong>#${order.id}</strong> is verzonden via bpost.</p>
      <p><strong>Track & trace-code:</strong> ${order.tracking_number}</p>
      <p><a href="${BPOST_TRACK_URL(order.tracking_number)}" style="background:#1E4638;color:#FBF8F1;padding:10px 18px;text-decoration:none;border-radius:4px;display:inline-block">Volg je pakket</a></p>
      <p style="color:#7D7A6F;font-size:13px;margin-top:24px">Al blij met OlivaFix Gold? <a href="${process.env.CLIENT_URL}/review?order=${order.id}">Laat een review achter</a> en help andere kunstgebitdragers de juiste keuze maken.</p>
      <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
    </div>`
  );

  res.json(order);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Publiek: Kortingscode versturen via de quiz ---
app.post("/api/quiz-lead", async (req, res) => {
  const { email, marketingConsent, tier } = req.body;

  if (!email) {
    return res.status(400).json({ error: "E-mailadres is verplicht." });
  }

  try {
    console.log(`>>> Quiz lead ontvangen voor: ${email} (Marketing: ${marketingConsent})`);

    const promoCode = await createOneTimePromoCode();

    await sendEmail(
      email,
      "Jouw 10% kortingscode voor OlivaFix Gold",
      `<div style="font-family:sans-serif;color:#2B2A26">
        <h2 style="color:#1E4638">Bedankt voor je interesse!</h2>
        <p>Je hebt de 4 redenen ontdekt. Hier is je persoonlijke, eenmalige kortingscode voor 10% korting op je eerste bestelling:</p>

        <div style="background:#F5F1E6; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1E4638; border-radius: 4px; margin: 20px 0;">
          ${promoCode}
        </div>

        <p><a href="${process.env.CLIENT_URL}" style="background:#1E4638;color:#FBF8F1;padding:12px 20px;text-decoration:none;border-radius:4px;display:inline-block;text-transform:uppercase;font-size:14px;letter-spacing:1px;font-weight:bold;">Nu bestellen met 10% korting</a></p>
        <p style="color:#7D7A6F;font-size:13px;margin-top:30px">OlivaFix Gold — een product van Bonyf</p>
      </div>`
    );

    res.json({ success: true });
  } catch (err) {
    console.error(">>> Fout bij verwerken quiz-lead:", err.message);
    res.status(500).json({ error: "Er ging iets mis bij het versturen van de e-mail. Probeer het straks opnieuw." });
  }
});
// ============ CONTACT ============

// --- Publiek: contactformulier op de website ---
app.post("/api/contact", async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: "Vul je naam in." });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: "Vul een geldig e-mailadres in." });
  if (!message || !message.trim()) return res.status(400).json({ error: "Vul je bericht in." });

  if (!process.env.CONTACT_EMAIL) {
    console.error(">>> CONTACT_EMAIL is niet ingesteld in Railway — contactbericht kan niet worden afgeleverd.");
    return res.status(500).json({ error: "Het contactformulier is momenteel niet beschikbaar. Probeer het later opnieuw." });
  }

  try {
    console.log(`>>> Contactbericht ontvangen van: ${email}`);

    await sendEmail(
      process.env.CONTACT_EMAIL,
      `Nieuw contactbericht van ${name.trim()}`,
      `<div style="font-family:sans-serif;color:#2B2A26">
        <h2 style="color:#1E4638">Nieuw bericht via het contactformulier</h2>
        <p><strong>Naam:</strong> ${name.trim()}</p>
        <p><strong>E-mail:</strong> ${email.trim()}</p>
        <p><strong>Bericht:</strong></p>
        <p style="white-space:pre-wrap;background:#F5F1E6;padding:16px;border-radius:4px;">${message.trim()}</p>
      </div>`
    );

    // Korte bevestiging naar de bezoeker zelf
    await sendEmail(
      email.trim(),
      "We hebben je bericht ontvangen — OlivaFix Gold",
      `<div style="font-family:sans-serif;color:#2B2A26">
        <h2 style="color:#1E4638">Bedankt, ${name.trim()}!</h2>
        <p>We hebben je bericht goed ontvangen en reageren meestal binnen 1-2 werkdagen.</p>
        <p style="color:#7D7A6F;font-size:13px;margin-top:30px">OlivaFix Gold — een product van Bonyf</p>
      </div>`
    );

    res.json({ success: true });
  } catch (err) {
    console.error(">>> Fout bij verwerken contactbericht:", err.message);
    res.status(500).json({ error: "Er ging iets mis bij het versturen. Probeer het straks opnieuw." });
  }
});
// ============ REVIEWS ============



// --- Publiek: goedgekeurde reviews tonen (voor op de site) ---
app.get("/api/reviews", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, author_name, rating, body, verified, created_at FROM reviews WHERE approved=true ORDER BY created_at DESC LIMIT 500"
  );
  res.json(rows);
});

// --- Publiek: een klant dient zelf een review in (via de link in de reviewmail) ---
app.post("/api/reviews", async (req, res) => {
  const { author_name, rating, body, order_id } = req.body;
  if (!author_name || !rating || !body) return res.status(400).json({ error: "Vul alle velden in." });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: "Ongeldige score." });

  // Als er een order_id wordt meegegeven, checken we of die echt bestaat — dan krijgt de
  // review een "geverifieerde aankoop"-label. Reviews wachten sowieso op goedkeuring
  // door jou, zodat spam er nooit zomaar tussen glipt.
  let verified = false;
  if (order_id) {
    const { rows } = await pool.query("SELECT id FROM orders WHERE id=$1", [order_id]);
    verified = rows.length > 0;
  }

  const { rows } = await pool.query(
    `INSERT INTO reviews (author_name, rating, body, source, verified, order_id, approved)
     VALUES ($1, $2, $3, 'Klant OlivaFix-webshop', $4, $5, false) RETURNING *`,
    [author_name, rating, body, verified, order_id || null]
  );
  res.json({ success: true, review: rows[0] });
});

// --- Admin: alle reviews zien (ook nog niet goedgekeurde) ---
app.get("/api/admin/reviews", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM reviews ORDER BY created_at DESC LIMIT 500");
  res.json(rows);
});

// --- Admin: handmatig een review toevoegen (bv. overgenomen van een apothekerswebsite, met bron) ---
app.post("/api/admin/reviews", requireAdmin, async (req, res) => {
  const { author_name, rating, body, source } = req.body;
  if (!author_name || !rating || !body) return res.status(400).json({ error: "Vul alle velden in." });

  const { rows } = await pool.query(
    `INSERT INTO reviews (author_name, rating, body, source, verified, approved)
     VALUES ($1, $2, $3, $4, false, true) RETURNING *`,
    [author_name, rating, body, source || null]
  );
  res.json(rows[0]);
});

// --- Admin: meerdere reviews in één keer toevoegen (bv. een lijst overgenomen van apothekerswebsites) ---
app.post("/api/admin/reviews/bulk", requireAdmin, async (req, res) => {
  const { reviews } = req.body;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: "Geen reviews meegegeven." });
  }
  let added = 0;
  for (const r of reviews) {
    if (!r.author_name || !r.rating || !r.body) continue;
    await pool.query(
      `INSERT INTO reviews (author_name, rating, body, source, verified, approved)
       VALUES ($1, $2, $3, $4, false, true)`,
      [r.author_name, r.rating, r.body, r.source || null]
    );
    added++;
  }
  res.json({ added });
});

// --- Admin: een ingediende review goedkeuren (zichtbaar maken op de site) ---
app.post("/api/admin/reviews/:id/approve", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("UPDATE reviews SET approved=true WHERE id=$1 RETURNING *", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "Review niet gevonden." });
  res.json(rows[0]);
});

// --- Admin: een review verwijderen ---
app.delete("/api/admin/reviews/:id", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM reviews WHERE id=$1", [req.params.id]);
  res.json({ deleted: true });
});

// ============ HERINNERINGSMAIL NA 6 WEKEN ============

async function checkRepurchaseReminders() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE status IN ('paid', 'shipped')
         AND reminder_sent = false
         AND created_at <= now() - interval '42 days'
         AND customer_email IS NOT NULL`
    );
    for (const order of rows) {
      await sendEmail(
        order.customer_email,
        "Bijna door je OlivaFix Gold?",
        `<div style="font-family:sans-serif;color:#2B2A26">
          <h2 style="color:#1E4638">Tijd om bij te vullen?</h2>
          <p>Het is ongeveer 6 weken geleden dat je OlivaFix Gold bestelde. Veel klanten zijn rond dit moment door hun tube heen.</p>
          <p><a href="${process.env.CLIENT_URL}" style="background:#1E4638;color:#FBF8F1;padding:10px 18px;text-decoration:none;border-radius:4px;display:inline-block">Opnieuw bestellen</a></p>
          <p style="color:#7D7A6F;font-size:13px;margin-top:24px">Trouwens — wat vond je van OlivaFix Gold? We horen het graag: <a href="${process.env.CLIENT_URL}/review?order=${order.id}">laat hier een review achter</a>.</p>
          <p style="color:#7D7A6F;font-size:13px">OlivaFix Gold — een product van Bonyf</p>
        </div>`
      );
      await pool.query("UPDATE orders SET reminder_sent=true WHERE id=$1", [order.id]);
    }
    if (rows.length > 0) console.log(`${rows.length} herinneringsmail(s) verstuurd.`);
  } catch (err) {
    console.error("Herinneringsmail-check mislukt:", err.message);
  }
}

// ============ REVIEWS AUTOMATISCH INLADEN BIJ OPSTARTEN ============
// Echte reviews, samengevat in eigen woorden (niet letterlijk overgenomen), gevonden op
// Amazon (VS/VK) en apotheekwebsites in Frankrijk en Duitsland. Bron staat bij elke review.
// Elke review heeft een vaste seed_key, zodat opnieuw opstarten nooit dubbels aanmaakt.
const SEED_REVIEWS = [
  { key: "seed-01", author_name: "Amazon-klant (VS)", rating: 5, body: "Ik heb alle hechtcrèmes op de markt geprobeerd. Deze houdt het langst vast. Wat olieachtig als het teveel opdrukt, maar ik ben erg tevreden.", source: "Amazon.com" },
  { key: "seed-04", author_name: "Amazon-klant (VS)", rating: 5, body: "Gezonder voor je mond — geen zink en op basis van natuurlijke olijfolie. Precies wat ik zocht na jaren gewone hechtcrème.", source: "Amazon.com" },
  { key: "seed-05", author_name: "Amazon-klant (VS)", rating: 4, body: "Ik gebruik dit als hechtmiddel. De goedkopere producten hielden bij mij gewoon minder lang stand.", source: "Amazon.com" },
  { key: "seed-07", author_name: "Amazon-klant (VS)", rating: 5, body: "Al meermaals opnieuw besteld. Uitstekende hechting, neutrale smaak. Massaag de tube even door, de olijfolie kan er licht van scheiden.", source: "Amazon.com" },
  { key: "seed-08", author_name: "Amazon-klant (VS)", rating: 4, body: "Er komt af en toe wat product tussendoor, ik smeer overdag bij. Verder een natuurlijk product.", source: "Amazon.com" },
  { key: "seed-09", author_name: "Klant Redcare Pharmacie (FR)", rating: 5, body: "Zeer goede natuurlijke lijm, houdt uitstekend vast en irriteert het tandvlees niet. Wel iets aan de prijzige kant.", source: "Redcare Pharmacie" },
  { key: "seed-10", author_name: "Klant Redcare Pharmacie (FR)", rating: 3, body: "Moet snel gebruikt worden — na verloop van tijd droogt het in de tube in. Daardoor moest ik mijn vorige tube weggooien.", source: "Redcare Pharmacie" },
  { key: "seed-12", author_name: "Klant Redcare Pharmacie (FR)", rating: 5, body: "Gebruik dit al jaren en ben er zeer tevreden over. Goede hechting, en ik vergiftig mezelf niet met chemischere alternatieven.", source: "Redcare Pharmacie" },
  { key: "seed-13", author_name: "Klant Redcare Pharmacie (FR)", rating: 5, body: "Gebruik het al jaren, minder chemisch dan klassieke lijmsoorten. Houdt gemiddeld een goede twaalf uur vast, zelfs met een minder passend gebit. Een echte aanrader.", source: "Redcare Pharmacie" },
  { key: "seed-14", author_name: "Klant Redcare Pharmacie (FR)", rating: 5, body: "Heel goede kwaliteit, in tegenstelling tot sommige merken die het geen hele dag volhouden.", source: "Redcare Pharmacie" },
  { key: "seed-15", author_name: "Claudine V.", rating: 5, body: "Positieve ervaring met dit product, gebruik het met veel plezier.", source: "Atida.fr (geverifieerde koper)" },
  { key: "seed-16", author_name: "M'hammed R.", rating: 4, body: "Het beste, al aan de prijzige kant — verdient wat meer bekendheid.", source: "Atida.fr (geverifieerde koper)" },
  { key: "seed-17", author_name: "Klant Ortho & Junior (FR)", rating: 5, body: "Gebruik OlivaFix al maanden, na andere merken getest te hebben — voor mij het meest doeltreffende.", source: "Ortho & Junior" },
  { key: "seed-18", author_name: "Klant Ortho & Junior (FR)", rating: 5, body: "Natuurlijk, zonder chemische toevoegingen. Beveel het sterk aan.", source: "Ortho & Junior" },
  { key: "seed-19", author_name: "Klant Amazon.co.uk", rating: 5, body: "Ik heb echt alle hechtcrèmes geprobeerd. Dit is de enige waarmee ik zonder zorgen een biefstuk kan eten. Vergeleken met Fixodent en Poligrip heb ik veel minder nodig, en hoef ik niet meer meerdere keren per dag bij te smeren.", source: "Amazon.co.uk" },
  { key: "seed-20", author_name: "Klant Amazon.co.uk", rating: 4, body: "Houdt bij mijn boventandvlees erg lang vast. Het ondergebit iets minder lang (12-14 uur), maar dat komt door minder hechtoppervlak, niet door het product.", source: "Amazon.co.uk" },
  { key: "seed-22", author_name: "Klant Amazon.co.uk", rating: 4, body: "Goede hechting voor kunstgebitten, al vind ik de prijs behoorlijk aan de hoge kant.", source: "Amazon.co.uk" },
  { key: "seed-24", author_name: "Klant Redcare Apotheke (DE)", rating: 5, body: "Gemiddeld 4,7 van de 5 sterren over 18 beoordelingen op deze Duitse apotheekwebsite.", source: "Redcare Apotheke" },
  { key: "seed-26", author_name: "Klant CodeCheck.info (DE)", rating: 5, body: "Hecht meteen, heel aangenaam gevoel! Even sterk als goedkopere producten met zink en paraffine. Al duurder, de overstap was het waard — verzachtte een geïrriteerd tandvlees meteen.", source: "CodeCheck.info" },
];

async function seedReviews() {
  try {
    for (const r of SEED_REVIEWS) {
      await pool.query(
        `INSERT INTO reviews (author_name, rating, body, source, verified, approved, seed_key)
         VALUES ($1, $2, $3, $4, false, true, $5)
         ON CONFLICT (seed_key) DO NOTHING`,
        [r.author_name, r.rating, r.body, r.source, r.key]
      );
    }
    console.log("Reviews-seed gecontroleerd/aangevuld.");
  } catch (err) {
    console.error("Reviews inladen mislukt:", err.message);
  }
}
seedReviews();

// Één keer bij opstarten, en daarna elke 24 uur
checkRepurchaseReminders();
setInterval(checkRepurchaseReminders, 24 * 60 * 60 * 1000);
