# User guide

Three short chapters: the cashier at the till, the manager in the back office, and the owner. Each step is one you can try on a
practice sale. Amounts are in rupees with two decimals everywhere.

---

## 1. The cashier

### Starting the day
1. Sign in. Open **Point of sale** in the menu.
2. First time today: type the cash in the drawer under **Opening cash (Rs)** and press **Open shift**. One shift is open per register at a time.

### Making a sale
1. Click the search box (or press **F2**) and **scan** each item, or type part of its name or code and press Enter. Scanning the same item again adds one more.
   Type `5*code` to sell five at once.
2. Click a row to change its quantity, its unit (piece, pack, carton), give a discount on that line, or remove it. Each row shows how many are in stock.
3. **Customer (F8)** is a walk-in unless you choose one; a named customer buys at their own price list and can buy on account.
4. **Bill discount (F9)** takes a percentage or an amount off the whole bill. You may give discounts only up to your limit; above it a manager types their PIN.
5. Press **Pay (F4)**. Choose the way (cash, card, bank, wallet), type what the customer gave, and press the green button. For cash, the screen shows the change. To split,
   press **+ Add another payment**. A named customer can leave the rest **on account**.
6. **Sale complete** shows the total and change and prints the slip by itself. Press **New sale**.

### When something changes mid-sale
- **Hold (F6)** puts the sale aside; **Held (F7)** brings it back. Use it when a customer goes to fetch something.
- **Cancel sale** (before paying) asks why and keeps a record. Taking a single line off needs no reason.
- If the screen says the total changed, a price was updated while you were selling; check the cart and press Pay again.

### Returns and payments
- **Return**: find the sale by its number or the customer, choose the items and how many, say why, and choose the refund (cash, or onto the customer's account). Items
  go back on the shelf, to the damaged goods, or are written off. You cannot return more than was sold.
- **Customer payment**: takes money against a customer's account and prints a receipt.
- **Cash in/out**: money put into or taken from the drawer, with a reason.
- **Recent sales**: finds an old sale and prints a copy marked **DUPLICATE**.

### If the internet goes
The top of the till says **No connection. You can keep selling.** Carry on as usual: each sale is saved on this till and the slip says **OFFLINE SALE, TO BE SYNCED**
with a number like `REGISTER1-OFF-000004`. Give the customer that slip. When the connection returns the sales are sent by themselves, in order, and the banner says so.
What you cannot do without a connection: sell on account, give a discount above your limit, take a return, or close the shift.
**Do not sign out of that till until the banner is clear.**

### FBR
When FBR is on, the finished sale shows **FBR invoice no.** and the slip prints it with a QR code. If FBR could not be reached, the screen says so. The sale is safe and is
sent later; print the bill again afterwards to get the number on it.

### Ending the day
**Close shift**: count the drawer and type the total (you will not see what it should be until you do), press close, and print the **Z report**. It shows what was expected,
what you counted and the difference.

---

## 2. The manager

### Stock
- **Stock**: what is on hand, reserved and available, and what is in transit. Click **Movements** to see every change of an item.
- **Adjustments**: damage, loss, found, correction. Large ones wait for approval from someone with that right.
- **Transfers**: choose where from and where to and what; **Send** takes it out of the source, **Receive** puts it into the destination. If less arrived, type what really came.
  Goods moved into a *damaged goods* location are kept apart and are not sold.
- **Counts**: start a full or partial count, scan the shelf (or type), press **Finished counting**. The review shows what the books said, what was counted and the difference.
  **Approve** corrects the stock; **Send back for a recount** asks for the differences to be counted again. Items nobody counted are left alone.

### Buying
Purchase orders, goods received, supplier bills (freight and tax are added to the cost), purchase returns, and payments. **Reorder list** turns low stock into purchase orders.

### Selling in the office
Quotations, sales orders (they reserve stock), delivery challans (stock leaves when dispatched), and invoices on credit. Each can be printed or shared by WhatsApp.

### Customers and suppliers
Each has a ledger (khata) with a running balance, statements, and ageing. **Import customers** and **Import suppliers** load a spreadsheet saved as CSV; the screen checks every row first and
loads nothing until all are fine.

### Reports and the dashboard
The home page shows today's sales, cash, who owes what, low stock, and the FBR and offline cards. **Reports** has about thirty-six reports with filters and CSV export.
Profit appears only for people allowed to see it.

### Looking after FBR and offline sales
- **FBR log**: filter **Needs attention**. A refused invoice shows FBR's reason; fix the product or customer and press **Send to FBR again**.
- **Offline sales to review**: sales taken without a connection that went below zero stock, changed price, or had a discount nobody approved. Read each, write a note, **Mark as reviewed**.
- **Day-end closing**: once every shift is closed, close the day. It writes down the figures and stops later entries for that day.

---

## 3. The owner

- **Users** and **Roles**: add people, give each a role (what they may see and do), reset a password, deactivate someone who left (their history stays).
- **Settings**: date format, session length, how rounding works, whether stock may go below zero, whether the till prints by itself.
- **FBR settings**: switch FBR on, enter the token (it is stored encrypted and cannot be shown again), choose sandbox or production, map tax categories and payment methods, run the sandbox scenarios.
  Do the steps in `docs/go-live.md` before choosing production.
- **Export your data** (bottom of Settings): everything as one file, or any table as CSV. Passwords, PINs and the FBR token are never in it.
- **Audit history**: who changed, voided, reprinted or downloaded what, and when.

### Forgot a password
On the sign-in page choose **Forgot password**; an email arrives. The owner can also set a new one from Users.
