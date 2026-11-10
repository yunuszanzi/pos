import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { closeDb } from "../server/lib/db";

// A demo business for trying the app by hand: an owner, a manager and a cashier, a few products and some stock.
// The passwords are published in this file, so it only ever runs against a local Supabase.

const url = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  throw new Error(`Refusing to create demo accounts with known passwords on ${url || "an unknown Supabase"}. This is for local development only.`);
}

const { app } = await import("../server/app");

export const demoPassword = "demo-password-123";
export const demoLogins = [
  { role: "Owner", email: "owner@demo.test" },
  { role: "Manager", email: "manager@demo.test" },
  { role: "Cashier", email: "cashier@demo.test" },
] as const;
const staffPin = "1234";

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const anon = createClient(url, process.env.SUPABASE_ANON_KEY!, options);

async function call(token: string, method: string, path: string, body?: unknown, idempotent = false) {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  if (idempotent) headers.set("Idempotency-Key", `demo-${randomUUID()}`);
  const response = await app.fetch(new Request(`http://localhost/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return data;
}

async function signIn(email: string): Promise<string | null> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: demoPassword });
  return error || !data.session ? null : data.session.access_token;
}

try {
  let ownerToken = await signIn("owner@demo.test");
  const existing = ownerToken ? await call(ownerToken, "GET", "/me") : null;

  if (existing?.businessId) {
    console.log("The demo business already exists.");
  } else {
    if (!ownerToken) {
      const { error } = await admin.auth.admin.createUser({ email: "owner@demo.test", password: demoPassword, email_confirm: true });
      if (error) throw error;
      ownerToken = await signIn("owner@demo.test");
    }
    await call(ownerToken!, "POST", "/org/setup", {
      legalName: "Demo Traders (Pvt) Ltd", tradeName: "Demo Traders", phone: "0300 0000000", address: "Shop 1, Saddar, Karachi", province: "Sindh",
      receiptFooter: "Thank you for shopping with us", branchName: "Main Branch", branchCode: "KHI", locationName: "Main Store",
      terminalName: "Register 1", documentPrefix: "INV-KHI", ownerPin: staffPin,
    });

    const roles: Array<{ id: string; name: string }> = await call(ownerToken!, "GET", "/roles");
    const branch = (await call(ownerToken!, "GET", "/branches"))[0];
    for (const { role, email } of demoLogins.filter((login) => login.role !== "Owner")) {
      const created = await call(ownerToken!, "POST", "/users", {
        email, displayName: `Demo ${role}`, roleId: roles.find((candidate) => candidate.name === role)!.id, branchIds: [branch.id], pin: staffPin,
      });
      const { error } = await admin.auth.admin.updateUserById(created.id, { password: demoPassword, email_confirm: true });
      if (error) throw error;
    }

    const products = [
      "sku,name,variant_name,category,brand,tax_category,hs_code,base_unit,sale_price,cost,barcode,reorder_level,alt_unit,alt_factor,alt_barcode,alt_price",
      "BAL-12-RED,Latex Balloon 12 inch,Red,Balloons > Latex,Party Co,Standard rate 18%,9503.0090,Piece,5.00,3.20,8964000000017,500,Carton,1000,8964000000024,4500.00",
      "BAL-12-BLU,Latex Balloon 12 inch,Blue,Balloons > Latex,Party Co,Standard rate 18%,9503.0090,Piece,5.00,3.20,8964000000031,500,Carton,1000,8964000000048,4500.00",
      "BAL-FOIL-STAR,Foil Star Balloon,Gold,Balloons > Foil,Party Co,Standard rate 18%,9503.0090,Piece,120.00,75.00,8964000000055,50,,,,",
      "PUMP-HAND,Hand Pump,,Accessories,,Standard rate 18%,8414.2000,Piece,350.00,220.00,8964000000062,10,,,,",
      "RIBBON-RED,Curling Ribbon,Red,Accessories,,Exempt,,Piece,60.00,35.00,8964000000079,20,,,,",
    ].join("\n");
    await call(ownerToken!, "POST", "/products/import", { csv: products }, true);
    const stock = [
      "sku,quantity,unit,cost",
      "BAL-12-RED,10,Carton,3200.00",
      "BAL-12-BLU,5,Carton,3200.00",
      "BAL-FOIL-STAR,40,Piece,75.00",
      "PUMP-HAND,25,Piece,220.00",
      "RIBBON-RED,60,Piece,35.00",
    ].join("\n");
    await call(ownerToken!, "POST", "/stock/opening", { csv: stock }, true);
    console.log("Created the demo business.");
  }

  console.log("\nSign in at the app with:");
  for (const { role, email } of demoLogins) console.log(`  ${role.padEnd(8)} ${email}   password: ${demoPassword}`);
  console.log(`\nTerminal PIN for all three (for "Switch user"): ${staffPin}`);
} finally {
  await closeDb();
}
